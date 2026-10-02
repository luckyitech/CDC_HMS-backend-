// My profile (self) and profile change requests (HR) — B27 phase 4, decision D11.
//
// Self (/api/hr/me, routes/hrSelf.js, hr.self): read my record, save my own
// contact details directly, and ask HR to change what I may not edit myself.
// Every self action is on req.user.id — no route names a person.
//
// HR (/api/hr/change-requests, routes/hr.js, hr.profile.approve): the queue of
// requests, and approve / reject. An approved change is written to the staff
// file exactly as an edit on the staff file is (UserEditLog, who and what),
// and the person is told. Nobody decides their own request.
//
// The rules are pure: utils/profileChange.

const { Op } = require('sequelize');
const { success, error } = require('../utils/response');
const { buildChanges } = require('../utils/auditChanges');
const { clinicToday } = require('../utils/clinicTime');
const {
  REQUESTABLE, validateRequest, cleanContact, currentValue, todoItems,
} = require('../utils/profileChange');
const { OPEN_STATUSES } = require('../utils/leaveWorkflow');
const { parseJsonColumn } = require('../utils/jsonColumn');
const { formatStaff } = require('./staffController');
const hrNotify = require('../services/hrNotify');
const hrScope = require('../services/hrScope');
const { PERMISSIONS } = require('../constants/permissions');
const { resolveStoredFile } = require('../utils/staffDocumentStorage');
const leaveService = require('../services/leaveService');
const db = require('../models');
const sequelize = require('../config/database');

const { User, StaffProfile, StaffChangeRequest, StaffDocument, StaffLeave, UserEditLog } = db;

const SECRET = ['password', 'resetToken', 'resetTokenExpires'];
const EXPIRY_WINDOW_DAYS = 60;
const fullName = (u) => (u ? `${u.firstName} ${u.lastName}`.trim() : null);

// The self view of the staff file: the same shape the staff file uses, minus
// the access internals (the Permissions tab never shows in My profile).
const ACCESS_KEYS = ['permissions', 'deniedPermissions', 'effectivePermissions', 'defaultPermissions',
  'canHoldPermissions', 'isTrueAdmin', 'passwordChangedAt'];
const selfShape = (profile, user) => {
  const s = formatStaff(profile, user);
  for (const k of ACCESS_KEYS) delete s[k];
  return s;
};

const loadMine = (userId) => StaffProfile.findOne({
  where: { UserId: userId },
  include: [{ model: User, attributes: { exclude: SECRET } }],
});

const requestShape = (r) => ({
  id: r.id,
  field: r.field,
  label: REQUESTABLE[r.field]?.label || r.field,
  oldValue: r.oldValue,
  newValue: r.newValue,
  reason: r.reason,
  status: r.status,
  createdAt: r.createdAt,
  decidedAt: r.decidedAt,
  decisionNote: r.decisionNote,
  decidedBy: r.decidedBy ? fullName(r.decidedBy) : null,
  attachment: r.attachment ? { id: r.attachment.id, fileName: r.attachment.fileName } : null,
  person: r.User ? {
    id: r.User.id,
    name: fullName(r.User),
    role: r.User.role,
    employeeId: r.User.StaffProfile?.employeeId || null,
  } : undefined,
});

const requestIncludes = (withPerson = false) => [
  { model: User, as: 'decidedBy', attributes: ['firstName', 'lastName'] },
  { model: StaffDocument, as: 'attachment', attributes: ['id', 'fileName'], required: false },
  ...(withPerson ? [{ model: User, attributes: ['id', 'firstName', 'lastName', 'role'], include: [{ model: StaffProfile, attributes: ['employeeId'] }] }] : []),
];

// ---------------------------------------------------------------------------
// Self
// ---------------------------------------------------------------------------

/** GET /api/hr/me — my record, my pending change requests, my to-do list. */
const me = async (req, res) => {
  try {
    const profile = await loadMine(req.user.id);
    if (!profile || profile.deletedAt) {
      return error(res, 'You don\'t have a staff file yet — ask HR to set one up.', 404, { code: 'NO_STAFF_FILE' });
    }
    const user = profile.User;
    const today = clinicToday();
    const soon = new Date(`${today}T00:00:00Z`);
    soon.setUTCDate(soon.getUTCDate() + EXPIRY_WINDOW_DAYS);

    const [requests, docs, leaves, typeList] = await Promise.all([
      StaffChangeRequest.findAll({ where: { UserId: user.id }, include: requestIncludes(), order: [['createdAt', 'DESC']], limit: 50 }),
      StaffDocument.findAll({
        where: { UserId: user.id, isArchived: false, visibility: 'Staff', expiryDate: { [Op.ne]: null, [Op.lte]: soon.toISOString().slice(0, 10) } },
        attributes: ['id', 'fileName', 'category', 'expiryDate'],
      }),
      StaffLeave.findAll({ where: { UserId: user.id, status: { [Op.in]: OPEN_STATUSES } }, attributes: ['id', 'status', 'leaveType', 'startDate', 'breakdown', 'attachmentDocumentId'] }),
      leaveService.listTypes({ includeRetired: true }),
    ]);
    const typeNames = Object.fromEntries(typeList.map((t) => [t.key, t.name]));
    const days = (d) => Math.ceil((new Date(d).getTime() - new Date(`${today}T00:00:00Z`).getTime()) / 86400000);
    const shaped = selfShape(profile, user);

    return success(res, {
      profile: shaped,
      requests: requests.map(requestShape),
      requestable: Object.entries(REQUESTABLE).map(([key, d]) => ({ key, label: d.label, type: d.type, options: d.options || null })),
      todo: todoItems({
        licence: { licenceExpiresInDays: shaped.licenceExpiresInDays },
        documents: docs.map((d) => ({ id: d.id, fileName: d.fileName, category: d.category, expiresInDays: days(d.expiryDate) })),
        leave: leaves.map((l) => ({
          id: l.id, status: l.status, startDate: String(l.startDate).slice(0, 10),
          typeName: typeNames[l.leaveType] || l.leaveType,
          owed: !!parseJsonColumn(l.breakdown)?.documentNeeded && !l.attachmentDocumentId,
        })),
        pendingChanges: requests.filter((r) => r.status === 'pending').length,
      }),
    });
  } catch (err) {
    console.error('SelfProfile.me error:', err);
    return error(res, 'Failed to load your record', 500);
  }
};

/**
 * PATCH /api/hr/me/contact { phone?, address?, city?, emergencyContact? }
 * Saved directly (D11) and logged in UserEditLog, as an edit on the staff
 * file is.
 */
const saveContact = async (req, res) => {
  const clean = cleanContact(req.body || {});
  if (!clean.ok) {
    return error(res, clean.error === 'BAD_PHONE' ? 'That phone number doesn\'t look right' : 'Check the emergency contact', 400, { code: clean.error });
  }
  if (!Object.keys(clean.user).length && !Object.keys(clean.profile).length) return error(res, 'No changes supplied', 400);

  try {
    const profile = await loadMine(req.user.id);
    if (!profile || profile.deletedAt) return error(res, 'You don\'t have a staff file yet', 404, { code: 'NO_STAFF_FILE' });
    const user = profile.User;

    const before = {
      phone: user.phone, address: profile.address, city: profile.city, emergencyContact: parseJsonColumn(profile.emergencyContact),
    };
    const changes = { ...buildChanges(before, clean.user), ...buildChanges(before, clean.profile) };
    if (!Object.keys(changes).length) return success(res, { profile: selfShape(profile, user), changed: [] });

    await sequelize.transaction(async (t) => {
      if (Object.keys(clean.user).length) await user.update(clean.user, { transaction: t });
      if (Object.keys(clean.profile).length) await profile.update({ ...clean.profile, updatedBy: user.id }, { transaction: t });
      await UserEditLog.create({
        targetUserId: user.id,
        editedBy: user.id,
        editedByName: `${fullName(user)} (themselves)`,
        changes,
        editedAt: new Date(),
      }, { transaction: t });
    });

    await profile.reload({ include: [{ model: User, attributes: { exclude: SECRET } }] });
    return success(res, { profile: selfShape(profile, profile.User), changed: Object.keys(changes) });
  } catch (err) {
    console.error('SelfProfile.saveContact error:', err);
    return error(res, 'Failed to save your contact details', 500);
  }
};

const REQUEST_MESSAGES = {
  FIELD_NOT_REQUESTABLE: 'That isn\'t something you can ask to change here.',
  VALUE_REQUIRED: 'Give the new value.',
  BAD_DATE: 'Choose a valid date.',
  BAD_OPTION: 'Choose one of the options.',
  BAD_NUMBER: 'Give a whole number.',
};

/** GET /api/hr/me/change-requests */
const myRequests = async (req, res) => {
  try {
    const rows = await StaffChangeRequest.findAll({ where: { UserId: req.user.id }, include: requestIncludes(), order: [['createdAt', 'DESC']], limit: 100 });
    return success(res, rows.map(requestShape));
  } catch (err) {
    console.error('SelfProfile.myRequests error:', err);
    return error(res, 'Failed to load your requests', 500);
  }
};

/**
 * POST /api/hr/me/change-requests { changes: [{ field, newValue }], reason, documentId? }
 * A supporting copy (a new ID card, a licence) is uploaded to the person's
 * Documents tab first and offered here as documentId — it must be their own,
 * live document (B27 debt fix, 2 Oct 2026). HR opens it from Profile requests
 * through GET /api/hr/change-requests/:id/attachment.
 * Holders of hr.profile.approve are told a request is waiting
 * (change_request_new) — the notice names the person and the field, never
 * the values.
 * One request per field; a field already waiting is refused (PENDING_EXISTS)
 * so HR never decides two answers to one question.
 */
const createRequests = async (req, res) => {
  const list = Array.isArray(req.body?.changes) ? req.body.changes : [];
  const reason = typeof req.body?.reason === 'string' && req.body.reason.trim() ? req.body.reason.trim().slice(0, 2000) : null;
  if (!list.length) return error(res, 'Nothing to change', 400);
  if (!reason) return error(res, 'Say why the change is needed', 400, { code: 'REASON_REQUIRED' });

  try {
    const profile = await loadMine(req.user.id);
    if (!profile || profile.deletedAt) return error(res, 'You don\'t have a staff file yet', 404, { code: 'NO_STAFF_FILE' });
    const user = profile.User;

    let attachmentDocumentId = null;
    const offered = req.body?.documentId;
    if (offered !== undefined && offered !== null && offered !== '') {
      const doc = await StaffDocument.findOne({ where: { id: Number(offered), UserId: user.id, isArchived: false } });
      if (!doc) return error(res, 'That document is not one of yours.', 400, { code: 'BAD_DOCUMENT' });
      attachmentDocumentId = doc.id;
    }

    const rows = [];
    const seen = new Set();
    for (const c of list) {
      const field = String(c?.field || '');
      if (seen.has(field)) continue;
      seen.add(field);
      const v = validateRequest(field, c?.newValue);
      if (!v.ok) return error(res, `${REQUESTABLE[field]?.label || field}: ${REQUEST_MESSAGES[v.error]}`, 400, { code: v.error, field });
      const oldValue = currentValue(field, user, profile);
      if ((oldValue ?? null) === (v.value ?? null)) continue;   // no change — nothing to ask
      rows.push({ field, oldValue, newValue: v.value });
    }
    if (!rows.length) return error(res, 'Those are the values already on your record', 400, { code: 'NO_CHANGE' });

    const pending = await StaffChangeRequest.findAll({ where: { UserId: user.id, status: 'pending', field: { [Op.in]: rows.map((r) => r.field) } }, attributes: ['field'] });
    if (pending.length) {
      const f = pending[0].field;
      return error(res, `${REQUESTABLE[f]?.label || f} already has a change waiting for HR — withdraw it first`, 409, { code: 'PENDING_EXISTS', field: f });
    }

    await StaffChangeRequest.bulkCreate(rows.map((r) => ({
      UserId: user.id, field: r.field, oldValue: r.oldValue, newValue: r.newValue, reason, status: 'pending', attachmentDocumentId,
    })));

    // HR Tier 3 Phase 1 (L-6): only deciders whose scope covers this person.
    const deciders = (await hrScope.holdersFor(PERMISSIONS.HR_PROFILE_APPROVE, user.id)).filter((id) => id !== user.id);
    const labels = rows.map((r) => (REQUESTABLE[r.field]?.label || r.field).toLowerCase());
    await hrNotify.notify('change_request_new', {
      recipients: deciders,
      title: `${fullName(user)} asked to change their ${labels.join(', ')}`,
      body: 'Open Profile requests to decide.',
      link: '/hr/requests',
      actorName: fullName(user),
    });

    const all = await StaffChangeRequest.findAll({ where: { UserId: user.id }, include: requestIncludes(), order: [['createdAt', 'DESC']], limit: 100 });
    return success(res, all.map(requestShape), 201);
  } catch (err) {
    console.error('SelfProfile.createRequests error:', err);
    return error(res, 'Failed to send your request', 500);
  }
};

/** POST /api/hr/me/change-requests/:id/withdraw — while it is still pending. */
const withdrawRequest = async (req, res) => {
  try {
    const row = await StaffChangeRequest.findOne({ where: { id: Number(req.params.id), UserId: req.user.id } });
    if (!row) return error(res, 'Request not found', 404);
    if (row.status !== 'pending') return error(res, 'Only a request still waiting can be withdrawn', 400, { code: 'NOT_PENDING' });
    await row.update({ status: 'withdrawn' });
    await row.reload({ include: requestIncludes() });
    return success(res, requestShape(row));
  } catch (err) {
    console.error('SelfProfile.withdraw error:', err);
    return error(res, 'Failed to withdraw the request', 500);
  }
};

// ---------------------------------------------------------------------------
// HR — hr.profile.approve
// ---------------------------------------------------------------------------

/** GET /api/hr/change-requests?status=pending|decided */
const hrList = async (req, res) => {
  const decided = req.query.status === 'decided';
  try {
    const rows = await StaffChangeRequest.findAll({
      where: {
        status: decided ? { [Op.in]: ['approved', 'rejected'] } : 'pending',
        ...(await hrScope.scopeWhere(req.user, PERMISSIONS.HR_PROFILE_APPROVE)),
      },
      include: requestIncludes(true),
      order: [[decided ? 'decidedAt' : 'createdAt', decided ? 'DESC' : 'ASC']],
      limit: 200,
    });
    return success(res, rows.map((r) => ({ ...requestShape(r), mine: r.UserId === req.user.id })));
  } catch (err) {
    console.error('ChangeRequest.list error:', err);
    return error(res, 'Failed to load change requests', 500);
  }
};

/** GET /api/hr/change-requests/count — pending (the sidebar badge), not counting my own. */
const hrCount = async (req, res) => {
  try {
    const scoped = await hrScope.userIdsInScope(req.user, PERMISSIONS.HR_PROFILE_APPROVE);
    const n = await StaffChangeRequest.count({ where: {
      status: 'pending',
      UserId: scoped === null ? { [Op.ne]: req.user.id } : { [Op.in]: scoped.filter((id) => id !== req.user.id) },
    } });
    return success(res, { pending: n });
  } catch (err) {
    console.error('ChangeRequest.count error:', err);
    return error(res, 'Failed to count change requests', 500);
  }
};

/**
 * PATCH /api/hr/change-requests/:id { decision: 'approve'|'reject', note }
 * Approve writes the new value to the staff file (UserEditLog, attributed to
 * the approver, naming the request). Reject needs a note. Never your own.
 */
const hrDecide = async (req, res) => {
  const decision = req.body?.decision;
  const note = typeof req.body?.note === 'string' && req.body.note.trim() ? req.body.note.trim().slice(0, 2000) : null;
  if (!['approve', 'reject'].includes(decision)) return error(res, 'Choose approve or reject', 400);
  if (decision === 'reject' && !note) return error(res, 'Say why it is rejected', 400, { code: 'NOTE_REQUIRED' });

  try {
    const row = await StaffChangeRequest.findByPk(Number(req.params.id));
    if (!row || !(await hrScope.canActOn(req.user, PERMISSIONS.HR_PROFILE_APPROVE, row.UserId))) return error(res, 'Request not found', 404);
    if (row.UserId === req.user.id) return error(res, 'Someone else must decide a change to your own record', 403, { code: 'OWN_REQUEST' });
    if (row.status !== 'pending') return error(res, 'This request has already been decided', 400, { code: 'NOT_PENDING' });
    const def = REQUESTABLE[row.field];
    if (!def) return error(res, 'That field can no longer be changed this way', 400, { code: 'FIELD_NOT_REQUESTABLE' });

    const approver = await User.findByPk(req.user.id, { attributes: ['id', 'firstName', 'lastName'] });
    const profile = await loadMine(row.UserId);
    if (decision === 'approve' && (!profile || profile.deletedAt)) return error(res, 'That staff file is archived', 409);

    await sequelize.transaction(async (t) => {
      if (decision === 'approve') {
        const user = profile.User;
        const target = def.table === 'user' ? user : profile;
        const before = { [row.field]: target[row.field] };
        const value = def.type === 'int' && row.newValue !== null ? Number(row.newValue) : row.newValue;
        await target.update({ [row.field]: value, ...(def.table === 'profile' ? { updatedBy: req.user.id } : {}) }, { transaction: t });
        const changes = buildChanges(before, { [row.field]: value });
        if (Object.keys(changes).length) {
          await UserEditLog.create({
            targetUserId: user.id,
            editedBy: req.user.id,
            editedByName: `${fullName(approver)} (change request #${row.id})`,
            changes,
            editedAt: new Date(),
          }, { transaction: t });
        }
      }
      await row.update({
        status: decision === 'approve' ? 'approved' : 'rejected',
        decidedById: req.user.id,
        decidedAt: new Date(),
        decisionNote: note,
      }, { transaction: t });
    });

    await hrNotify.notify('change_request_decided', {
      recipients: [row.UserId],
      title: decision === 'approve' ? `Your change to ${def.label.toLowerCase()} was approved` : `Your change to ${def.label.toLowerCase()} was not approved`,
      body: decision === 'approve' ? 'Your staff record has been updated.' : 'Open the HMS to see why.',
      link: '/hr/me?tab=overview',
      actorName: fullName(approver),
    });

    await row.reload({ include: requestIncludes(true) });
    return success(res, requestShape(row));
  } catch (err) {
    console.error('ChangeRequest.decide error:', err);
    return error(res, 'Failed to record the decision', 500);
  }
};

/**
 * GET /api/hr/change-requests/:id/attachment — the supporting document on a
 * change request, for hr.profile.approve (the route gate). Streams from
 * private/ like the leave attachment and the CPD certificate do.
 */
const hrAttachment = async (req, res) => {
  try {
    const row = await StaffChangeRequest.findByPk(Number(req.params.id), { include: [{ model: StaffDocument, as: 'attachment' }] });
    if (!row || !row.attachment || row.attachment.isArchived || row.attachment.UserId !== row.UserId
        || !(await hrScope.canActOn(req.user, PERMISSIONS.HR_PROFILE_APPROVE, row.UserId))) {
      return error(res, 'No document on this request', 404);
    }
    const resolved = resolveStoredFile(row.attachment.filePath);
    if (!resolved) return error(res, 'File is missing from the server', 404);
    return res.download(resolved, row.attachment.fileName);
  } catch (err) {
    console.error('ChangeRequest.attachment error:', err);
    return error(res, 'Failed to load the document', 500);
  }
};

module.exports = {
  me,
  saveContact,
  myRequests,
  createRequests,
  withdrawRequest,
  hrList,
  hrCount,
  hrDecide,
  hrAttachment,
  // tests
  selfShape,
  ACCESS_KEYS,
};
