const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Op } = require('sequelize');
const db = require('../models');
const session = require('./mailSession');
const accounts = require('./mailAccounts');
const { walkParts } = require('../utils/mailRender');
const { resolvePatient } = require('../utils/patientFamily');
const { clinicToday } = require('../utils/clinicTime');
const { createMedicalDocument, DOCUMENT_CATEGORIES, PDF_ONLY_CATEGORIES } = require('../utils/medicalDocumentCreate');
const { INTERNAL_ROLES, gateResult } = require('../constants/permissions');

const { MailError } = session;
const { Patient, User, MedicalDocument, StaffMailAccount } = db;

// ---------------------------------------------------------------------------
// Staff Email (B26) phase 3a — the HMS / patient tie-ins.
//
//   1. Recipient suggestions: people you recently wrote to (live from your own
//      Sent folder, cached in memory), staff, and — for roles that can open
//      patient files — patients, collapsed to the surviving file of any merge.
//   2. Attach from a patient file: MedicalDocuments of the patient's whole
//      merge family, read from disk on the server at send time. A draft
//      carries them BY REFERENCE (a header), never as a copy inside one.com.
//   3. Save an attachment to a patient file: the Lab Inbox path —
//      resolvePatient + createMedicalDocument, Pending Review, JWT attribution.
//
// Gates mirror the routes they stand in for, via gateResult (the pure form of
// authorize), so a withdrawn capability or a narrowed role list follows here
// automatically:
//   patient suggestions + search  = GET /api/patients     (every internal role)
//   read a patient's documents    = GET /api/documents    (internal + documents.write)
//   save to a patient's file      = POST /api/documents   (doctor/staff/admin + documents.write)
//
// Audit: metadata only (D1). StaffMailEvents rows carry patientId + counts +
// recipient domains — never addresses, subjects, bodies or file names.
// ---------------------------------------------------------------------------

const PATIENT_VIEW = [...INTERNAL_ROLES];
const DOCUMENT_VIEW = [...INTERNAL_ROLES, 'documents.write'];
const DOCUMENT_WRITE = ['doctor', 'staff', 'admin', 'documents.write'];

const BACKEND_ROOT = path.join(__dirname, '..');
const DOCUMENTS_DIR = path.join(BACKEND_ROOT, 'uploads', 'documents');
const MAX_SAVE_BYTES = 25 * 1024 * 1024;

const requireGate = (user, allow, what) => {
  const r = gateResult(user, allow);
  if (r === 'ok') return;
  throw new MailError('FORBIDDEN', r === 'denied'
    ? `You do not have permission to ${what} — an administrator has withdrawn this from your account.`
    : `You do not have permission to ${what}.`, 403);
};

const canSeePatients = (user) => gateResult(user, PATIENT_VIEW) === 'ok';

// dateOfBirth is a DATE column: a Date object from the driver, or a string
// from a raw query — take the year from either.
const yearOf = (d) => {
  if (!d) return null;
  if (d instanceof Date) return Number.isNaN(d.getTime()) ? null : String(d.getFullYear());
  const m = String(d).match(/^(\d{4})-/);
  return m ? m[1] : null;
};
const fullName = (p) => `${p.firstName || ''} ${p.lastName || ''}`.trim();
const escapeLike = (s) => String(s).replace(/[\\%_]/g, (c) => `\\${c}`);

// ---- patient search (name / UHID / phone / email / ID) ---------------------

/**
 * Find patients by any of name, UHID, phone, email or national ID, collapsed
 * to the canonical file of each merge family (a match on a merged-away record
 * surfaces the file it was merged into, once). The canonical file's email is
 * used; if it has none, one from the family is borrowed so a duplicate that
 * held the address still makes the patient reachable.
 *
 * Plain LIKE matching: misspellings are not found. (B25's fuzzy matcher lives
 * on another branch; point this at utils/patientMatch once B25 is deployed.)
 */
const searchPatients = async (q, { limit = 8 } = {}) => {
  const text = String(q || '').trim().slice(0, 80);
  if (text.length < 2) return [];
  const like = `%${escapeLike(text)}%`;
  const digits = text.replace(/\D/g, '');
  const or = [
    { firstName: { [Op.like]: like } },
    { lastName: { [Op.like]: like } },
    { uhid: { [Op.like]: like } },
    { email: { [Op.like]: like } },
    { idNumber: { [Op.like]: like } },
    { phone: { [Op.like]: like } },
  ];
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    or.push({ [Op.and]: [
      { firstName: { [Op.like]: `%${escapeLike(words[0])}%` } },
      { lastName: { [Op.like]: `%${escapeLike(words.slice(1).join(' '))}%` } },
    ] });
  }
  // UHIDs are typed with or without their hyphen ("cdc001" / "CDC-001").
  const compact = text.replace(/[\s-]+/g, '');
  if (compact.length >= 3) {
    or.push(db.sequelize.where(
      db.sequelize.fn('REPLACE', db.sequelize.col('uhid'), '-', ''),
      { [Op.like]: `%${escapeLike(compact)}%` },
    ));
  }
  // Phones are stored with spaces/dashes/+254 in every combination.
  if (digits.length >= 4) {
    const tail = digits.replace(/^(254|0)/, '');
    or.push(db.sequelize.where(
      db.sequelize.fn('REPLACE', db.sequelize.fn('REPLACE', db.sequelize.col('phone'), ' ', ''), '-', ''),
      { [Op.like]: `%${escapeLike(tail || digits)}%` },
    ));
  }
  const hits = await Patient.findAll({
    where: { [Op.or]: or },
    attributes: ['id', 'mergedIntoId', 'email'],
    limit: 60,
    order: [['updatedAt', 'DESC']],
  });
  if (!hits.length) return [];

  const order = [];
  const borrowed = new Map();   // canonical id -> an email from a merged-away hit
  for (const h of hits) {
    const canonical = h.mergedIntoId || h.id;
    if (!order.includes(canonical)) order.push(canonical);
    if (h.mergedIntoId && h.email && !borrowed.has(canonical)) borrowed.set(canonical, h.email);
  }
  const ids = order.slice(0, limit);
  const rows = await Patient.findAll({
    where: { id: { [Op.in]: ids }, mergedIntoId: null },
    attributes: ['id', 'uhid', 'firstName', 'lastName', 'dateOfBirth', 'phone', 'email'],
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter(Boolean).map((p) => ({
    uhid: p.uhid,
    name: fullName(p),
    yearOfBirth: yearOf(p.dateOfBirth),
    phone: p.phone || null,
    email: (p.email || borrowed.get(p.id) || '').trim().toLowerCase() || null,
  }));
};

// ---- 1. recipient suggestions ----------------------------------------------

const staffAddressFor = (u, account, domains) => {
  if (account && account.status !== 'disconnected') return account.emailAddress;
  const email = String(u.email || '').toLowerCase();
  const domain = email.split('@')[1];
  return domain && domains.includes(domain) ? email : null;
};

/** GET /api/mail/suggest?q= → { recent, staff, patients, patientsShown } */
const suggestRecipients = async (user, q) => {
  const text = String(q || '').trim().slice(0, 80);
  if (text.length < 2) return { recent: [], staff: [], patients: [], patientsShown: canSeePatients(user) };
  const needle = text.toLowerCase();
  const domains = await session.allowedDomains();

  let recent = [];
  try {
    recent = (await session.recentRecipients(user.id))
      .filter((r) => r.address.includes(needle) || (r.name || '').toLowerCase().includes(needle))
      .slice(0, 5)
      .map(({ name, address }) => ({ name, address }));
  } catch {
    recent = [];   // suggestions must never fail because Sent couldn't be read
  }

  const like = `%${escapeLike(text)}%`;
  const users = await User.findAll({
    where: {
      id: { [Op.ne]: user.id },
      role: { [Op.in]: INTERNAL_ROLES },
      isActive: true,
      [Op.or]: [
        { firstName: { [Op.like]: like } },
        { lastName: { [Op.like]: like } },
        { email: { [Op.like]: like } },
        db.sequelize.where(db.sequelize.fn('CONCAT', db.sequelize.col('firstName'), ' ', db.sequelize.col('lastName')), { [Op.like]: like }),
      ],
    },
    attributes: ['id', 'firstName', 'lastName', 'email', 'role'],
    include: [{ model: db.StaffProfile, attributes: ['position'], required: false }],
    limit: 12,
  });
  const mailAccounts = users.length ? await StaffMailAccount.findAll({
    where: { userId: { [Op.in]: users.map((u) => u.id) } },
    attributes: ['userId', 'emailAddress', 'status'],
  }) : [];
  const accountBy = new Map(mailAccounts.map((a) => [a.userId, a]));
  const staff = users
    .map((u) => ({ name: fullName(u), address: staffAddressFor(u, accountBy.get(u.id), domains), title: (u.StaffProfile && u.StaffProfile.position) || u.role }))
    .filter((s) => s.address)
    .slice(0, 6);

  const patientsShown = canSeePatients(user);
  const patients = patientsShown
    ? (await searchPatients(text, { limit: 6 })).map((p) => ({
      name: p.name, address: p.email, uhid: p.uhid, yearOfBirth: p.yearOfBirth,
    }))
    : [];

  // Each address appears once. Who someone IS wins over having written to
  // them: a patient keeps their UHID row (and the Patient tag on the chip), a
  // colleague their Staff row; Recent only lists everyone else.
  const seen = new Set();
  const patientsOut = patients.filter((p) => !p.address || (!seen.has(p.address) && seen.add(p.address)));
  const staffOut = staff.filter((st) => !seen.has(st.address) && seen.add(st.address));
  const recentOut = recent.filter((r) => !seen.has(r.address) && seen.add(r.address));
  return { recent: recentOut, staff: staffOut, patients: patientsOut, patientsShown };
};

// ---- 2. attach from a patient file -----------------------------------------

/** GET /api/mail/patients?q= — the patient picker (no emails needed here). */
const pickPatients = async (user, q) => {
  requireGate(user, DOCUMENT_VIEW, "open patients' documents");
  return (await searchPatients(q, { limit: 8 })).map(({ uhid, name, yearOfBirth, phone }) => ({ uhid, name, yearOfBirth, phone }));
};

/** A stored document's file, resolved safely inside uploads/documents. */
const documentFile = (doc) => {
  const rel = String(doc.filePath || '');
  const abs = path.isAbsolute(rel) ? rel : path.join(BACKEND_ROOT, rel);
  const resolved = path.resolve(abs);
  if (!resolved.startsWith(DOCUMENTS_DIR + path.sep)) return null;
  return fs.existsSync(resolved) ? resolved : null;
};

const TYPES = { '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };
const typeOf = (name) => TYPES[path.extname(String(name || '')).toLowerCase()] || 'application/octet-stream';

/** GET /api/mail/patients/:uhid/documents — the patient's whole merge family. */
const patientDocuments = async (user, uhid) => {
  requireGate(user, DOCUMENT_VIEW, "open patients' documents");
  const family = await resolvePatient(String(uhid || ''));
  if (!family) throw new MailError('NOT_FOUND', 'Patient not found.', 404);
  if (family.isDeactivated) {
    const into = await Patient.findByPk(family.patient.mergedIntoId, { attributes: ['uhid'] });
    throw new MailError('MERGED', `This file was merged into ${into ? into.uhid : 'another file'}. Open that one instead.`, 409);
  }
  const docs = await MedicalDocument.findAll({
    where: { PatientId: { [Op.in]: family.patientIds }, isArchived: false },
    include: [{ model: Patient, attributes: ['uhid'] }],
    order: [['createdAt', 'DESC']],
  });
  const p = family.patient;
  return {
    patient: { uhid: p.uhid, name: fullName(p), yearOfBirth: yearOf(p.dateOfBirth) },
    mergedUhids: [...new Set(docs.map((d) => d.Patient && d.Patient.uhid).filter((u) => u && u !== p.uhid))],
    documents: docs.map((d) => {
      const file = documentFile(d);
      return {
        id: d.id,
        fileName: d.fileName,
        category: d.documentCategory,
        testType: d.testType || null,
        date: d.testDate || (d.createdAt ? new Date(d.createdAt).toISOString().slice(0, 10) : null),
        status: d.status,
        type: typeOf(d.fileName),
        size: file ? fs.statSync(file).size : null,
        available: !!file,
        // For "Preview": the stored name GET /api/documents/file/:filename
        // serves (same gate as reading the patient's documents).
        fileKey: file ? path.basename(String(d.fileUrl || d.filePath || '')) : null,
        fromUhid: d.Patient ? d.Patient.uhid : null,
      };
    }),
  };
};

const cleanDocIds = (list) => [...new Set((Array.isArray(list) ? list : [])
  .map((v) => parseInt(typeof v === 'object' && v ? v.documentId : v, 10))
  .filter((n) => n > 0))].slice(0, 20);

/**
 * Documents to attach, checked afresh at send/draft time: the gate, not
 * archived, file on disk. Returns { refs, attachments, byPatient } — byPatient
 * maps the CANONICAL patient id to how many of its documents are attached.
 * `withContent` false for drafts (they carry references, not copies).
 */
const loadPatientDocuments = async (user, ids, { withContent = true } = {}) => {
  const clean = cleanDocIds(ids);
  if (!clean.length) return { refs: [], attachments: [], byPatient: new Map() };
  requireGate(user, DOCUMENT_VIEW, "attach documents from a patient's file");
  const docs = await MedicalDocument.findAll({
    where: { id: { [Op.in]: clean }, isArchived: false },
    include: [{ model: Patient, attributes: ['id', 'uhid', 'firstName', 'lastName', 'mergedIntoId'] }],
  });
  if (docs.length !== clean.length) {
    throw new MailError('ATTACH_GONE', 'A document from a patient file is no longer available. Remove it and attach it again.', 409);
  }
  // Label every document with the SURVIVING file of its merge family, so a
  // chip shows the same patient the picker did.
  const mergedInto = [...new Set(docs.map((d) => d.Patient && d.Patient.mergedIntoId).filter(Boolean))];
  const canonicalRows = mergedInto.length
    ? await Patient.findAll({ where: { id: { [Op.in]: mergedInto } }, attributes: ['id', 'uhid', 'firstName', 'lastName'] })
    : [];
  const canonicalBy = new Map(canonicalRows.map((p) => [p.id, p]));
  const labelOf = (d) => (d.Patient && d.Patient.mergedIntoId ? canonicalBy.get(d.Patient.mergedIntoId) : d.Patient) || d.Patient;

  const refs = [];
  const attachments = [];
  const byPatient = new Map();
  for (const id of clean) {
    const d = docs.find((x) => x.id === id);
    const file = documentFile(d);
    if (!file) throw new MailError('ATTACH_GONE', `The file for "${d.fileName}" is missing on the server. Remove it and try again.`, 409);
    const size = fs.statSync(file).size;
    const canonical = d.Patient ? (d.Patient.mergedIntoId || d.Patient.id) : null;
    if (canonical) byPatient.set(canonical, (byPatient.get(canonical) || 0) + 1);
    const label = labelOf(d);
    refs.push({
      documentId: d.id, fileName: d.fileName, type: typeOf(d.fileName), size,
      uhid: label ? label.uhid : null, patientName: label ? fullName(label) : null,
    });
    if (withContent) {
      attachments.push({
        filename: String(d.fileName || 'document').replace(/[\r\n"\\/]/g, '_').slice(0, 200),
        contentType: typeOf(d.fileName),
        content: fs.readFileSync(file),
      });
    }
  }
  return { refs, attachments, byPatient };
};

/** One audit row per patient whose documents went out. */
const logPatientDocumentsSent = (user, byPatient, summary, emailAddress) => {
  for (const [patientId, count] of byPatient.entries()) {
    accounts.logEvent({
      userId: user.id, actorId: user.id, patientId, event: 'patient_docs_sent', emailAddress,
      detail: JSON.stringify({ documents: count, recipients: summary.count, domains: summary.domains }),
    });
  }
};

// ---- 3. save an attachment to a patient file -------------------------------

const MAGIC = [
  { type: 'application/pdf', ext: '.pdf', test: (b) => b.slice(0, 5).toString('latin1') === '%PDF-' },
  { type: 'image/jpeg', ext: '.jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: 'image/png', ext: '.png', test: (b) => b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
];

/**
 * POST /api/mail/messages/:uid/attachments/:part/save-to-patient
 * { folder, uhid, category, testDate?, notes? }
 * The file is taken from the user's OWN mailbox, checked by content (PDF, JPEG
 * or PNG only — the same types a manual upload accepts), copied into the
 * documents store and filed exactly as a Lab Inbox pairing is: Pending Review
 * for everyone, attributed to the signed-in user.
 */
const saveAttachmentToPatient = async (user, { folder, uid, part, uhid, category, testDate, notes }) => {
  requireGate(user, DOCUMENT_WRITE, "add documents to a patient's file");
  const documentCategory = String(category || 'Lab Report - External');
  if (!DOCUMENT_CATEGORIES.includes(documentCategory)) throw new MailError('BAD_CATEGORY', 'Pick a document category.', 400);
  if (testDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(testDate)) throw new MailError('BAD_DATE', 'Invalid test date. Use YYYY-MM-DD.', 400);
    if (testDate > clinicToday()) throw new MailError('BAD_DATE', 'Test date cannot be in the future.', 400);
  }
  const noteText = notes ? String(notes).slice(0, 5000) : null;
  if (!/^[0-9]+(\.[0-9]+)*$/.test(String(part || ''))) throw new MailError('BAD_PART', 'That attachment could not be found.', 400);

  const family = await resolvePatient(String(uhid || ''));
  if (!family) throw new MailError('NOT_FOUND', 'Patient not found.', 404);
  if (family.isDeactivated) throw new MailError('INACTIVE', 'This patient profile is inactive. Documents cannot be filed to it.', 403);

  const id = session.cleanUid(uid);
  const { meta, content, senderDomain } = await session.withFolder(user.id, String(folder || 'INBOX'), async (client) => {
    const msg = await client.fetchOne(String(id), { uid: true, bodyStructure: true, envelope: true }, { uid: true });
    if (!msg) throw new MailError('NOT_FOUND', 'That message is no longer in this folder.', 404);
    const found = walkParts(msg.bodyStructure).attachments.find((a) => a.part === String(part));
    if (!found) throw new MailError('NOT_FOUND', 'That attachment is no longer on the message.', 404);
    if (found.size && found.size > MAX_SAVE_BYTES * 1.4) throw new MailError('TOO_BIG', 'That attachment is larger than 25 MB.', 413);
    const buf = await session.downloadPart(client, id, String(part), MAX_SAVE_BYTES + 1);
    const from = ((msg.envelope && msg.envelope.from) || [])[0];
    return { meta: found, content: buf, senderDomain: from && from.address ? String(from.address).split('@')[1] || null : null };
  });
  if (content.length > MAX_SAVE_BYTES) throw new MailError('TOO_BIG', 'That attachment is larger than 25 MB.', 413);

  const kind = MAGIC.find((m) => m.test(content));
  if (!kind) throw new MailError('BAD_TYPE', 'Only PDF, JPEG and PNG files can be saved to a patient file.', 415);
  if (PDF_ONLY_CATEGORIES.includes(documentCategory) && kind.type !== 'application/pdf') {
    throw new MailError('BAD_TYPE', `${documentCategory} only accepts PDF files.`, 415);
  }

  if (!fs.existsSync(DOCUMENTS_DIR)) fs.mkdirSync(DOCUMENTS_DIR, { recursive: true });
  const filename = crypto.randomBytes(16).toString('hex') + kind.ext;
  fs.writeFileSync(path.join(DOCUMENTS_DIR, filename), content);

  let originalName = String(meta.filename || `attachment${kind.ext}`).replace(/[\r\n"\\/]/g, '_').slice(0, 250);
  if (path.extname(originalName).toLowerCase() !== kind.ext && !(kind.ext === '.jpg' && /\.jpe?g$/i.test(originalName))) {
    originalName += kind.ext;
  }

  let document;
  try {
    document = await createMedicalDocument({
      patient: family.patient,
      actingUser: user,
      file: { originalName, filename, size: content.length },
      documentCategory,
      testDate: testDate || null,
      notes: noteText ? `Saved from email. ${noteText}` : 'Saved from email.',
      status: 'Pending Review',   // like a Lab Inbox pairing — always awaits review, doctors included
    });
  } catch (err) {
    fs.promises.unlink(path.join(DOCUMENTS_DIR, filename)).catch(() => {});
    throw err;
  }

  accounts.logEvent({
    userId: user.id, actorId: user.id, patientId: family.patient.id, event: 'saved_to_patient',
    detail: JSON.stringify({ documents: 1, senderDomain }),
  });

  return {
    documentId: document.id,
    patient: { uhid: family.patient.uhid, name: fullName(family.patient) },
    category: documentCategory,
    status: document.status,
  };
};

module.exports = {
  PATIENT_VIEW,
  DOCUMENT_VIEW,
  DOCUMENT_WRITE,
  canSeePatients,
  searchPatients,
  suggestRecipients,
  pickPatients,
  patientDocuments,
  loadPatientDocuments,
  logPatientDocumentsSent,
  saveAttachmentToPatient,
  _internals: { cleanDocIds, documentFile, MAGIC, DOCUMENTS_DIR, yearOf },
};
