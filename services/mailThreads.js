const path = require('path');
const { Op } = require('sequelize');
const db = require('../models');
const session = require('./mailSession');
const accounts = require('./mailAccounts');
const { resolvePatient } = require('../utils/patientFamily');
const { gateResult } = require('../constants/permissions');
const { parseIdList, htmlToText, domainOf } = require('../utils/mailCompose');
const { walkParts } = require('../utils/mailRender');

const { MailError } = session;
const { PatientEmailMessage, StaffMailTraffic, MedicalDocument, User, Patient } = db;

// ---------------------------------------------------------------------------
// Staff Email (B26) phase 5 — patient email threads + mail traffic.
// (Emu, 27 Sep — claude/b26-phase5-patient-email-threads-plan.md)
//
//   Threads   PatientEmailMessages: the email side of a patient's
//             Communications trail. A message joins a patient thread when
//               - it is SENT from the HMS to a tagged patient chip, or with the
//                 patient chosen in the Composer's "Patient file" row, or
//               - it REPLIES to (In-Reply-To / References) a message already in
//                 that patient's thread — picked up at send time for HMS
//                 replies, and by the 5-minute checker (services/mailSync) for
//                 mail that arrives or is sent from a phone / webmail, or
//               - a staff member LINKS it ("Link to patient" in My mail).
//             Text, from/to and time are kept (this reverses D1 for patient
//             threads only). File documents are kept as ids; other attachments
//             by name. Soft delete only, admins only.
//   Traffic   StaffMailTraffic: one metadata row per message sent or received
//             by a connected mailbox — never a subject, body or full address.
// ---------------------------------------------------------------------------

// Linking an email to a patient's trail = the WhatsApp "link a thread to a
// patient" capability (routes/comms.js WRITE).
const LINK_GATE = ['staff', 'doctor', 'nurse', 'admin', 'comms.write'];

const MAX_BODY_CHARS = 100000;
const MAX_TEXT_BYTES = 512 * 1024;
const MAX_LINK_MESSAGES = 30;

const cleanId = (v) => (parseIdList(v)[0] || null);
// One stored attachment. Rows written before phase 5b hold a plain name.
const attachmentEntry = (a) => (typeof a === 'string'
  ? { name: a.slice(0, 200) }
  : { name: String(a.filename || a.name || 'attachment').slice(0, 200), part: a.part || null, type: a.type || null, size: a.size || null, documentId: a.documentId || null });
const attachmentsOf = (row) => parse(row.attachmentNames).map(attachmentEntry);
// The types a patient file accepts (the server checks the bytes again on save).
const SAVEABLE = (a) => /^(application\/pdf|image\/(png|jpe?g))$/i.test(a.type || '') || /\.(pdf|jpe?g|png)$/i.test(a.name || '');
const idList = (...values) => [...new Set(values.flatMap((v) => (Array.isArray(v) ? v.flatMap((x) => parseIdList(x)) : parseIdList(v))))];
const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s || '');
const fullName = (u) => (u ? `${u.firstName || ''} ${u.lastName || ''}`.trim() : null);
const json = (v) => JSON.stringify(v == null ? [] : v);
const parse = (v) => { try { const x = JSON.parse(v || '[]'); return Array.isArray(x) ? x : []; } catch { return []; } };
const addr = (list) => (Array.isArray(list) ? list : []).filter((a) => a && a.address)
  .map((a) => ({ name: a.name || null, address: String(a.address).toLowerCase() }));

/** A stable id for a message that carries no Message-ID header. */
const syntheticId = (userId, folder, uidValidity, uid) => `<hms-${userId}-${String(folder).replace(/[^\w.-]/g, '_')}-${uidValidity}-${uid}@no-message-id>`;

/** The thread a message belongs to: the first id it references, else itself. */
const threadKeyOf = ({ messageId, references, inReplyTo }) => (idList(references)[0] || cleanId(inReplyTo) || messageId);

// ---- traffic ---------------------------------------------------------------

/** One metadata row. Duplicate (same mailbox, direction, Message-ID) is ignored. */
const recordTraffic = async ({ userId, direction, via, messageId, addresses = [], attachmentCount = 0, patientId = null, at }) => {
  if (!messageId) return null;
  const domains = [...new Set(addresses.map((a) => domainOf(a.address || a)).filter(Boolean))].sort();
  try {
    const [row] = await StaffMailTraffic.findOrCreate({
      where: { userId, direction, messageId: String(messageId).slice(0, 255) },
      defaults: {
        via, domains: domains.join(',').slice(0, 255), recipientCount: direction === 'out' ? addresses.length : 1,
        attachmentCount, patientId, at: at || new Date(),
      },
    });
    if (patientId && !row.patientId) await row.update({ patientId });
    return row;
  } catch (err) {
    if (err && err.name === 'SequelizeUniqueConstraintError') return null;
    console.error('[Mail] traffic not recorded:', err.code || err.name || err.message);
    return null;
  }
};

const trafficExists = async (userId, direction, messageId) => !!(messageId && await StaffMailTraffic.count({
  where: { userId, direction, messageId: String(messageId).slice(0, 255) },
}));

// ---- threads: store + match ------------------------------------------------

/** Patients whose ACTIVE thread contains any of these Message-IDs → Map(patientId → threadKey). */
const patientsForIds = async (ids) => {
  const list = [...new Set((ids || []).filter(Boolean))].slice(0, 60);
  if (!list.length) return new Map();
  const rows = await PatientEmailMessage.findAll({
    where: { messageId: { [Op.in]: list }, status: 'active' },
    attributes: ['patientId', 'threadKey'],
  });
  const out = new Map();
  for (const r of rows) if (!out.has(r.patientId)) out.set(r.patientId, r.threadKey);
  return out;
};

/**
 * Store one message on one patient's thread. Never duplicates (patient +
 * Message-ID); never brings back a row an admin removed. → { row, created }
 */
const storeMessage = async (m) => {
  const where = { patientId: m.patientId, messageId: String(m.messageId).slice(0, 255) };
  const existing = await PatientEmailMessage.findOne({ where });
  if (existing) {
    // A link can add document ids the checker didn't know about.
    if (m.documentIds && m.documentIds.length && existing.status === 'active') {
      const ids = [...new Set([...parse(existing.documentIds), ...m.documentIds])];
      if (ids.length !== parse(existing.documentIds).length) await existing.update({ documentIds: json(ids) });
    }
    return { row: existing, created: false };
  }
  const row = await PatientEmailMessage.create({
    ...where,
    threadKey: String(m.threadKey || m.messageId).slice(0, 255),
    inReplyTo: cleanId(m.inReplyTo),
    referencesIds: idList(m.references).slice(-30).join(' ') || null,
    direction: m.direction,
    mailboxUserId: m.mailboxUserId || null,
    fromName: m.from && m.from.name ? String(m.from.name).slice(0, 250) : null,
    fromAddress: m.from && m.from.address ? String(m.from.address).toLowerCase().slice(0, 250) : null,
    toList: json(addr(m.to)),
    ccList: json(addr(m.cc)),
    subject: m.subject ? String(m.subject).slice(0, 500) : null,
    bodyText: clip(String(m.bodyText || '').trim(), MAX_BODY_CHARS),
    sentAt: m.sentAt ? new Date(m.sentAt) : new Date(),
    source: m.source,
    documentIds: json(m.documentIds || []),
    // Attachments NOT from the patient file: { name, part?, type?, size?, documentId? }
    // — the file itself stays in the mailbox; documentId is set once someone
    // saves it into the patient's Documents (phase 5b).
    attachmentNames: json((m.attachmentNames || []).slice(0, 30).map(attachmentEntry)),
    linkedById: m.linkedById || null,
  });
  return { row, created: true };
};

/**
 * Verify a list of UHIDs for LINKING a message to a patient (the Composer's
 * "Patient file" row): the caller must pass the link gate, the file must exist
 * and be active. Unknown / merged / not allowed are dropped silently — this
 * never blocks a send. → [{ patientId, uhid }]
 */
const verifyLinkPatients = async (user, uhids) => {
  const list = [...new Set((Array.isArray(uhids) ? uhids : []).map((u) => String(u || '').trim()).filter((u) => u && u.length <= 50))].slice(0, 10);
  if (!list.length || gateResult(user, LINK_GATE) !== 'ok') return [];
  const out = [];
  for (const uhid of list) {
    const family = await resolvePatient(uhid);
    if (!family || family.isDeactivated) continue;
    if (!out.some((o) => o.patientId === family.patient.id)) out.push({ patientId: family.patient.id, uhid: family.patient.uhid });
  }
  return out;
};

/**
 * After a send from the HMS has gone: the traffic row, and the message on
 * every patient thread it belongs to (tagged patients, linked patients, and
 * any patient whose thread it replies to). Never throws.
 */
const afterHmsSend = async ({
  user, mailbox, messageId, rcpt, subject, html, date, inReplyTo, references,
  patientRcpts = [], linkPatients = [], idsByPatient = new Map(), attachmentNames = [],
}) => {
  try {
    const all = [...(rcpt.to || []), ...(rcpt.cc || []), ...(rcpt.bcc || [])];
    const byReply = await patientsForIds(idList(inReplyTo, references));
    const patients = new Map(byReply);   // patientId → threadKey
    const key = threadKeyOf({ messageId, references, inReplyTo });
    for (const p of [...patientRcpts, ...linkPatients]) if (!patients.has(p.patientId)) patients.set(p.patientId, key);
    const firstPatient = patients.size ? [...patients.keys()][0] : null;
    await recordTraffic({
      userId: user.id, direction: 'out', via: 'hms', messageId, addresses: all,
      attachmentCount: attachmentNames.length + [...idsByPatient.values()].reduce((n, l) => n + l.length, 0),
      patientId: firstPatient, at: date,
    });
    const bodyText = htmlToText(html);
    for (const [patientId, threadKey] of patients) {
      await storeMessage({
        patientId, threadKey, messageId, inReplyTo, references, direction: 'out', mailboxUserId: user.id,
        from: { name: mailbox.displayName || null, address: mailbox.emailAddress },
        to: rcpt.to, cc: rcpt.cc, subject, bodyText, sentAt: date, source: 'hms_send',
        documentIds: idsByPatient.get(patientId) || [], attachmentNames,
        linkedById: linkPatients.some((l) => l.patientId === patientId) ? user.id : null,
      });
    }
    for (const p of linkPatients) {
      accounts.logEvent({
        userId: user.id, actorId: user.id, patientId: p.patientId, event: 'linked_to_patient',
        detail: JSON.stringify({ messages: 1, how: 'composer' }),
      });
    }
    return [...patients.keys()];
  } catch (err) {
    console.error('[Mail] patient thread not recorded after send:', err.code || err.name || err.message);
    return [];
  }
};

// ---- reading a message's text (checker + link) -----------------------------

/** Plain text of a fetched message (text part, else HTML → text). Never throws. */
const messageText = async (client, uid, bodyStructure) => {
  try {
    const parts = walkParts(bodyStructure);
    const part = parts.text || parts.html;
    if (!part) return { text: '', attachments: parts.attachments };
    const { content } = await client.download(String(uid), part.part, { uid: true, maxBytes: MAX_TEXT_BYTES });
    const chunks = [];
    let size = 0;
    for await (const c of content) { chunks.push(c); size += c.length; if (size > MAX_TEXT_BYTES) break; }
    const raw = Buffer.concat(chunks).toString('utf8');
    return { text: parts.text ? raw : htmlToText(raw), attachments: parts.attachments };
  } catch {
    return { text: '', attachments: [] };
  }
};

const HEADER_FIELDS = ['references', 'in-reply-to'];
const headerValue = (buf, name) => {
  const raw = buf ? buf.toString('utf8') : '';
  const m = raw.match(new RegExp(`(?:^|\\n)${name}:([\\s\\S]*?)(?=\\r?\\n\\S|\\s*$)`, 'i'));
  return m ? m[1].replace(/\r?\n\s+/g, ' ').trim() : '';
};

/**
 * Handle one message the checker found (INBOX = 'in', Sent = 'out'): the
 * traffic row, and — when it replies into a patient thread — the message on
 * that thread. Used by services/mailSync.
 */
const ingestMessage = async (client, { userId, ownAddress, folder, uidValidity, msg, direction }) => {
  const env = msg.envelope || {};
  const messageId = cleanId(env.messageId) || syntheticId(userId, folder, uidValidity, msg.uid);
  if (direction === 'out' && await trafficExists(userId, 'out', messageId)) return { skipped: true };   // sent from the HMS — handled at send
  const references = headerValue(msg.headers, 'references');
  const inReplyTo = cleanId(env.inReplyTo) || cleanId(headerValue(msg.headers, 'in-reply-to'));
  const patients = await patientsForIds(idList(inReplyTo, references));
  const from = (env.from && env.from[0]) || null;
  const to = env.to || []; const cc = env.cc || []; const bcc = env.bcc || [];
  const counterpart = direction === 'in' ? (from ? [from] : []) : [...to, ...cc, ...bcc];
  const attachmentsMeta = walkParts(msg.bodyStructure).attachments;
  await recordTraffic({
    userId, direction, via: 'elsewhere', messageId, addresses: counterpart,
    attachmentCount: attachmentsMeta.length, patientId: patients.size ? [...patients.keys()][0] : null,
    at: msg.internalDate || env.date || new Date(),
  });
  if (!patients.size) return { stored: 0 };
  const { text } = await messageText(client, msg.uid, msg.bodyStructure);
  let stored = 0;
  for (const [patientId, threadKey] of patients) {
    const { created } = await storeMessage({
      patientId, threadKey, messageId, inReplyTo, references, direction, mailboxUserId: userId,
      from: from ? { name: from.name, address: from.address } : { address: ownAddress }, to, cc,
      subject: env.subject || '', bodyText: text, sentAt: env.date || msg.internalDate || new Date(),
      source: direction === 'in' ? 'reply' : 'sent_elsewhere',
      attachmentNames: attachmentsMeta.filter((a) => a.filename),
    });
    if (created) stored += 1;
  }
  return { stored };
};

// ---- "Link to patient" (My mail) --------------------------------------------

/** Search one folder of the caller's mailbox for messages in this conversation. */
const findInFolder = async (userId, folder, ids) => session.withFolder(userId, folder, async (client) => {
  const uids = new Set();
  for (const id of ids.slice(0, 15)) {
    for (const q of [{ header: { 'message-id': id } }, { header: { references: id } }, { header: { 'in-reply-to': id } }]) {
      try { (await client.search(q, { uid: true }) || []).forEach((u) => uids.add(u)); } catch { /* server refused a header search */ }
    }
  }
  if (!uids.size) return [];
  // Collect first, THEN read each text: a download issued while a FETCH is
  // still streaming waits behind it forever (imapflow runs one command at a time).
  const msgs = [];
  for await (const msg of client.fetch([...uids].slice(0, MAX_LINK_MESSAGES).join(','), {
    uid: true, envelope: true, internalDate: true, bodyStructure: true, headers: HEADER_FIELDS,
  }, { uid: true })) msgs.push(msg);
  const out = [];
  for (const msg of msgs) {
    const { text } = await messageText(client, msg.uid, msg.bodyStructure);
    out.push({ folder: client.mailbox.path, msg, text, uidValidity: client.mailbox.uidValidity });
  }
  return out;
});

/**
 * POST /api/mail/messages/:uid/link-patient { folder, uhid, scope }
 * Put this message — or its whole conversation (this folder + INBOX + Sent) —
 * on the patient's Communications trail. The caller's OWN mailbox only.
 */
const linkToPatient = async (user, { folder = 'INBOX', uid, uhid, scope = 'thread' }) => {
  const r = gateResult(user, LINK_GATE);
  if (r !== 'ok') {
    throw new MailError('FORBIDDEN', r === 'denied'
      ? 'You do not have permission to add emails to a patient\'s communications — an administrator has withdrawn this from your account.'
      : 'You do not have permission to add emails to a patient\'s communications.', 403);
  }
  const family = await resolvePatient(String(uhid || '').trim());
  if (!family) throw new MailError('NOT_FOUND', 'Patient not found.', 404);
  if (family.isDeactivated) {
    const into = await Patient.findByPk(family.patient.mergedIntoId, { attributes: ['uhid'] });
    throw new MailError('MERGED', `This file was merged into ${into ? into.uhid : 'another file'}. Link to that one instead.`, 409);
  }
  const account = await accounts.findForUser(user.id);
  const own = account ? String(account.emailAddress).toLowerCase() : '';
  const id = session.cleanUid(uid);

  // The message itself (read without marking it read).
  const first = await session.withFolder(user.id, String(folder), async (client) => {
    const msg = await client.fetchOne(String(id), { uid: true, envelope: true, internalDate: true, bodyStructure: true, headers: HEADER_FIELDS }, { uid: true });
    if (!msg) throw new MailError('NOT_FOUND', 'That message is no longer in this folder.', 404);
    const { text } = await messageText(client, msg.uid, msg.bodyStructure);
    return { folder: client.mailbox.path, msg, text, uidValidity: client.mailbox.uidValidity };
  });
  let found = [first];
  if (scope === 'thread') {
    const env = first.msg.envelope || {};
    const ids = idList(env.messageId, env.inReplyTo, headerValue(first.msg.headers, 'references'));
    const folders = [...new Set([first.folder, 'INBOX', await session.specialFolder(user.id, 'sent')].filter(Boolean))];
    for (const f of folders) {
      try { found.push(...await findInFolder(user.id, f, ids)); } catch { /* a folder we cannot open is skipped */ }
    }
  }
  // One per Message-ID, oldest first, capped.
  const seen = new Set();
  found = found.filter((x) => {
    const mid = cleanId(x.msg.envelope && x.msg.envelope.messageId) || `${x.folder}:${x.msg.uid}`;
    if (seen.has(mid)) return false;
    seen.add(mid); return true;
  }).sort((a, b) => new Date(a.msg.internalDate || 0) - new Date(b.msg.internalDate || 0)).slice(0, MAX_LINK_MESSAGES);

  const threadKey = threadKeyOf({
    messageId: cleanId(found[0].msg.envelope && found[0].msg.envelope.messageId) || syntheticId(user.id, found[0].folder, 0, found[0].msg.uid),
    references: headerValue(found[0].msg.headers, 'references'),
    inReplyTo: found[0].msg.envelope && found[0].msg.envelope.inReplyTo,
  });
  const existing = await patientsForIds(found.map((x) => cleanId(x.msg.envelope && x.msg.envelope.messageId)).filter(Boolean));
  const key = existing.get(family.patient.id) || threadKey;

  let added = 0; let already = 0;
  const pendingAttachments = [];
  for (const x of found) {
    const env = x.msg.envelope || {};
    const from = (env.from && env.from[0]) || null;
    const messageId = cleanId(env.messageId) || syntheticId(user.id, x.folder, x.uidValidity || 0, x.msg.uid);
    const direction = from && String(from.address || '').toLowerCase() === own ? 'out' : 'in';
    const { created, row } = await storeMessage({
      patientId: family.patient.id, threadKey: key, messageId,
      inReplyTo: env.inReplyTo, references: headerValue(x.msg.headers, 'references'),
      direction, mailboxUserId: user.id, from, to: env.to, cc: env.cc, subject: env.subject || '',
      bodyText: x.text, sentAt: env.date || x.msg.internalDate || new Date(), source: 'linked',
      attachmentNames: walkParts(x.msg.bodyStructure).attachments.filter((a) => a.filename),
      linkedById: user.id,
    });
    if (created) added += 1;
    else if (row.status === 'active') already += 1;
    if (row.status === 'active') {
      attachmentsOf(row).forEach((a, index) => {
        if (!a.documentId && SAVEABLE(a)) pendingAttachments.push({ messageRowId: row.id, index, name: a.name, type: a.type, from: from ? (from.name || from.address) : null });
      });
    }
    // Tag the traffic row (if the checker already logged it) with the patient.
    await StaffMailTraffic.update({ patientId: family.patient.id }, {
      where: { userId: user.id, messageId: String(messageId).slice(0, 255), patientId: null },
    });
  }
  const removedBefore = found.length - added - already;
  if (added) {
    accounts.logEvent({
      userId: user.id, actorId: user.id, patientId: family.patient.id, event: 'linked_to_patient',
      detail: JSON.stringify({ messages: added, how: scope === 'thread' ? 'conversation' : 'message' }),
    });
  }
  return {
    patient: { uhid: family.patient.uhid, name: fullName(family.patient) },
    added, already, removedBefore,
    // Phase 5b: what should now be saved into the patient's Documents.
    pendingAttachments,
  };
};

// ---- reading threads (patient file) ----------------------------------------

/**
 * GET /api/comms/patients/:uhid/email-threads — the patient's email threads,
 * whole merge family, active rows only, newest thread first, messages oldest
 * first within a thread. The route is gated by patientemail.view.
 */
const patientThreads = async (family, { from, to, viewer = null } = {}) => {
  const where = { patientId: { [Op.in]: family.patientIds }, status: 'active' };
  if (from || to) {
    where.sentAt = {};
    if (from) where.sentAt[Op.gte] = new Date(from);
    if (to) { const t = new Date(to); t.setHours(23, 59, 59, 999); where.sentAt[Op.lte] = t; }
  }
  const rows = await PatientEmailMessage.findAll({
    where,
    include: [
      { model: User, as: 'mailboxUser', attributes: ['id', 'firstName', 'lastName', 'role'] },
      { model: User, as: 'linkedBy', attributes: ['id', 'firstName', 'lastName'] },
    ],
    order: [['sentAt', 'ASC'], ['id', 'ASC']],
    limit: 1000,
  });
  const docIds = [...new Set(rows.flatMap((r) => [...parse(r.documentIds), ...attachmentsOf(r).map((a) => a.documentId).filter(Boolean)]))]
    .map((n) => parseInt(n, 10)).filter((n) => n > 0);
  const docs = docIds.length ? await MedicalDocument.findAll({
    where: { id: { [Op.in]: docIds } },
    attributes: ['id', 'fileName', 'fileUrl', 'filePath', 'documentCategory', 'testType', 'testDate', 'isArchived', 'status'],
  }) : [];
  const docBy = new Map(docs.map((d) => [d.id, d]));
  const docOut = (id) => {
    const d = docBy.get(parseInt(id, 10));
    if (!d) return { id, missing: true };
    return {
      id: d.id, fileName: d.fileName, category: d.documentCategory, testType: d.testType, date: d.testDate || null,
      archived: !!d.isArchived, status: d.status, fileKey: path.basename(String(d.fileUrl || d.filePath || '')),
    };
  };
  const threads = new Map();
  for (const r of rows) {
    const t = threads.get(r.threadKey) || { key: r.threadKey, subject: null, messages: [] };
    if (!t.subject && r.subject) t.subject = r.subject.replace(/^((re|fw|fwd|aw|sv)\s*:\s*)+/i, '').trim();
    t.messages.push({
      id: r.id,
      direction: r.direction,
      source: r.source,
      sentAt: r.sentAt,
      from: { name: r.fromName, address: r.fromAddress },
      to: parse(r.toList),
      cc: parse(r.ccList),
      subject: r.subject,
      text: r.bodyText || '',
      staff: r.mailboxUser ? { id: r.mailboxUser.id, name: fullName(r.mailboxUser), role: r.mailboxUser.role } : null,
      linkedBy: r.linkedBy ? { id: r.linkedBy.id, name: fullName(r.linkedBy) } : null,
      messageId: r.messageId,
      documents: parse(r.documentIds).map(docOut),
      // Phase 5b: attachments that were NOT from the file. Saved ones point at
      // their Document (opened from Documents); the rest can be saved — only
      // by the owner of the mailbox they sit in (decision D1).
      attachments: attachmentsOf(r).map((a, index) => ({
        index, name: a.name, type: a.type,
        onFile: a.documentId ? docOut(a.documentId) : null,
        saveable: !a.documentId && SAVEABLE(a),
        canSave: !a.documentId && SAVEABLE(a) && !!viewer && viewer.id === r.mailboxUserId,
      })),
      attachmentNames: attachmentsOf(r).filter((a) => !a.documentId).map((a) => a.name),
    });
    threads.set(r.threadKey, t);
  }
  return [...threads.values()]
    .map((t) => ({ ...t, lastAt: t.messages[t.messages.length - 1].sentAt, count: t.messages.length }))
    .sort((a, b) => new Date(b.lastAt) - new Date(a.lastAt));
};

/**
 * POST /api/comms/patients/:uhid/email-messages/:id/attachments/:index/save
 * { category, testDate?, notes? } — put one attachment of a patient-thread
 * email into the patient's Documents (Pending Review, like every email save).
 * The file is read from the mailbox it sits in, which only its OWNER may open
 * (D1): anyone else is told whose mailbox it is. The message is found by its
 * Message-ID across the owner's folders (it may have been archived or moved).
 */
const saveThreadAttachment = async (user, family, rowId, index, body = {}) => {
  const row = await PatientEmailMessage.findOne({ where: { id: parseInt(rowId, 10) || 0, patientId: { [Op.in]: family.patientIds }, status: 'active' } });
  if (!row) throw new MailError('NOT_FOUND', 'That email is not on this patient\'s file.', 404);
  const list = attachmentsOf(row);
  const a = list[parseInt(index, 10)];
  if (!a) throw new MailError('NOT_FOUND', 'That attachment is not on this email.', 404);
  if (a.documentId) return { documentId: a.documentId, already: true };
  if (row.mailboxUserId !== user.id) {
    const owner = row.mailboxUserId ? await User.findByPk(row.mailboxUserId, { attributes: ['firstName', 'lastName'] }) : null;
    throw new MailError('NOT_OWNER', `This attachment is in ${owner ? `${fullName(owner)}'s` : 'another person\'s'} mailbox — only they can save it to the file.`, 403);
  }
  if (String(row.messageId).endsWith('@no-message-id>')) throw new MailError('NOT_FOUND', 'This email has no Message-ID, so it cannot be found again in your mailbox. Save the attachment from My mail instead.', 409);
  // Where is it now? INBOX, Sent, Archive first, then every other folder.
  const client = await session.getClient(user.id);
  const folders = (await client.list()).map((f) => f.path);
  const order = [...new Set(['INBOX', ...folders.filter((f) => /sent|archive/i.test(f)), ...folders])];
  let where = null;
  for (const f of order) {
    try {
      where = await session.withFolder(user.id, f, async (c) => {
        const uids = await c.search({ header: { 'message-id': row.messageId } }, { uid: true });
        if (!uids || !uids.length) return null;
        const uid = uids[uids.length - 1];
        const msg = await c.fetchOne(String(uid), { uid: true, bodyStructure: true }, { uid: true });
        const parts = walkParts(msg && msg.bodyStructure).attachments;
        const part = (a.part && parts.find((p) => p.part === a.part && (!p.filename || p.filename === a.name)))
          || parts.find((p) => p.filename === a.name);
        return part ? { folder: c.mailbox.path, uid, part: part.part } : null;
      });
    } catch { where = null; }
    if (where) break;
  }
  if (!where) throw new MailError('GONE', 'That email is no longer in your mailbox (was it deleted?), so the attachment cannot be saved.', 410);
  // The My mail "Save to patient file" path — same gate, checks, Pending Review,
  // audit; it also marks this attachment as filed on the thread.
  const saved = await require('./mailPatients').saveAttachmentToPatient(user, {
    folder: where.folder, uid: where.uid, part: where.part, uhid: family.patient.uhid,
    category: body.category, testDate: body.testDate || null, notes: body.notes || null,
  });
  return saved;
};

/**
 * For My mail's reading pane: is this message on any patient's email trail,
 * and which of its attachments are not yet in their Documents? (Phase 5b —
 * the "save these to the file" prompt.) Only patients the caller may see.
 */
const threadInfoForMessage = async (user, messageId) => {
  const mid = cleanId(messageId);
  if (!mid || gateResult(user, ['doctor', 'staff', 'nurse', 'lab', 'admin']) !== 'ok') return [];
  const rows = await PatientEmailMessage.findAll({
    where: { messageId: mid, status: 'active' },
    include: [{ model: Patient, as: 'patient', attributes: ['id', 'uhid', 'firstName', 'lastName', 'mergedIntoId'] }],
  });
  return rows.filter((r) => r.patient).map((r) => ({
    uhid: r.patient.uhid,
    name: fullName(r.patient),
    pending: attachmentsOf(r).filter((a) => !a.documentId && SAVEABLE(a)).map((a) => ({ name: a.name, part: a.part })),
  }));
};

/**
 * POST /api/comms/patients/:uhid/email-messages/:id/remove { reason } — admins
 * only (route gate). Soft delete: hidden from the trail, kept with who/when/why.
 */
const removeMessage = async (user, family, id, reason) => {
  const row = await PatientEmailMessage.findOne({ where: { id: parseInt(id, 10) || 0, patientId: { [Op.in]: family.patientIds } } });
  if (!row) throw new MailError('NOT_FOUND', 'That email is not on this patient\'s file.', 404);
  if (row.status === 'removed') return { removed: true, already: true };
  const why = String(reason || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 500);
  if (why.length < 3) throw new MailError('REASON', 'Give a reason for removing this email from the file.', 400);
  await row.update({ status: 'removed', removedById: user.id, removedAt: new Date(), removedReason: why });
  accounts.logEvent({
    userId: row.mailboxUserId || null, actorId: user.id, patientId: row.patientId, event: 'patient_email_removed',
    detail: JSON.stringify({ messages: 1 }),
  });
  return { removed: true };
};

module.exports = {
  LINK_GATE,
  recordTraffic,
  patientsForIds,
  storeMessage,
  verifyLinkPatients,
  afterHmsSend,
  ingestMessage,
  linkToPatient,
  patientThreads,
  removeMessage,
  saveThreadAttachment,
  threadInfoForMessage,
  attachmentsOf,
  HEADER_FIELDS,
  _internals: { threadKeyOf, syntheticId, idList, cleanId, headerValue, MAX_BODY_CHARS },
};
