const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');

const db = require('../models');
const { broadcast } = require('../utils/sseManager');
const { getCommsConfig, recordWebhookSeen } = require('../utils/commsConfig');
const { findPatientsByPhone, normalisePhone, display } = require('../utils/phone');
const whatsappApi = require('./whatsappApi');
const pdfUnlock = require('../utils/pdfUnlock');
const { suggestForReport } = require('../utils/labReportMatch');
const { formatFileSize } = require('../utils/medicalDocumentCreate');

const {
  MessagingChannel, Conversation, ConversationMessage,
  ExternalOrganisation, ExternalOrganisationContact, LabInboxItem,
} = db;

// ---------------------------------------------------------------------------
// Inbound WhatsApp — turn a verified webhook payload into conversation rows.
//
// Contract (called from routes/commsWebhook after the signature check, in a
// setImmediate so the HTTP 200 is already sent):
//   • Idempotent — a message is keyed by its Meta id (UNIQUE), so Meta's
//     re-deliveries are no-ops.
//   • Never throws into the caller — every message is handled in its own
//     try/catch; one bad message never drops the rest of the batch.
//   • Merge-aware auto-link — links a thread to a patient ONLY on a single
//     unique phone match; shared numbers surface candidates for a human.
//   • Lab routing — a message from a known lab/organisation WhatsApp number is
//     typed as such and, if it carries a PDF, mirrored into the Lab Inbox so
//     the Lab reports tab stays the one queue for external results.
//   • Media lands under private/comms/ (A5 — never uploads/), served only
//     through the authenticated /messages/:id/media route.
// ---------------------------------------------------------------------------

const STAGING_ROOT = path.join(__dirname, '..', 'private', 'comms');
const WINDOW_MS = 24 * 60 * 60 * 1000;

const ensureDir = (dir) => { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); };

const extForMime = (mime = '') => {
  const map = {
    'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
    'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'video/mp4': 'mp4', 'image/gif': 'gif',
  };
  return map[mime.split(';')[0].trim()] || 'bin';
};

const streamToFile = (webStream, dest, maxBytes) => new Promise((resolve, reject) => {
  const node = Readable.fromWeb(webStream);
  const out = fs.createWriteStream(dest);
  let bytes = 0;
  node.on('data', (c) => { bytes += c.length; if (bytes > maxBytes) node.destroy(new Error('media exceeds the size cap')); });
  node.on('error', (e) => { out.destroy(); reject(e); });
  out.on('error', reject);
  out.on('finish', () => resolve(bytes));
  node.pipe(out);
});

// Forward-only status so an out-of-order webhook can't regress read→delivered.
const STATUS_RANK = { received: 0, queued: 1, sent: 2, delivered: 3, read: 4, failed: 5 };

// A readable one-line body for message types that have no text of their own.
const summariseNonText = (msg) => {
  switch (msg.type) {
    case 'location': {
      const l = msg.location || {};
      return `📍 Location${l.name ? `: ${l.name}` : ''}${l.latitude ? ` (${l.latitude}, ${l.longitude})` : ''}`;
    }
    case 'contacts': {
      const names = (msg.contacts || []).map((c) => (c.name && c.name.formatted_name) || '').filter(Boolean);
      return `👤 Contact${names.length ? `: ${names.join(', ')}` : ''}`;
    }
    case 'reaction':
      return `${(msg.reaction && msg.reaction.emoji) || '👍'} Reacted`;
    case 'button':
      return (msg.button && msg.button.text) || 'Button reply';
    case 'interactive': {
      const i = msg.interactive || {};
      return (i.button_reply && i.button_reply.title) || (i.list_reply && i.list_reply.title) || 'Interactive reply';
    }
    default:
      return `[${msg.type || 'unsupported'} message]`;
  }
};

const previewFor = (type, body, caption) => {
  const text = body || caption || (type ? `[${type}]` : '');
  return String(text).replace(/\s+/g, ' ').trim().slice(0, 160);
};

// --- channel + conversation -------------------------------------------------

const findChannel = (phoneNumberId) =>
  MessagingChannel.findOne({ where: { externalId: String(phoneNumberId) } });

// A WhatsApp number that belongs to a known lab/organisation → that org.
const orgForWaId = async (waId) => {
  const last9 = normalisePhone(waId);
  const candidates = [waId, `254${last9}`, last9].filter(Boolean);
  const contact = await ExternalOrganisationContact.findOne({
    where: { kind: 'whatsapp', value: candidates },
    include: [{ model: ExternalOrganisation, as: 'organisation' }],
  });
  return contact ? contact.organisation : null;
};

const findOrCreateConversation = async (channel, waId, profileName) => {
  let conv = await Conversation.findOne({ where: { channelId: channel.id, externalUserId: waId } });
  if (conv) {
    if (profileName && conv.profileName !== profileName) await conv.update({ profileName });
    return conv;
  }
  // First contact — if this number is a known lab/organisation, type it now.
  const org = await orgForWaId(waId);
  conv = await Conversation.create({
    channelId: channel.id,
    externalUserId: waId,
    profileName: profileName || null,
    contactType: org ? (org.type === 'lab' ? 'lab' : 'organisation') : 'patient',
    contactOrgId: org ? org.id : null,
    status: 'open',
  });
  return conv;
};

// --- media ------------------------------------------------------------------

const downloadMedia = async (conv, mediaMeta, cfg) => {
  const url = await whatsappApi.getMediaUrl(mediaMeta.id);
  const res = await whatsappApi.fetchMedia(url);
  const dir = path.join(STAGING_ROOT, String(conv.id));
  ensureDir(dir);
  const ext = extForMime(mediaMeta.mime_type);
  const dest = path.join(dir, `${crypto.randomBytes(16).toString('hex')}.${ext}`);
  const maxBytes = (cfg.mediaMaxMb || 25) * 1024 * 1024;
  const bytes = await streamToFile(res.body, dest, maxBytes);
  let encrypted = false;
  if ((mediaMeta.mime_type || '').includes('pdf')) {
    try { encrypted = await pdfUnlock.isEncrypted(fs.readFileSync(dest)); } catch { encrypted = false; }
  }
  return { path: dest, size: bytes, mime: mediaMeta.mime_type, filename: mediaMeta.filename || `file.${ext}`, encrypted };
};

// --- lab mirror -------------------------------------------------------------

// A lab/organisation sent a PDF over WhatsApp → mirror it into the Lab Inbox so
// the Lab reports tab is the single queue for external results. Advisory
// suggestion, exactly like the emailed path (a human still pairs it).
const mirrorLabReport = async ({ conv, message, org, caption }) => {
  try {
    if (!message.mediaPath) return;
    const item = await LabInboxItem.create({
      source: 'whatsapp',
      sourceMessageId: message.id,
      mailbox: null,
      messageId: message.externalMessageId,     // wa message id — unique, drives dedup
      attachmentIndex: 0,
      senderName: (org && org.name) || conv.profileName || display(conv.externalUserId),
      subject: (caption || '').slice(0, 255),
      emailDate: new Date(),
      fileName: message.mediaFileName || 'report.pdf',
      filePath: message.mediaPath,
      fileSize: formatFileSize(message.mediaSize),
      mimeType: message.mediaMime || 'application/pdf',
      status: 'New',
    });
    await item.update({ fileUrl: `/api/lab-inbox/${item.id}/file` });
    try {
      const s = await suggestForReport({ filePath: message.mediaPath, subject: caption, senderName: (org && org.name) || '' });
      await item.update(s);
    } catch (se) {
      console.error('[Comms] lab-mirror suggestion failed (non-fatal):', se.message);
    }
    const pending = await LabInboxItem.count({ where: { status: 'New' } }).catch(() => 0);
    broadcast('lab_inbox_new', { imported: 1, pending, trigger: 'whatsapp', at: new Date().toISOString() });
  } catch (e) {
    console.error('[Comms] lab mirror failed (non-fatal):', e.message);
  }
};

// --- patient auto-link ------------------------------------------------------

const autoLinkPatient = async (conv, cfg) => {
  if (conv.contactType !== 'patient' || conv.patientId || !cfg.autoLink) return;
  const matches = await findPatientsByPhone(conv.externalUserId);
  if (matches.length === 1) {
    await conv.update({
      patientId: matches[0].id, linkMethod: 'auto', linkedById: null, linkedAt: new Date(),
      suggestedPatientIds: null,
    });
  } else if (matches.length > 1) {
    await conv.update({ suggestedPatientIds: matches.map((p) => p.id) });
  }
};

// --- one inbound message ----------------------------------------------------

const handleInboundMessage = async (channel, msg, contactsByWaId, cfg) => {
  const waId = msg.from;
  const externalMessageId = msg.id;
  // Idempotency — Meta re-delivers. A message we already have is a no-op.
  const existing = await ConversationMessage.findOne({ where: { externalMessageId }, attributes: ['id'] });
  if (existing) return;

  const profileName = contactsByWaId[waId] || null;
  const conv = await findOrCreateConversation(channel, waId, profileName);

  // Parse the payload into body / caption / media meta.
  let type = msg.type || 'unsupported';
  let body = null;
  let caption = null;
  let mediaMeta = null;
  if (type === 'text') {
    body = msg.text && msg.text.body;
  } else if (['image', 'document', 'audio', 'video', 'sticker'].includes(type)) {
    const m = msg[type] || {};
    mediaMeta = { id: m.id, mime_type: m.mime_type, filename: m.filename };
    caption = m.caption || null;
  } else {
    body = summariseNonText(msg);
  }

  const message = await ConversationMessage.create({
    conversationId: conv.id,
    channel: 'whatsapp',
    patientId: conv.patientId || null,        // snapshot at write time
    direction: 'in',
    externalMessageId,
    type,
    body,
    caption,
    mediaId: mediaMeta ? mediaMeta.id : null,
    mediaMime: mediaMeta ? mediaMeta.mime_type : null,
    replyToExternalId: (msg.context && msg.context.id) || null,
    status: 'received',
    statusAt: new Date(),
    externalTimestamp: msg.timestamp ? new Date(Number(msg.timestamp) * 1000) : new Date(),
    queryStatus: 'open',
  });

  // Media download (isolated — a failed download must not lose the message row).
  if (mediaMeta && mediaMeta.id) {
    try {
      const media = await downloadMedia(conv, mediaMeta, cfg);
      await message.update({
        mediaPath: media.path, mediaSize: media.size, mediaMime: media.mime,
        mediaFileName: media.filename, mediaEncrypted: media.encrypted,
      });
      message.mediaPath = media.path; message.mediaSize = media.size;
      message.mediaMime = media.mime; message.mediaFileName = media.filename;
    } catch (e) {
      console.error('[Comms] media download failed (non-fatal):', e.message);
      await message.update({ body: (body ? `${body}\n` : '') + '[attachment could not be downloaded]' });
    }
  }

  // Lab routing: a lab/organisation PDF mirrors into the Lab Inbox.
  if ((conv.contactType === 'lab' || conv.contactType === 'organisation') && message.mediaPath
      && (message.mediaMime || '').includes('pdf')) {
    const org = conv.contactOrgId ? await ExternalOrganisation.findByPk(conv.contactOrgId) : null;
    await mirrorLabReport({ conv, message, org, caption });
  }

  // Patient auto-link (only for patient threads still unlinked).
  await autoLinkPatient(conv, cfg);
  // If the link was just made, stamp this message's snapshot too.
  if (conv.patientId && !message.patientId) await message.update({ patientId: conv.patientId });

  // Conversation counters + window + preview.
  const now = new Date();
  await conv.update({
    unreadCount: (conv.unreadCount || 0) + 1,
    openQueryCount: (conv.openQueryCount || 0) + 1,
    lastInboundAt: now,
    windowExpiresAt: new Date(now.getTime() + WINDOW_MS),
    lastMessageAt: now,
    lastMessagePreview: previewFor(type, body, caption),
    status: conv.status === 'archived' || conv.status === 'closed' ? 'open' : conv.status,
  });
  await MessagingChannel.update({ lastInboundAt: now }, { where: { id: channel.id } });

  broadcast('comms_new', { at: now.toISOString(), channel: 'whatsapp' });   // no PHI
};

// --- delivery status --------------------------------------------------------

const handleStatus = async (st) => {
  const message = await ConversationMessage.findOne({ where: { externalMessageId: st.id } });
  if (!message) return;   // a status for a message we don't track (e.g. an echo)
  const next = st.status;
  if (!(next in STATUS_RANK)) return;
  const patch = { statusAt: st.timestamp ? new Date(Number(st.timestamp) * 1000) : new Date() };
  // Move status forward only; 'failed' always applies.
  if (next === 'failed' || STATUS_RANK[next] > STATUS_RANK[message.status]) patch.status = next;
  if (Array.isArray(st.errors) && st.errors[0]) {
    patch.errorCode = String(st.errors[0].code || '');
    patch.errorMessage = (st.errors[0].title || st.errors[0].message || '').slice(0, 255);
  }
  if (st.pricing) {
    patch.billable = st.pricing.billable != null ? !!st.pricing.billable : message.billable;
    patch.pricingCategory = st.pricing.category || (st.conversation && st.conversation.origin && st.conversation.origin.type) || message.pricingCategory;
  }
  await message.update(patch);
};

// --- template status --------------------------------------------------------

const handleTemplateStatus = async (value) => {
  try {
    const name = value.message_template_name;
    const language = value.message_template_language || 'en';
    const status = value.event || value.new_status || value.status;
    if (!name) return;
    const { MessageTemplate } = db;
    const [tpl] = await MessageTemplate.findOrCreate({
      where: { name, language },
      defaults: { name, language, channelKey: 'whatsapp', status, metaId: value.message_template_id || null, syncedAt: new Date() },
    });
    if (status && tpl.status !== status) await tpl.update({ status, syncedAt: new Date() });
  } catch (e) {
    console.error('[Comms] template status update failed (non-fatal):', e.message);
  }
};

// --- entry point ------------------------------------------------------------

const processWebhook = async (body) => {
  if (!body || !Array.isArray(body.entry)) return;
  let cfg;
  try { cfg = await getCommsConfig(); } catch { cfg = { autoLink: true, mediaMaxMb: 25 }; }

  for (const entry of body.entry) {
    for (const change of entry.changes || []) {
      try {
        if (change.field === 'messages') {
          const value = change.value || {};
          const phoneNumberId = value.metadata && value.metadata.phone_number_id;
          const channel = phoneNumberId ? await findChannel(phoneNumberId) : null;
          if (!channel) {
            console.error('[Comms] webhook for unknown phone_number_id', phoneNumberId, '- skipped');
            continue;
          }
          const contactsByWaId = Object.fromEntries(
            (value.contacts || []).map((c) => [c.wa_id, c.profile && c.profile.name]).filter(([k]) => k)
          );
          for (const msg of value.messages || []) {
            try { await handleInboundMessage(channel, msg, contactsByWaId, cfg); }
            catch (e) { console.error('[Comms] inbound message failed:', e.message); }
          }
          for (const st of value.statuses || []) {
            try { await handleStatus(st); }
            catch (e) { console.error('[Comms] status update failed:', e.message); }
          }
        } else if (change.field === 'message_template_status_update') {
          await handleTemplateStatus(change.value || {});
        }
      } catch (e) {
        console.error('[Comms] webhook change failed:', e.message);
      }
    }
  }
  await recordWebhookSeen().catch(() => {});
};

module.exports = {
  processWebhook,
  // exported for tests
  summariseNonText, previewFor, STATUS_RANK, findOrCreateConversation, STAGING_ROOT,
};
