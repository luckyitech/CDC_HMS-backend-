const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Op } = require('sequelize');

const { success, error } = require('../utils/response');
const { resolvePatient } = require('../utils/patientFamily');
const { parseJsonColumn } = require('../utils/jsonColumn');
const { toWaId, display, findPatientsByPhone } = require('../utils/phone');
const { getCommsConfig } = require('../utils/commsConfig');
const { createMedicalDocument } = require('../utils/medicalDocumentCreate');
const pdfUnlock = require('../utils/pdfUnlock');
const whatsappApi = require('../services/whatsappApi');
const commsAnalytics = require('../services/commsAnalytics');
const appointmentController = require('./appointmentController');
const db = require('../models');

const {
  MessagingChannel, Conversation, ConversationMessage, ConversationEscalation,
  ConversationReminder, MessageTemplate, ExternalOrganisation, ExternalOrganisationContact,
  LabInboxItem, Patient, User, sequelize,
} = db;

// ---------------------------------------------------------------------------
// Communications Inbox controller. Two-layer auth as everywhere (the coarse
// gate is in routes/comms.js; the merge rule, window rule, ownership and timing
// live here). Every patient-touching action goes through resolvePatient. Media
// is only ever served through /messages/:id/media (A5). Outbound sending
// enforces the Meta 24 h free-form window; templates are always allowed.
// ---------------------------------------------------------------------------

const DOCUMENTS_DIR = path.join(__dirname, '..', 'uploads', 'documents');
const WINDOW_MS = 24 * 60 * 60 * 1000;

// --- formatting -------------------------------------------------------------

const patientBrief = (p) => (p ? { id: p.id, uhid: p.uhid, firstName: p.firstName, lastName: p.lastName, phone: p.phone, whatsappOptIn: p.whatsappOptIn } : null);
const userBrief = (u) => (u ? { id: u.id, name: `${u.firstName} ${u.lastName}`.trim(), role: u.role } : null);

const windowOpen = (conv) => !!(conv.windowExpiresAt && new Date(conv.windowExpiresAt) > new Date());

const formatConversation = (c) => ({
  id: c.id,
  channelId: c.channelId,
  channel: c.messagingChannel ? { id: c.messagingChannel.id, label: c.messagingChannel.label, displayPhone: c.messagingChannel.displayPhone } : null,
  externalUserId: c.externalUserId,
  displayNumber: display(c.externalUserId),
  profileName: c.profileName,
  contactType: c.contactType,
  organisation: c.organisation ? { id: c.organisation.id, name: c.organisation.name, type: c.organisation.type } : null,
  patient: patientBrief(c.patient),
  linkMethod: c.linkMethod,
  suggestedPatientIds: parseJsonColumn(c.suggestedPatientIds) || [],
  assignedTo: userBrief(c.assignedTo),
  status: c.status,
  topic: c.topic,
  topicSource: c.topicSource,
  pinned: !!c.pinnedAt,
  windowOpen: windowOpen(c),
  windowExpiresAt: c.windowExpiresAt,
  unreadCount: c.unreadCount,
  openQueryCount: c.openQueryCount,
  lastMessageAt: c.lastMessageAt,
  lastMessagePreview: c.lastMessagePreview,
});

const formatMessage = (m) => ({
  id: m.id,
  direction: m.direction,
  type: m.type,
  body: m.body,
  caption: m.caption,
  media: m.mediaPath ? { id: m.id, mime: m.mediaMime, fileName: m.mediaFileName, size: m.mediaSize, encrypted: m.mediaEncrypted, url: `/api/comms/messages/${m.id}/media` } : null,
  templateName: m.templateName,
  templateParams: parseJsonColumn(m.templateParams),
  status: m.status,
  statusAt: m.statusAt,
  errorCode: m.errorCode,
  errorMessage: m.errorMessage,
  billable: m.billable,
  pricingCategory: m.pricingCategory,
  sentBy: userBrief(m.sentBy),
  externalTimestamp: m.externalTimestamp,
  createdAt: m.createdAt,
  patientId: m.patientId,
  medicalDocumentId: m.medicalDocumentId,
  appointmentId: m.appointmentId,
  query: m.direction === 'in' && m.queryStatus ? {
    status: m.queryStatus,
    resolutionKind: m.resolutionKind,
    resolutionNote: m.resolutionNote,
    resolvedBy: userBrief(m.resolvedBy),
    resolvedAt: m.resolvedAt,
  } : null,
});

const CONV_INCLUDE = [
  { model: MessagingChannel, as: 'messagingChannel', attributes: ['id', 'label', 'displayPhone'] },
  { model: Patient, as: 'patient', attributes: ['id', 'uhid', 'firstName', 'lastName', 'phone', 'whatsappOptIn'] },
  { model: ExternalOrganisation, as: 'organisation', attributes: ['id', 'name', 'type'] },
  { model: User, as: 'assignedTo', attributes: ['id', 'firstName', 'lastName', 'role'] },
];
const MSG_INCLUDE = [{ model: User, as: 'sentBy', attributes: ['id', 'firstName', 'lastName', 'role'] }, { model: User, as: 'resolvedBy', attributes: ['id', 'firstName', 'lastName', 'role'] }];

const loadConversation = (id) => Conversation.findByPk(id, { include: CONV_INCLUDE });

// A controller reused as a function: capture its response instead of sending it.
const runController = (fn, req) => new Promise((resolve) => {
  const res = {
    statusCode: 200,
    status(c) { this.statusCode = c; return this; },
    json(payload) { resolve({ status: this.statusCode, payload }); },
    send(payload) { resolve({ status: this.statusCode, payload }); },
    sendStatus(c) { resolve({ status: c, payload: null }); },
  };
  Promise.resolve(fn(req, res)).catch((e) => resolve({ status: 500, payload: { success: false, message: e.message } }));
});

const defaultChannel = async () => MessagingChannel.findOne({ where: { channel: 'whatsapp', isActive: true }, order: [['id', 'ASC']] });

// --- core send --------------------------------------------------------------

/**
 * Deliver an outbound message and record it. Enforces the 24 h window for
 * free-form (text/media); templates are always allowed. Returns the created
 * message, or throws { code: 'windowClosed' } / a normalised Meta error.
 */
const deliverMessage = async (conv, channel, payload, user) => {
  const isTemplate = payload.kind === 'template';
  if (!isTemplate && !windowOpen(conv)) {
    const e = new Error('This chat is outside the 24-hour window — send an approved template instead.');
    e.code = 'windowClosed';
    throw e;
  }
  const to = conv.externalUserId;
  let apiRes;
  let row = {
    conversationId: conv.id, channel: 'whatsapp', direction: 'out', patientId: conv.patientId || null,
    sentById: user.id, status: 'sent', statusAt: new Date(),
  };

  if (payload.kind === 'text') {
    apiRes = await whatsappApi.sendText(channel.externalId, to, payload.text);
    row = { ...row, type: 'text', body: payload.text };
  } else if (payload.kind === 'template') {
    apiRes = await whatsappApi.sendTemplate(channel.externalId, to, payload.name, payload.language || 'en', payload.components || []);
    row = { ...row, type: 'template', templateName: payload.name, templateParams: payload.params || null, body: payload.preview || `[template: ${payload.name}]` };
  } else if (payload.kind === 'media') {
    apiRes = await whatsappApi.sendMedia(channel.externalId, to, { buffer: payload.buffer, mime: payload.mime, filename: payload.filename, caption: payload.caption, kind: (payload.mime || '').startsWith('image/') ? 'image' : 'document' });
    row = { ...row, type: (payload.mime || '').startsWith('image/') ? 'image' : 'document', caption: payload.caption || null, mediaPath: payload.storedPath, mediaMime: payload.mime, mediaFileName: payload.filename, mediaSize: payload.size };
  }
  row.externalMessageId = (apiRes && apiRes.messages && apiRes.messages[0] && apiRes.messages[0].id) || `out-${crypto.randomUUID()}`;

  const message = await ConversationMessage.create(row);
  const now = new Date();
  await conv.update({
    lastOutboundAt: now, lastMessageAt: now,
    lastMessagePreview: (payload.text || payload.caption || row.body || '').replace(/\s+/g, ' ').trim().slice(0, 160),
    status: conv.status === 'archived' ? 'open' : conv.status,
  });
  await MessagingChannel.update({ lastOutboundAt: now }, { where: { id: channel.id } });
  return message;
};

// --- badge + channels -------------------------------------------------------

const badge = async (req, res) => {
  try {
    const [needsReply, unreadRows, openQueries, escalatedToMe, labNew, remindersDue] = await Promise.all([
      Conversation.count({ where: { status: 'open', windowExpiresAt: { [Op.gt]: new Date() }, lastInboundAt: { [Op.ne]: null } } }),
      Conversation.sum('unreadCount', { where: { status: { [Op.ne]: 'archived' } } }),
      Conversation.sum('openQueryCount', { where: { status: { [Op.ne]: 'archived' } } }),
      ConversationEscalation.count({ where: { status: 'open', escalatedToId: req.user.id } }),
      LabInboxItem.count({ where: { status: 'New' } }),
      ConversationReminder.count({ where: { status: 'pending', forUserId: req.user.id, remindAt: { [Op.lte]: new Date() } } }),
    ]);
    const whatsapp = { unread: unreadRows || 0, needsReply, openQueries: openQueries || 0, escalatedToMe };
    const lab = { new: labNew };
    const reminders = { due: remindersDue };
    return success(res, { whatsapp, lab, reminders, total: (unreadRows || 0) + labNew + remindersDue });
  } catch (err) {
    console.error('Comms.badge error:', err);
    return error(res, 'Failed to load the inbox badge.', 500);
  }
};

const channels = async (req, res) => {
  try {
    const rows = await MessagingChannel.findAll({ where: { isActive: true }, order: [['id', 'ASC']], attributes: ['id', 'label', 'displayPhone', 'channel', 'qualityRating'] });
    return success(res, { channels: rows });
  } catch (err) {
    console.error('Comms.channels error:', err);
    return error(res, 'Failed to load channels.', 500);
  }
};

// --- conversations ----------------------------------------------------------

const FILTER_WHERE = (filter, userId) => {
  switch (filter) {
    case 'unread': return { unreadCount: { [Op.gt]: 0 }, status: { [Op.ne]: 'archived' } };
    case 'needsReply': return { status: 'open', windowExpiresAt: { [Op.gt]: new Date() }, lastInboundAt: { [Op.ne]: null } };
    case 'openQueries': return { openQueryCount: { [Op.gt]: 0 }, status: { [Op.ne]: 'archived' } };
    case 'unlinked': return { contactType: 'patient', patientId: null, status: { [Op.ne]: 'archived' } };
    case 'mine': return { assignedToId: userId, status: { [Op.ne]: 'archived' } };
    case 'labs': return { contactType: { [Op.in]: ['lab', 'organisation'] } };
    case 'closed': return { status: { [Op.in]: ['closed', 'archived'] } };
    case 'open': return { status: 'open' };
    default: return { status: { [Op.ne]: 'archived' } };
  }
};

const list = async (req, res) => {
  try {
    const { channelId, filter = 'all', search } = req.query;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = 30;
    const where = FILTER_WHERE(filter, req.user.id);
    if (channelId) where.channelId = Number(channelId);
    if (search) {
      const like = { [Op.like]: `%${String(search).replace(/[%_]/g, '')}%` };
      where[Op.or] = [{ profileName: like }, { externalUserId: like }, { topic: like }, { lastMessagePreview: like }];
    }
    if (filter === 'escalatedToMe') {
      const escalated = await ConversationEscalation.findAll({ where: { status: 'open', escalatedToId: req.user.id }, attributes: ['conversationId'] });
      where.id = { [Op.in]: escalated.map((e) => e.conversationId) };
    }
    const { rows, count } = await Conversation.findAndCountAll({
      where, include: CONV_INCLUDE,
      order: [['pinnedAt', 'DESC'], ['lastMessageAt', 'DESC']],
      limit, offset: (page - 1) * limit,
    });
    return success(res, { conversations: rows.map(formatConversation), total: count, page, pages: Math.ceil(count / limit) });
  } catch (err) {
    console.error('Comms.list error:', err);
    return error(res, 'Failed to load conversations.', 500);
  }
};

// POST /conversations { uhid } — start (or find) a thread for a patient's phone.
const startForPatient = async (req, res) => {
  try {
    const { uhid } = req.body;
    if (!uhid) return error(res, 'A patient UHID is required.', 400);
    const family = await resolvePatient(uhid);
    if (!family) return error(res, 'Patient not found.', 404);
    if (family.isDeactivated) return error(res, 'This patient profile is inactive.', 403);
    const { patient } = family;
    if (!patient.phone) return error(res, 'This patient has no phone number on file.', 400);
    const waId = toWaId(patient.phone);
    if (!waId) return error(res, 'The patient phone number is not a valid mobile number.', 400);
    const channel = await defaultChannel();
    if (!channel) return error(res, 'No WhatsApp number is configured. Add one in System Settings → WhatsApp.', 409);

    let conv = await Conversation.findOne({ where: { channelId: channel.id, externalUserId: waId } });
    if (!conv) {
      conv = await Conversation.create({
        channelId: channel.id, externalUserId: waId, contactType: 'patient',
        patientId: patient.id, linkMethod: 'manual', linkedById: req.user.id, linkedAt: new Date(), status: 'open',
      });
    } else if (!conv.patientId) {
      await conv.update({ patientId: patient.id, linkMethod: 'manual', linkedById: req.user.id, linkedAt: new Date() });
    }
    const full = await loadConversation(conv.id);
    return success(res, { conversation: formatConversation(full), windowOpen: windowOpen(full) }, 201);
  } catch (err) {
    console.error('Comms.startForPatient error:', err);
    return error(res, 'Failed to start the conversation.', 500);
  }
};

const detail = async (req, res) => {
  try {
    const conv = await loadConversation(req.params.id);
    if (!conv) return error(res, 'Conversation not found.', 404);
    const candidateIds = parseJsonColumn(conv.suggestedPatientIds) || [];
    const [candidates, escalations, reminders] = await Promise.all([
      candidateIds.length ? Patient.findAll({ where: { id: candidateIds }, attributes: ['id', 'uhid', 'firstName', 'lastName', 'phone'] }) : [],
      ConversationEscalation.findAll({ where: { conversationId: conv.id }, include: [{ model: User, as: 'escalatedBy', attributes: ['firstName', 'lastName'] }, { model: User, as: 'escalatedTo', attributes: ['firstName', 'lastName'] }], order: [['createdAt', 'DESC']] }),
      ConversationReminder.findAll({ where: { conversationId: conv.id, status: 'pending' }, order: [['remindAt', 'ASC']] }),
    ]);
    return success(res, {
      conversation: formatConversation(conv),
      candidates: candidates.map(patientBrief),
      escalations: escalations.map((e) => ({ id: e.id, status: e.status, note: e.note, by: userBrief(e.escalatedBy && { ...e.escalatedBy.dataValues, role: null }), to: e.escalatedTo ? `${e.escalatedTo.firstName} ${e.escalatedTo.lastName}` : null, at: e.createdAt })),
      reminders: reminders.map((r) => ({ id: r.id, remindAt: r.remindAt, note: r.note, forUserId: r.forUserId })),
    });
  } catch (err) {
    console.error('Comms.detail error:', err);
    return error(res, 'Failed to load the conversation.', 500);
  }
};

const messages = async (req, res) => {
  try {
    const conv = await Conversation.findByPk(req.params.id, { attributes: ['id'] });
    if (!conv) return error(res, 'Conversation not found.', 404);
    const where = { conversationId: conv.id };
    if (req.query.before) where.id = { [Op.lt]: Number(req.query.before) };
    const rows = await ConversationMessage.findAll({ where, include: MSG_INCLUDE, order: [['id', 'DESC']], limit: 50 });
    return success(res, { messages: rows.reverse().map(formatMessage), hasMore: rows.length === 50 });
  } catch (err) {
    console.error('Comms.messages error:', err);
    return error(res, 'Failed to load messages.', 500);
  }
};

// POST /conversations/:id/messages — { text } | { templateName, language, params } | multipart media
const send = async (req, res) => {
  try {
    const conv = await loadConversation(req.params.id);
    if (!conv) return error(res, 'Conversation not found.', 404);
    const channel = await MessagingChannel.findByPk(conv.channelId);
    if (!channel) return error(res, 'This conversation\'s WhatsApp number is no longer configured.', 409);

    const cfg = await getCommsConfig();
    const consentWarning = !!(conv.patient && cfg.warnNoConsent && conv.patient.whatsappOptIn === false);

    let payload;
    if (req.file) {
      // Outbound media upload (Send via WhatsApp / composer attach).
      const dir = path.join(__dirname, '..', 'private', 'comms', String(conv.id));
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const ext = path.extname(req.file.originalname) || '';
      const storedPath = path.join(dir, `${crypto.randomBytes(12).toString('hex')}${ext}`);
      fs.writeFileSync(storedPath, req.file.buffer);
      payload = { kind: 'media', buffer: req.file.buffer, mime: req.file.mimetype, filename: req.file.originalname, caption: req.body.caption, storedPath, size: req.file.size };
    } else if (req.body.templateName) {
      payload = { kind: 'template', name: req.body.templateName, language: req.body.language || 'en', params: req.body.params, components: req.body.components, preview: req.body.preview };
    } else if (req.body.text && String(req.body.text).trim()) {
      payload = { kind: 'text', text: String(req.body.text).trim() };
    } else {
      return error(res, 'Nothing to send.', 400);
    }

    let message;
    try {
      message = await deliverMessage(conv, channel, payload, req.user);
    } catch (e) {
      if (e.code === 'windowClosed') return error(res, e.message, 409, { code: 'windowClosed' });
      return error(res, e.userMessage || 'WhatsApp could not send the message.', 502, { metaCode: e.code || null });
    }
    const full = await ConversationMessage.findByPk(message.id, { include: MSG_INCLUDE });
    return success(res, { message: formatMessage(full), consentWarning }, 201);
  } catch (err) {
    console.error('Comms.send error:', err);
    return error(res, 'Failed to send the message.', 500);
  }
};

const markRead = async (req, res) => {
  try {
    const conv = await loadConversation(req.params.id);
    if (!conv) return error(res, 'Conversation not found.', 404);
    const cfg = await getCommsConfig();
    if (cfg.markReadOnOpen) {
      const last = await ConversationMessage.findOne({ where: { conversationId: conv.id, direction: 'in' }, order: [['id', 'DESC']] });
      const channel = await MessagingChannel.findByPk(conv.channelId);
      if (last && channel) await whatsappApi.markRead(channel.externalId, last.externalMessageId);
    }
    await conv.update({ unreadCount: 0 });
    return success(res, { ok: true });
  } catch (err) {
    console.error('Comms.markRead error:', err);
    return error(res, 'Failed to mark as read.', 500);
  }
};

// --- linking ----------------------------------------------------------------

const link = async (req, res) => {
  try {
    const { uhid, moveEarlier, reason } = req.body;
    if (!uhid) return error(res, 'A patient UHID is required.', 400);
    const conv = await Conversation.findByPk(req.params.id);
    if (!conv) return error(res, 'Conversation not found.', 404);
    const family = await resolvePatient(uhid);
    if (!family) return error(res, 'Patient not found.', 404);
    if (family.isDeactivated) return error(res, 'This patient profile is inactive.', 403);
    await conv.update({
      patientId: family.patient.id, contactType: 'patient', contactOrgId: null,
      linkMethod: 'manual', linkedById: req.user.id, linkedAt: new Date(), suggestedPatientIds: null,
    });
    // Optionally stamp this patient onto the thread's earlier unlinked messages.
    if (moveEarlier) {
      await ConversationMessage.update({ patientId: family.patient.id }, { where: { conversationId: conv.id, patientId: null } });
    }
    return success(res, { conversation: formatConversation(await loadConversation(conv.id)) });
  } catch (err) {
    console.error('Comms.link error:', err);
    return error(res, 'Failed to link the conversation.', 500);
  }
};

const unlink = async (req, res) => {
  try {
    const conv = await Conversation.findByPk(req.params.id);
    if (!conv) return error(res, 'Conversation not found.', 404);
    await conv.update({ patientId: null, linkMethod: null, linkedById: null, linkedAt: null });
    return success(res, { conversation: formatConversation(await loadConversation(conv.id)) });
  } catch (err) {
    console.error('Comms.unlink error:', err);
    return error(res, 'Failed to unlink the conversation.', 500);
  }
};

const setContactType = async (req, res) => {
  try {
    const { contactType, organisationId, newOrganisation } = req.body;
    if (!['patient', 'lab', 'organisation'].includes(contactType)) return error(res, 'Invalid contact type.', 400);
    const conv = await Conversation.findByPk(req.params.id);
    if (!conv) return error(res, 'Conversation not found.', 404);
    const patch = { contactType };
    if (contactType === 'patient') { patch.contactOrgId = null; }
    else {
      let org = null;
      if (organisationId) org = await ExternalOrganisation.findByPk(organisationId);
      else if (newOrganisation && newOrganisation.name) org = await ExternalOrganisation.create({ name: newOrganisation.name, type: newOrganisation.type || (contactType === 'lab' ? 'lab' : 'other') });
      if (org) {
        patch.contactOrgId = org.id;
        patch.patientId = null; patch.linkMethod = null;
        // Remember this number as the org's WhatsApp handle for future auto-typing.
        await ExternalOrganisationContact.findOrCreate({ where: { kind: 'whatsapp', value: conv.externalUserId }, defaults: { organisationId: org.id, kind: 'whatsapp', value: conv.externalUserId } });
      }
    }
    await conv.update(patch);
    return success(res, { conversation: formatConversation(await loadConversation(conv.id)) });
  } catch (err) {
    console.error('Comms.setContactType error:', err);
    return error(res, 'Failed to set the contact type.', 500);
  }
};

const simpleUpdate = (fields, label) => async (req, res) => {
  try {
    const conv = await Conversation.findByPk(req.params.id);
    if (!conv) return error(res, 'Conversation not found.', 404);
    await conv.update(fields(req));
    return success(res, { conversation: formatConversation(await loadConversation(conv.id)) });
  } catch (err) {
    console.error(`Comms.${label} error:`, err);
    return error(res, `Failed to ${label}.`, 500);
  }
};

const pin = simpleUpdate((req) => ({ pinnedAt: new Date(), pinnedById: req.user.id }), 'pin');
const unpin = simpleUpdate(() => ({ pinnedAt: null, pinnedById: null }), 'unpin');
const setTopic = simpleUpdate((req) => ({ topic: (req.body.topic || '').slice(0, 120) || null, topicSource: 'manual' }), 'set the topic');
const assign = simpleUpdate((req) => ({ assignedToId: req.body.userId || null }), 'assign');
const close = simpleUpdate(() => ({ status: 'closed' }), 'close');
const reopen = simpleUpdate(() => ({ status: 'open' }), 'reopen');

// --- escalations + internal notes ------------------------------------------

const escalate = async (req, res) => {
  try {
    const { toUserId, note } = req.body;
    const conv = await Conversation.findByPk(req.params.id);
    if (!conv) return error(res, 'Conversation not found.', 404);
    const noteMsg = await ConversationMessage.create({
      conversationId: conv.id, channel: 'whatsapp', direction: 'internal',
      externalMessageId: `int-${crypto.randomUUID()}`, type: 'internal_note', body: note || 'Escalated', sentById: req.user.id, status: 'sent', statusAt: new Date(),
    });
    const esc = await ConversationEscalation.create({ conversationId: conv.id, messageId: noteMsg.id, escalatedById: req.user.id, escalatedToId: toUserId || null, note: note || null, status: 'open' });
    return success(res, { escalation: { id: esc.id, status: esc.status } }, 201);
  } catch (err) {
    console.error('Comms.escalate error:', err);
    return error(res, 'Failed to escalate.', 500);
  }
};

const internalNote = async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !String(text).trim()) return error(res, 'A note is required.', 400);
    const conv = await Conversation.findByPk(req.params.id);
    if (!conv) return error(res, 'Conversation not found.', 404);
    const msg = await ConversationMessage.create({
      conversationId: conv.id, channel: 'whatsapp', direction: 'internal',
      externalMessageId: `int-${crypto.randomUUID()}`, type: 'internal_note', body: String(text).trim(), sentById: req.user.id, status: 'sent', statusAt: new Date(),
    });
    return success(res, { message: formatMessage(await ConversationMessage.findByPk(msg.id, { include: MSG_INCLUDE })) }, 201);
  } catch (err) {
    console.error('Comms.internalNote error:', err);
    return error(res, 'Failed to add the note.', 500);
  }
};

const resolveEscalation = async (req, res) => {
  try {
    const esc = await ConversationEscalation.findByPk(req.params.id);
    if (!esc) return error(res, 'Escalation not found.', 404);
    await esc.update({ status: 'resolved', resolvedById: req.user.id, resolvedAt: new Date(), firstDoctorReplyAt: esc.firstDoctorReplyAt || new Date() });
    return success(res, { ok: true });
  } catch (err) {
    console.error('Comms.resolveEscalation error:', err);
    return error(res, 'Failed to resolve the escalation.', 500);
  }
};

// --- queries ----------------------------------------------------------------

const RESOLUTION_KINDS = ['answered', 'appointment_booked', 'document_filed', 'referred', 'no_action'];

const completeQuery = async (req, res) => {
  try {
    const { resolutionKind, resolutionNote } = req.body;
    if (!resolutionNote || !String(resolutionNote).trim()) return error(res, 'A resolution note is required to complete a query.', 400);
    if (resolutionKind && !RESOLUTION_KINDS.includes(resolutionKind)) return error(res, 'Invalid resolution kind.', 400);
    const msg = await ConversationMessage.findByPk(req.params.id);
    if (!msg) return error(res, 'Message not found.', 404);
    if (msg.direction !== 'in') return error(res, 'Only an incoming message is a query.', 400);
    if (msg.queryStatus === 'completed') return error(res, 'This query is already completed.', 409);
    await msg.update({ queryStatus: 'completed', resolutionKind: resolutionKind || 'answered', resolutionNote: String(resolutionNote).trim(), resolvedById: req.user.id, resolvedAt: new Date() });
    const conv = await Conversation.findByPk(msg.conversationId);
    if (conv) await conv.update({ openQueryCount: Math.max(0, (conv.openQueryCount || 1) - 1) });
    return success(res, { message: formatMessage(await ConversationMessage.findByPk(msg.id, { include: MSG_INCLUDE })) });
  } catch (err) {
    console.error('Comms.completeQuery error:', err);
    return error(res, 'Failed to complete the query.', 500);
  }
};

const reopenQuery = async (req, res) => {
  try {
    const msg = await ConversationMessage.findByPk(req.params.id);
    if (!msg) return error(res, 'Message not found.', 404);
    if (msg.direction !== 'in' || msg.queryStatus !== 'completed') return error(res, 'This query is not completed.', 400);
    await msg.update({ queryStatus: 'open', reopenedById: req.user.id, reopenedAt: new Date() });
    const conv = await Conversation.findByPk(msg.conversationId);
    if (conv) await conv.update({ openQueryCount: (conv.openQueryCount || 0) + 1 });
    return success(res, { message: formatMessage(await ConversationMessage.findByPk(msg.id, { include: MSG_INCLUDE })) });
  } catch (err) {
    console.error('Comms.reopenQuery error:', err);
    return error(res, 'Failed to reopen the query.', 500);
  }
};

// --- media serve + file to record ------------------------------------------

const serveMedia = async (req, res) => {
  try {
    const msg = await ConversationMessage.findByPk(req.params.id);
    if (!msg || !msg.mediaPath) return error(res, 'Media not found.', 404);
    if (!fs.existsSync(msg.mediaPath)) return error(res, 'The file is no longer on the server.', 404);
    res.setHeader('Content-Type', msg.mediaMime || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${(msg.mediaFileName || 'file').replace(/"/g, '')}"`);
    return res.sendFile(path.resolve(msg.mediaPath));
  } catch (err) {
    console.error('Comms.serveMedia error:', err);
    return error(res, 'Failed to open the file.', 500);
  }
};

// POST /messages/:id/file — file an inbound attachment into the patient record,
// removing a PDF password if needed (the patient's own ID/DOB tried first).
const fileToRecord = async (req, res) => {
  try {
    const { uhid, documentCategory, testType, labName, testDate, notes, password, completeQuery: doComplete } = req.body;
    if (!uhid) return error(res, 'A patient UHID is required.', 400);
    const msg = await ConversationMessage.findByPk(req.params.id);
    if (!msg || !msg.mediaPath || !fs.existsSync(msg.mediaPath)) return error(res, 'The attachment is missing.', 404);

    const family = await resolvePatient(uhid);
    if (!family) return error(res, 'Patient not found.', 404);
    if (family.isDeactivated) return error(res, 'This patient profile is inactive.', 403);
    const { patient } = family;

    let bytes = fs.readFileSync(msg.mediaPath);
    // Password removal for a locked PDF: patient identifiers first, then the
    // password the user typed. A still-locked PDF is refused, not filed locked.
    if ((msg.mediaMime || '').includes('pdf') && await pdfUnlock.isEncrypted(bytes)) {
      const auto = await pdfUnlock.tryPatientPasswords(bytes, patient);
      if (auto) bytes = auto.buffer;
      else if (password) {
        try { bytes = await pdfUnlock.decrypt(bytes, password); }
        catch { return error(res, 'That password did not unlock the PDF.', 422, { code: 'invalid_password' }); }
      } else {
        return error(res, 'This PDF is password-protected. Enter the password to file it.', 422, { code: 'password_required' });
      }
    }

    if (!fs.existsSync(DOCUMENTS_DIR)) fs.mkdirSync(DOCUMENTS_DIR, { recursive: true });
    const ext = path.extname(msg.mediaFileName || '') || (msg.mediaMime === 'application/pdf' ? '.pdf' : '');
    const newFilename = crypto.randomBytes(16).toString('hex') + ext;
    fs.writeFileSync(path.join(DOCUMENTS_DIR, newFilename), bytes);

    const document = await createMedicalDocument({
      patient, actingUser: req.user,
      file: { originalName: msg.mediaFileName || `whatsapp${ext}`, filename: newFilename, size: bytes.length },
      documentCategory: documentCategory || 'WhatsApp Attachment',
      testType: testType || null, labName: labName || null, testDate: testDate || null, notes: notes || null,
      status: 'Pending Review',
    });

    await msg.update({ medicalDocumentId: document.id, patientId: patient.id });
    if (doComplete && msg.direction === 'in' && msg.queryStatus === 'open') {
      await msg.update({ queryStatus: 'completed', resolutionKind: 'document_filed', resolutionNote: `Filed “${msg.mediaFileName || 'attachment'}” to the record`, resolvedById: req.user.id, resolvedAt: new Date() });
      const conv = await Conversation.findByPk(msg.conversationId);
      if (conv) await conv.update({ openQueryCount: Math.max(0, (conv.openQueryCount || 1) - 1) });
    }
    return success(res, { documentId: document.id, patient: patientBrief(patient), message: formatMessage(await ConversationMessage.findByPk(msg.id, { include: MSG_INCLUDE })) }, 201);
  } catch (err) {
    console.error('Comms.fileToRecord error:', err);
    return error(res, 'Failed to file the attachment.', 500);
  }
};

// --- book from chat ---------------------------------------------------------

const bookFromChat = async (req, res) => {
  try {
    const conv = await loadConversation(req.params.id);
    if (!conv) return error(res, 'Conversation not found.', 404);
    if (!conv.patientId || !conv.patient) return error(res, 'Link this conversation to a patient before booking.', 400);
    const { doctorId, date, timeSlot, appointmentType, reason, notes, sendConfirmation } = req.body;

    // Reuse the full booking rules (slot availability, doctor blocks, cap).
    const bookReq = { user: req.user, body: { doctorId, date, timeSlot, appointmentType, reason, notes, uhid: conv.patient.uhid } };
    const result = await runController(appointmentController.book, bookReq);
    if (!result.payload || result.payload.success === false) {
      return error(res, (result.payload && result.payload.message) || 'Could not book the appointment.', result.status || 400);
    }
    const appt = result.payload.data && (result.payload.data.appointment || result.payload.data);
    const appointmentId = appt && (appt.id || appt.appointmentId);

    // A system message row records the booking on the thread.
    const sysBody = `📅 Appointment booked${appt && appt.date ? ` for ${appt.date}` : ''}${appt && appt.timeSlot ? ` at ${appt.timeSlot}` : ''}.`;
    const sys = await ConversationMessage.create({ conversationId: conv.id, channel: 'whatsapp', direction: 'internal', externalMessageId: `int-${crypto.randomUUID()}`, type: 'system', body: sysBody, sentById: req.user.id, appointmentId: appointmentId || null, status: 'sent', statusAt: new Date() });

    // Optionally send the patient a confirmation (free-form if the window is
    // open, else the approved template).
    let confirmationSent = false;
    if (sendConfirmation) {
      const channel = await MessagingChannel.findByPk(conv.channelId);
      try {
        if (windowOpen(conv)) {
          await deliverMessage(conv, channel, { kind: 'text', text: `Your appointment at the Comprehensive Diabetes Centre is confirmed${appt && appt.date ? ` for ${appt.date}` : ''}${appt && appt.timeSlot ? ` at ${appt.timeSlot}` : ''}. Reply here if you need to change it.` }, req.user);
        } else {
          const name = `${conv.patient.firstName} ${conv.patient.lastName}`.trim();
          await deliverMessage(conv, channel, { kind: 'template', name: 'appointment_confirmation', language: 'en', components: [{ type: 'body', parameters: [name, appt?.date || '', appt?.timeSlot || '', 'the clinic'].map((t) => ({ type: 'text', text: String(t) })) }], preview: 'Appointment confirmation' }, req.user);
        }
        confirmationSent = true;
      } catch (e) {
        console.error('Comms.bookFromChat confirmation (non-fatal):', e.message);
      }
    }
    return success(res, { appointmentId, confirmationSent, message: formatMessage(await ConversationMessage.findByPk(sys.id, { include: MSG_INCLUDE })) }, 201);
  } catch (err) {
    console.error('Comms.bookFromChat error:', err);
    return error(res, 'Failed to book from the chat.', 500);
  }
};

// --- reminders --------------------------------------------------------------

const listReminders = async (req, res) => {
  try {
    const { filter = 'due', from, to } = req.query;
    const mine = req.query.mine === '1' || req.query.mine === 'true';
    const where = { status: { [Op.in]: ['pending', 'snoozed'] } };
    if (mine) where.forUserId = req.user.id;
    const now = new Date();
    if (filter === 'due') where.remindAt = { [Op.lte]: now };
    else if (filter === 'today') { const end = new Date(now); end.setHours(23, 59, 59, 999); where.remindAt = { [Op.lte]: end }; }
    else if (filter === 'week') { const wk = new Date(now.getTime() + 7 * 24 * 3600 * 1000); where.remindAt = { [Op.lte]: wk }; }
    else if (filter === 'range' && from && to) where.remindAt = { [Op.gte]: new Date(from), [Op.lte]: new Date(to) };
    const rows = await ConversationReminder.findAll({
      where, include: [{ model: Conversation, attributes: ['id', 'profileName', 'externalUserId', 'patientId'] }, { model: User, as: 'forUser', attributes: ['firstName', 'lastName'] }],
      order: [['remindAt', 'ASC']], limit: 200,
    });
    return success(res, { reminders: rows.map((r) => ({ id: r.id, remindAt: r.remindAt, note: r.note, status: r.status, conversationId: r.conversationId, forUser: userBrief(r.forUser && { ...r.forUser.dataValues, id: r.forUserId }), profileName: r.Conversation && r.Conversation.profileName })) });
  } catch (err) {
    console.error('Comms.listReminders error:', err);
    return error(res, 'Failed to load reminders.', 500);
  }
};

const createReminder = async (req, res) => {
  try {
    const { remindAt, note, forUserId } = req.body;
    if (!remindAt) return error(res, 'A reminder time is required.', 400);
    const conv = await Conversation.findByPk(req.params.id);
    if (!conv) return error(res, 'Conversation not found.', 404);
    const r = await ConversationReminder.create({ conversationId: conv.id, patientId: conv.patientId || null, setById: req.user.id, forUserId: forUserId || req.user.id, remindAt: new Date(remindAt), note: note || null, status: 'pending' });
    return success(res, { reminder: { id: r.id, remindAt: r.remindAt, note: r.note } }, 201);
  } catch (err) {
    console.error('Comms.createReminder error:', err);
    return error(res, 'Failed to set the reminder.', 500);
  }
};

const updateReminder = (action) => async (req, res) => {
  try {
    const r = await ConversationReminder.findByPk(req.params.id);
    if (!r) return error(res, 'Reminder not found.', 404);
    if (action === 'done') await r.update({ status: 'done', doneById: req.user.id, doneAt: new Date() });
    else if (action === 'cancel') await r.update({ status: 'cancelled' });
    else if (action === 'snooze') await r.update({ status: 'pending', remindAt: new Date(req.body.remindAt || Date.now() + 3600_000), snoozedUntil: new Date(req.body.remindAt || Date.now() + 3600_000) });
    else if (action === 'reassign') await r.update({ forUserId: req.body.userId || r.forUserId });
    return success(res, { ok: true });
  } catch (err) {
    console.error(`Comms.reminder.${action} error:`, err);
    return error(res, 'Failed to update the reminder.', 500);
  }
};

// --- templates + organisations ---------------------------------------------

const listTemplates = async (req, res) => {
  try {
    const rows = await MessageTemplate.findAll({ where: { channelKey: 'whatsapp' }, order: [['name', 'ASC']] });
    return success(res, { templates: rows.map((t) => ({ id: t.id, name: t.name, language: t.language, category: t.category, status: t.status, components: parseJsonColumn(t.components) })) });
  } catch (err) {
    console.error('Comms.listTemplates error:', err);
    return error(res, 'Failed to load templates.', 500);
  }
};

const syncTemplates = async (req, res) => {
  try {
    const cfg = await getCommsConfig();
    if (!cfg.wabaId) return error(res, 'The WhatsApp Business Account ID is not set.', 409);
    const remote = await whatsappApi.getTemplates(cfg.wabaId);
    for (const t of remote) {
      await MessageTemplate.upsert({ channelKey: 'whatsapp', name: t.name, language: t.language, category: t.category, status: t.status, components: t.components, syncedAt: new Date() });
    }
    return success(res, { synced: remote.length });
  } catch (err) {
    console.error('Comms.syncTemplates error:', err);
    return error(res, err.userMessage || 'Failed to sync templates from WhatsApp.', 502);
  }
};

const listOrganisations = async (req, res) => {
  try {
    const where = {};
    if (req.query.type) where.type = req.query.type;
    const rows = await ExternalOrganisation.findAll({ where, include: [{ model: ExternalOrganisationContact, as: 'contacts' }], order: [['name', 'ASC']] });
    return success(res, { organisations: rows.map((o) => ({ id: o.id, name: o.name, type: o.type, isActive: o.isActive, contacts: (o.contacts || []).map((c) => ({ id: c.id, kind: c.kind, value: c.value, label: c.label })) })) });
  } catch (err) {
    console.error('Comms.listOrganisations error:', err);
    return error(res, 'Failed to load organisations.', 500);
  }
};

const saveOrganisation = async (req, res) => {
  try {
    const { id, name, type, isActive, contacts } = req.body;
    if (!name) return error(res, 'A name is required.', 400);
    let org;
    if (id) { org = await ExternalOrganisation.findByPk(id); if (!org) return error(res, 'Organisation not found.', 404); await org.update({ name, type: type || org.type, isActive: isActive !== undefined ? isActive : org.isActive }); }
    else org = await ExternalOrganisation.create({ name, type: type || 'lab', isActive: isActive !== undefined ? isActive : true });
    if (Array.isArray(contacts)) {
      await ExternalOrganisationContact.destroy({ where: { organisationId: org.id } });
      for (const c of contacts) {
        if (!c.value || !c.kind) continue;
        const value = c.kind === 'whatsapp' ? (toWaId(c.value) || c.value) : String(c.value).trim().toLowerCase();
        await ExternalOrganisationContact.findOrCreate({ where: { kind: c.kind, value }, defaults: { organisationId: org.id, kind: c.kind, value, label: c.label || null } });
      }
    }
    return success(res, { organisationId: org.id });
  } catch (err) {
    console.error('Comms.saveOrganisation error:', err);
    return error(res, 'Failed to save the organisation.', 500);
  }
};

// --- analytics --------------------------------------------------------------

const analyticsOperations = async (req, res) => {
  try {
    const data = await commsAnalytics.operations({ from: req.query.from, to: req.query.to, channelId: req.query.channelId, staffId: req.query.staffId });
    return success(res, data);
  } catch (err) {
    console.error('Comms.analyticsOperations error:', err);
    return error(res, 'Failed to load operations analytics.', 500);
  }
};

const analyticsCosts = async (req, res) => {
  try {
    const data = await commsAnalytics.costs({ from: req.query.from, to: req.query.to, channelId: req.query.channelId });
    return success(res, data);
  } catch (err) {
    console.error('Comms.analyticsCosts error:', err);
    return error(res, 'Failed to load cost analytics.', 500);
  }
};

// --- patient communications trail (Patient file → Communications tab) --------

// The full messaging trail for one patient — merge-aware (reads across the whole
// family). Powers the patient-file Communications tab: every message with this
// patient's snapshot, plus the conversation(s) so the tab can open the thread.
const patientTrail = async (req, res) => {
  try {
    const family = await resolvePatient(req.params.uhid);
    if (!family) return error(res, 'Patient not found.', 404);
    const { from, to, channel, show } = req.query;
    const where = { patientId: { [Op.in]: family.patientIds } };
    if (channel) where.channel = channel;
    if (show === 'queries') where.queryStatus = { [Op.ne]: null };
    if (show === 'internal') where.direction = 'internal';
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt[Op.gte] = new Date(from);
      if (to) { const t = new Date(to); t.setHours(23, 59, 59, 999); where.createdAt[Op.lte] = t; }
    }
    const rows = await ConversationMessage.findAll({ where, include: MSG_INCLUDE, order: [['createdAt', 'DESC']], limit: 500 });
    const convIds = [...new Set(rows.map((m) => m.conversationId))];
    const conversations = convIds.length
      ? await Conversation.findAll({ where: { id: convIds }, include: CONV_INCLUDE }) : [];
    return success(res, {
      messages: rows.map(formatMessage),
      conversations: conversations.map(formatConversation),
    });
  } catch (err) {
    console.error('Comms.patientTrail error:', err);
    return error(res, 'Failed to load the communications trail.', 500);
  }
};

module.exports = {
  badge, channels, list, startForPatient, detail, messages, send, markRead,
  link, unlink, setContactType, pin, unpin, setTopic, assign, close, reopen,
  escalate, internalNote, resolveEscalation, completeQuery, reopenQuery,
  serveMedia, fileToRecord, bookFromChat,
  listReminders, createReminder, updateReminder,
  listTemplates, syncTemplates, listOrganisations, saveOrganisation,
  analyticsOperations, analyticsCosts, patientTrail,
};
