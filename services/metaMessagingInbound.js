const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');

const db = require('../models');
const { broadcast } = require('../utils/sseManager');
const { getCommsConfig, recordWebhookSeen } = require('../utils/commsConfig');
const metaApi = require('./metaMessagingApi');

const { MessagingChannel, Conversation, ConversationMessage } = db;

// ---------------------------------------------------------------------------
// Inbound Facebook Messenger + Instagram — the Messenger-platform sibling of
// services/whatsappInbound.js. Both arrive on the SAME signed webhook but with
// a different payload shape: entry[].messaging[] (a PSID/IGSID sender), not
// entry[].changes[].value like WhatsApp. routes/commsWebhook branches on
// body.object and calls this for 'page' (messenger) and 'instagram'.
//
// Contract (same guarantees as the WhatsApp path):
//   • Idempotent — keyed by the message mid (UNIQUE), so re-deliveries no-op.
//   • Never throws into the caller — each event in its own try/catch.
//   • Media lands under private/comms/, served only via the authenticated route.
//
// Difference from WhatsApp: the sender id is a page-scoped PSID / Instagram
// IGSID, NOT a phone number, so there is no phone auto-link. A Messenger/IG
// thread starts unlinked (contactType 'patient', patientId null) and a human
// links it to a patient from the Inbox.
// The sender's NAME is looked up once from Meta (fillProfileName) so the
// thread is recognisable; it is a label only, never used to auto-link.
// ---------------------------------------------------------------------------

const STAGING_ROOT = path.join(__dirname, '..', 'private', 'comms');
const WINDOW_MS = 24 * 60 * 60 * 1000;
const STATUS_RANK = { received: 0, queued: 1, sent: 2, delivered: 3, read: 4, failed: 5 };

const ensureDir = (dir) => { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); };

const EXT_BY_MIME = {
  'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'image/gif': 'gif', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'video/mp4': 'mp4',
};
const extForMime = (mime = '') => EXT_BY_MIME[mime.split(';')[0].trim()] || 'bin';

// Messenger attachment.type → our message type + a sensible fallback mime.
const TYPE_MAP = {
  image: { type: 'image', mime: 'image/jpeg' },
  audio: { type: 'audio', mime: 'audio/mpeg' },
  video: { type: 'video', mime: 'video/mp4' },
  file:  { type: 'document', mime: 'application/octet-stream' },
};

const previewFor = (type, body, caption) => {
  const text = body || caption || (type ? `[${type}]` : '');
  return String(text).replace(/\s+/g, ' ').trim().slice(0, 160);
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

// --- channel + conversation -------------------------------------------------

const findChannel = (externalId, channelType) =>
  MessagingChannel.findOne({ where: { externalId: String(externalId), channel: channelType } });

const findOrCreateConversation = async (channel, userId) => {
  let conv = await Conversation.findOne({ where: { channelId: channel.id, externalUserId: String(userId) } });
  if (conv) return conv;
  // No phone → no org/lab typing and no auto-link; always a patient thread a
  // human links from the Inbox.
  return Conversation.create({
    channelId: channel.id,
    externalUserId: String(userId),
    profileName: null,
    contactType: 'patient',
    status: 'open',
  });
};

// Name an unnamed thread from Meta (see metaApi.fetchProfileName). Runs AFTER
// the message row is saved, so a slow or failed lookup can never cost a
// message. A thread whose lookup failed stays null and is retried on the
// person's next message — one Graph call per inbound message for unnamed
// threads only, negligible at clinic volume. Never overwrites a name.
const fillProfileName = async (conv, channelType) => {
  if (conv.profileName) return;
  const name = await metaApi.fetchProfileName(conv.externalUserId, channelType);
  if (name) await conv.update({ profileName: name });
};

// --- media ------------------------------------------------------------------

const downloadAttachment = async (conv, url, cfg) => {
  const res = await metaApi.fetchAttachment(url);
  const mime = (res.headers && res.headers.get && res.headers.get('content-type')) || 'application/octet-stream';
  const dir = path.join(STAGING_ROOT, String(conv.id));
  ensureDir(dir);
  const ext = extForMime(mime);
  const dest = path.join(dir, `${crypto.randomBytes(16).toString('hex')}.${ext}`);
  const maxBytes = (cfg.mediaMaxMb || 25) * 1024 * 1024;
  const bytes = await streamToFile(res.body, dest, maxBytes);
  return { path: dest, size: bytes, mime };
};

// --- one inbound event ------------------------------------------------------

const handleMessageEvent = async (channel, channelType, event, cfg) => {
  const msg = event.message;
  if (msg.is_echo) return;                       // our own outbound, echoed back
  const externalMessageId = msg.mid;
  if (!externalMessageId) return;
  const existing = await ConversationMessage.findOne({ where: { externalMessageId }, attributes: ['id'] });
  if (existing) return;                          // idempotent

  const userId = event.sender && event.sender.id;
  if (!userId) return;
  const conv = await findOrCreateConversation(channel, userId);

  // Parse body + first attachment (mirror WhatsApp's one-media-per-row shape).
  let body = msg.text || null;
  let type = body ? 'text' : 'unsupported';
  let attachmentUrl = null;
  const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
  if (attachments.length) {
    const a = attachments[0];
    const mapped = TYPE_MAP[a.type] || { type: 'file', mime: 'application/octet-stream' };
    type = mapped.type;
    attachmentUrl = a.payload && a.payload.url;
    if (!body) body = `[${a.type || 'attachment'}]${attachments.length > 1 ? ` +${attachments.length - 1} more` : ''}`;
  }

  const message = await ConversationMessage.create({
    conversationId: conv.id,
    channel: channelType,
    patientId: conv.patientId || null,           // snapshot
    direction: 'in',
    externalMessageId,
    type,
    body,
    status: 'received',
    statusAt: new Date(),
    externalTimestamp: event.timestamp ? new Date(Number(event.timestamp)) : new Date(),
    queryStatus: 'open',
  });

  // Media download (isolated — a failed download must not lose the row).
  if (attachmentUrl) {
    try {
      const media = await downloadAttachment(conv, attachmentUrl, cfg);
      await message.update({
        mediaPath: media.path, mediaSize: media.size, mediaMime: media.mime,
        mediaFileName: `attachment.${extForMime(media.mime)}`,
      });
    } catch (e) {
      console.error('[Comms] messenger media download failed (non-fatal):', e.message);
      await message.update({ body: `${body ? `${body}\n` : ''}[attachment could not be downloaded]` });
    }
  }

  const now = new Date();
  await conv.update({
    unreadCount: (conv.unreadCount || 0) + 1,
    openQueryCount: (conv.openQueryCount || 0) + 1,
    lastInboundAt: now,
    windowExpiresAt: new Date(now.getTime() + WINDOW_MS),
    lastMessageAt: now,
    lastMessagePreview: previewFor(type, body),
    status: (conv.status === 'archived' || conv.status === 'closed') ? 'open' : conv.status,
  });
  await MessagingChannel.update({ lastInboundAt: now }, { where: { id: channel.id } });
  await fillProfileName(conv, channelType);
  broadcast('comms_new', { at: now.toISOString(), channel: channelType });   // no PHI
};

// A postback (button tap / persistent-menu / get-started) reads as a short
// inbound message so the thread shows what the person chose.
const handlePostbackEvent = async (channel, channelType, event) => {
  const pb = event.postback || {};
  const externalMessageId = pb.mid || `pb-${crypto.randomUUID()}`;
  const existing = await ConversationMessage.findOne({ where: { externalMessageId }, attributes: ['id'] });
  if (existing) return;
  const userId = event.sender && event.sender.id;
  if (!userId) return;
  const conv = await findOrCreateConversation(channel, userId);
  const now = new Date();
  await ConversationMessage.create({
    conversationId: conv.id, channel: channelType, patientId: conv.patientId || null,
    direction: 'in', externalMessageId, type: 'button',
    body: pb.title || pb.payload || 'Button tap',
    status: 'received', statusAt: now,
    externalTimestamp: event.timestamp ? new Date(Number(event.timestamp)) : now,
    queryStatus: 'open',
  });
  await conv.update({
    unreadCount: (conv.unreadCount || 0) + 1, openQueryCount: (conv.openQueryCount || 0) + 1,
    lastInboundAt: now, windowExpiresAt: new Date(now.getTime() + WINDOW_MS),
    lastMessageAt: now, lastMessagePreview: previewFor('button', pb.title || pb.payload),
    status: (conv.status === 'archived' || conv.status === 'closed') ? 'open' : conv.status,
  });
  await fillProfileName(conv, channelType);
  broadcast('comms_new', { at: now.toISOString(), channel: channelType });
};

// Delivery/read receipts (best-effort, forward-only). Messenger reports
// delivery by message ids and read by a watermark timestamp.
const handleDelivery = async (event) => {
  const mids = (event.delivery && event.delivery.mids) || [];
  for (const mid of mids) {
    const m = await ConversationMessage.findOne({ where: { externalMessageId: mid } });
    if (m && STATUS_RANK.delivered > STATUS_RANK[m.status]) await m.update({ status: 'delivered', statusAt: new Date() });
  }
};

const handleRead = async (channel, event) => {
  const watermark = event.read && event.read.watermark;
  if (!watermark) return;
  const conv = await Conversation.findOne({ where: { channelId: channel.id, externalUserId: String(event.sender && event.sender.id) } });
  if (!conv) return;
  const { Op } = require('sequelize');
  await ConversationMessage.update(
    { status: 'read', statusAt: new Date() },
    { where: { conversationId: conv.id, direction: 'out', externalTimestamp: { [Op.lte]: new Date(Number(watermark)) }, status: { [Op.in]: ['sent', 'delivered'] } } }
  );
};

// --- entry point ------------------------------------------------------------

const processWebhook = async (body, channelType) => {
  if (!body || !Array.isArray(body.entry)) return;
  let cfg;
  try { cfg = await getCommsConfig(); } catch { cfg = { mediaMaxMb: 25 }; }

  for (const entry of body.entry) {
    const events = Array.isArray(entry.messaging) ? entry.messaging : [];
    for (const event of events) {
      try {
        // Route to the clinic channel by the recipient (Page / IG id).
        const externalId = (event.recipient && event.recipient.id) || entry.id;
        const channel = externalId ? await findChannel(externalId, channelType) : null;
        if (!channel) {
          console.error(`[Comms] ${channelType} webhook for unknown ${channelType} id`, externalId, '- skipped');
          continue;
        }
        if (event.message) await handleMessageEvent(channel, channelType, event, cfg);
        else if (event.postback) await handlePostbackEvent(channel, channelType, event);
        else if (event.delivery) await handleDelivery(event);
        else if (event.read) await handleRead(channel, event);
      } catch (e) {
        console.error(`[Comms] ${channelType} event failed:`, e.message);
      }
    }
  }
  await recordWebhookSeen().catch(() => {});
};

module.exports = { processWebhook, previewFor, findOrCreateConversation, fillProfileName, STAGING_ROOT };
