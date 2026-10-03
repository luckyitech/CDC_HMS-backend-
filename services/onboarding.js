// Onboarding checklists — the DB side (HR Tier 3 Phase 3; decisions T3-4 = a,
// O-1…O-8). The ONE place a checklist is started, read, ticked or closed;
// the rules are pure in utils/onboarding.
//
// Facts an automatic item watches are read live from the staff file every time
// (factsFor / factsForMany), so the checklist can never disagree with the file.
// Lists ask the hr.onboarding scope through services/hrScope.

const { Op } = require('sequelize');
const db = require('../models');
const { clinicToday } = require('../utils/clinicTime');
const { toList, PERMISSIONS } = require('../constants/permissions');
const { STAFF_ROLES } = require('../constants/staffRoles');
const { isoDay } = require('../utils/expiry');
const R = require('../utils/onboarding');
const hrScope = require('./hrScope');

const {
  User, StaffProfile, StaffDocument, UserDevice, UserLoginLog,
  OnboardingTemplateItem, OnboardingChecklist, OnboardingItem,
} = db;

class OnboardingError extends Error {
  constructor(message, code, status = 400) { super(message); this.code = code; this.status = status; }
}

const fullName = (u) => (u ? `${u.firstName || ''} ${u.lastName || ''}`.trim() : null);

/** The template lines for a role (active, in order). */
const templateFor = (role, { transaction } = {}) => OnboardingTemplateItem.findAll({
  where: { role, status: 'active' }, order: [['sortOrder', 'ASC'], ['id', 'ASC']], transaction,
});

/**
 * The facts automatic items watch, for many people at once.
 * @returns Map userId → { contract, national_id, licence, photo, phone, permissions, department, first_login }
 */
const factsForMany = async (userIds) => {
  const ids = [...new Set(userIds.map(Number).filter(Boolean))];
  const out = new Map(ids.map((id) => [id, Object.fromEntries(R.AUTO_KEYS.map((k) => [k, false]))]));
  if (!ids.length) return out;
  const now = new Date();
  const [users, profiles, docs, devices, logins] = await Promise.all([
    User.findAll({ where: { id: { [Op.in]: ids } }, attributes: ['id', 'permissions'] }),
    StaffProfile.findAll({ where: { UserId: { [Op.in]: ids } }, attributes: ['UserId', 'photoUrl', 'licenseNumber', 'licenseExpiry', 'departmentId', 'positionId'] }),
    StaffDocument.findAll({
      where: { UserId: { [Op.in]: ids }, isArchived: false, category: { [Op.in]: ['Employment Contract', 'National ID', 'Practising Licence'] } },
      attributes: ['UserId', 'category'],
    }),
    UserDevice.findAll({ where: { UserId: { [Op.in]: ids }, revokedAt: null, expiresAt: { [Op.gt]: now } }, attributes: ['UserId'] }),
    UserLoginLog.findAll({ where: { userId: { [Op.in]: ids } }, attributes: ['userId'], group: ['userId'], raw: true }),
  ]);
  users.forEach((u) => { out.get(u.id).permissions = toList(u.permissions).length > 0; });
  profiles.forEach((p) => {
    const f = out.get(Number(p.UserId));
    f.photo = !!p.photoUrl;
    f.licence = f.licence || (!!p.licenseNumber && !!isoDay(p.licenseExpiry));
    f.department = !!p.departmentId && !!p.positionId;
  });
  docs.forEach((d) => {
    const f = out.get(Number(d.UserId));
    if (d.category === 'Employment Contract') f.contract = true;
    if (d.category === 'National ID') f.national_id = true;
    if (d.category === 'Practising Licence') f.licence = true;
  });
  devices.forEach((d) => { out.get(Number(d.UserId)).phone = true; });
  logins.forEach((l) => { const f = out.get(Number(l.userId)); if (f) f.first_login = true; });
  return out;
};
const factsFor = async (userId) => (await factsForMany([userId])).get(Number(userId));

const ITEM_INCLUDE = [{ model: User, as: 'doneBy', attributes: ['id', 'firstName', 'lastName'] }];

const loadChecklist = (where, { transaction } = {}) => OnboardingChecklist.findOne({
  where,
  include: [{ model: OnboardingItem, as: 'items', required: false, include: ITEM_INCLUDE }],
  order: [['id', 'DESC'], [{ model: OnboardingItem, as: 'items' }, 'sortOrder', 'ASC'], [{ model: OnboardingItem, as: 'items' }, 'id', 'ASC']],
  transaction,
});

/** A checklist as the client sees it. */
const shape = (c, facts, today) => {
  const items = (c.items || []).filter((i) => i.status !== 'removed').map((i) => {
    const s = R.itemState(i, facts, today);
    return {
      id: i.id,
      label: i.label,
      autoKey: i.autoKey,
      hint: i.autoKey ? R.AUTO_ITEMS[i.autoKey]?.hint || null : null,
      auto: s.auto,
      done: s.done,
      overdue: s.overdue,
      dueDate: i.dueDate ? String(i.dueDate).slice(0, 10) : null,
      doneAt: i.autoKey ? null : i.doneAt,
      doneBy: i.autoKey ? null : (i.doneBy ? fullName(i.doneBy) : null),
      note: i.note,
    };
  });
  return {
    id: c.id,
    status: c.status,
    role: c.role,
    startDate: c.startDate ? String(c.startDate).slice(0, 10) : null,
    startedAt: c.createdAt,
    completedAt: c.completedAt,
    closedNote: c.closedNote,
    progress: R.progress(c.items || [], facts, today),
    items,
  };
};

/** Marks an open checklist complete once every item is done (O-5). */
const settle = async (c, facts, today) => {
  if (c.status !== 'open') return c;
  if (R.progress(c.items || [], facts, today).complete) {
    await c.update({ status: 'complete', completedAt: new Date() });
  }
  return c;
};

/**
 * Start a checklist from the role's template. Used by the wizard (inside its
 * transaction) and the staff file's Start button. Refuses a second open one.
 * @returns the new checklist, or null when the role's template is empty and
 *          `quietIfEmpty` (the wizard's case)
 */
const startFor = async ({ userId, role, startDate, actorId, transaction, quietIfEmpty = false }) => {
  const open = await OnboardingChecklist.findOne({ where: { UserId: userId, status: 'open' }, transaction });
  if (open) throw new OnboardingError('An onboarding checklist is already in progress', 'ALREADY_OPEN', 409);
  const lines = await templateFor(role, { transaction });
  if (!lines.length) {
    if (quietIfEmpty) return null;
    throw new OnboardingError(`There is no onboarding template for this role yet — add items under HR Suite → Onboarding → Templates`, 'NO_TEMPLATE', 400);
  }
  const today = clinicToday();
  const start = isoDay(startDate) || today;
  const c = await OnboardingChecklist.create({ UserId: userId, role, startDate: start, status: 'open', createdById: actorId }, { transaction });
  await OnboardingItem.bulkCreate(lines.map((l) => ({
    checklistId: c.id, label: l.label, autoKey: l.autoKey, sortOrder: l.sortOrder,
    dueDate: R.dueDateFor(l.dueDays, start, today), status: 'active', addedById: actorId,
  })), { transaction });
  return c;
};

/** The person's checklist: the open one, else their most recent; null if none. */
const currentFor = async (userId) => {
  const open = await loadChecklist({ UserId: userId, status: 'open' });
  const c = open || await loadChecklist({ UserId: userId });
  if (!c) return null;
  const today = clinicToday();
  const facts = await factsFor(userId);
  await settle(c, facts, today);
  return shape(c, facts, today);
};

const openChecklistOf = async (userId) => {
  const c = await loadChecklist({ UserId: userId, status: 'open' });
  if (!c) throw new OnboardingError('No onboarding checklist in progress', 'NOT_OPEN', 404);
  return c;
};

/** Tick / untick / note / remove one item of the person's open checklist. */
const updateItem = async ({ userId, itemId, body, actorId }) => {
  const c = await openChecklistOf(userId);
  const it = (c.items || []).find((i) => i.id === Number(itemId) && i.status !== 'removed');
  if (!it) throw new OnboardingError('Item not found', 'NOT_FOUND', 404);
  const patch = {};
  if (body.done !== undefined) {
    if (it.autoKey) throw new OnboardingError('This item ticks itself from the staff file', 'AUTOMATIC', 400);
    patch.doneAt = body.done ? new Date() : null;
    patch.doneById = body.done ? actorId : null;
  }
  if (body.note !== undefined) patch.note = body.note ? String(body.note).trim().slice(0, 500) || null : null;
  if (body.remove === true) patch.status = 'removed';
  if (!Object.keys(patch).length) throw new OnboardingError('Nothing to change', 'NO_CHANGE', 400);
  await it.update(patch);
  return currentFor(userId);
};

/** A one-off item on this person's open checklist only. */
const addItem = async ({ userId, body, actorId }) => {
  const c = await openChecklistOf(userId);
  const label = typeof body.label === 'string' ? body.label.trim() : '';
  if (label.length < 2) throw new OnboardingError('Give the item a name', 'LABEL_REQUIRED', 400);
  const due = body.dueDate ? isoDay(body.dueDate) : null;
  if (body.dueDate && !due) throw new OnboardingError('Due date must be a date', 'BAD_DATE', 400);
  const last = Math.max(0, ...(c.items || []).map((i) => i.sortOrder || 0));
  await OnboardingItem.create({
    checklistId: c.id, label: label.slice(0, 160), autoKey: null, dueDate: due, sortOrder: last + 10, status: 'active', addedById: actorId,
  });
  return currentFor(userId);
};

/** Close an open checklist early (note required), or reopen a closed one. */
const setStatus = async ({ userId, action, note, actorId }) => {
  if (action === 'close') {
    const c = await openChecklistOf(userId);
    const text = typeof note === 'string' ? note.trim() : '';
    if (text.length < 3) throw new OnboardingError('Say why you are closing it', 'NOTE_REQUIRED', 400);
    await c.update({ status: 'closed', closedNote: text.slice(0, 500), closedById: actorId });
  } else if (action === 'reopen') {
    if (await OnboardingChecklist.findOne({ where: { UserId: userId, status: 'open' } })) {
      throw new OnboardingError('An onboarding checklist is already in progress', 'ALREADY_OPEN', 409);
    }
    const c = await loadChecklist({ UserId: userId, status: 'closed' });
    if (!c) throw new OnboardingError('No closed checklist to reopen', 'NOT_FOUND', 404);
    await c.update({ status: 'open', closedNote: null, closedById: null });
  } else {
    throw new OnboardingError('Choose close or reopen', 'BAD_ACTION', 400);
  }
  return currentFor(userId);
};

/**
 * The checklists the viewer may see (hr.onboarding scope).
 * @param status 'open' (default) | 'all'
 */
const listFor = async (user, { status = 'open' } = {}) => {
  const where = status === 'all' ? {} : { status: 'open' };
  Object.assign(where, await hrScope.scopeWhere(user, PERMISSIONS.HR_ONBOARDING));
  const rows = await OnboardingChecklist.findAll({
    where,
    include: [
      { model: OnboardingItem, as: 'items', required: false, attributes: ['id', 'autoKey', 'doneAt', 'dueDate', 'status'] },
      {
        model: User, attributes: ['id', 'firstName', 'lastName', 'role'], where: { role: { [Op.in]: STAFF_ROLES } },
        include: [{ model: StaffProfile, attributes: ['employeeId', 'department', 'position'], required: false }],
      },
    ],
    order: [['createdAt', 'DESC']],
  });
  const today = clinicToday();
  const facts = await factsForMany(rows.map((r) => r.UserId));
  const out = [];
  for (const r of rows) {
    const f = facts.get(Number(r.UserId));
    await settle(r, f, today);
    const pr = R.progress(r.items || [], f, today);
    const next = (r.items || []).filter((i) => i.status !== 'removed' && !R.itemState(i, f, today).done && i.dueDate)
      .map((i) => String(i.dueDate).slice(0, 10)).sort()[0] || null;
    out.push({
      id: r.id,
      status: r.status,
      startDate: r.startDate ? String(r.startDate).slice(0, 10) : null,
      completedAt: r.completedAt,
      person: {
        id: r.User.id, name: fullName(r.User), role: r.User.role,
        employeeId: r.User.StaffProfile?.employeeId || null,
        department: r.User.StaffProfile?.department || null,
        position: r.User.StaffProfile?.position || null,
      },
      progress: pr,
      nextDue: next,
    });
  }
  return status === 'all' ? out : out.filter((r) => r.status === 'open');
};

/** How many open checklists the viewer may see (HR dashboard). */
const openCount = async (user) => (await listFor(user)).length;

module.exports = {
  OnboardingError, templateFor, factsFor, factsForMany, startFor, currentFor, updateItem, addItem, setStatus, listFor, openCount,
};
