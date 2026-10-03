// Appraisals — the DB side (HR Tier 3 Phase 5; mockup E; T3-9 a, T3-10 a).
// The ONE place an appraisal is started, read, saved or moved on; the rules
// (who sees what, the walk, cleaning) are pure in utils/appraisals.
//
//   Runners (hr.appraisals.run, department-scopable) open the year's window,
//   add people in their reach, choose reviewers, skip a self-assessment,
//   return or cancel one. They see WHO is at WHICH step — never the content.
//   The window's dates and the competencies need an All-staff runner.
//
//   Readers (canReadAppraisals: an explicit hr.appraisals grant or the true
//   admin — never admin.access) read every appraisal, clinic-wide.
//
//   The person and their reviewer act on it through /api/hr/appraisals/:id;
//   anyone without a role on it gets 404 (utils/appraisals roleOf).
//
// Alerts (hrNotify appraisal_*) never carry a rating or a comment.

const { Op } = require('sequelize');
const db = require('../models');
const { PERMISSIONS, canReadAppraisals, passesAdminGate, INTERNAL_ROLES } = require('../constants/permissions');
const { clinicToday } = require('../utils/clinicTime');
const { getHrConfig } = require('../utils/hrConfig');
const A = require('../utils/appraisals');
const hrScope = require('./hrScope');
const hrNotify = require('./hrNotify');
const { writeUserEditLog, monthSummaryFor, workHoursRowsFor } = require('./hrAttendanceService');

const {
  sequelize, User, StaffProfile, AppraisalCompetency, AppraisalCycle, Appraisal, AppraisalRating, AppraisalObjective,
} = db;

const RUN = PERMISSIONS.HR_APPRAISALS_RUN;

class AppraisalError extends Error {
  constructor(message, code, status = 400) { super(message); this.code = code; this.status = status; }
}

const MESSAGES = {
  NAME_REQUIRED: 'Give it a name',
  TOO_LONG: 'That is too long',
  BAD_YEAR: 'Choose a year',
  BAD_DATE: 'Dates must be YYYY-MM-DD',
  DUE_ORDER: 'The review due date must be on or after the self-assessment due date',
  BAD_ORDER: 'Order must be a whole number',
  BAD_STATUS: 'Unknown status',
  BAD_RATINGS: 'Those ratings do not belong to this appraisal',
  BAD_RATING: 'Ratings are 1 to 4',
  BAD_OBJECTIVES: 'Up to 20 objectives',
  OBJECTIVE_TEXT: 'Write the objective',
};

const fullName = (u) => (u ? `${u.firstName || ''} ${u.lastName || ''}`.trim() : null);
const clean = (result) => {
  if (result.error) throw new AppraisalError(MESSAGES[result.error] || 'Invalid', result.error);
  return result.value;
};
const notify = (event, recipients, title, link) => hrNotify.notify(event, {
  recipients, title, body: 'Open the HR Suite to see it.', link,
}).catch(() => {});

const requireAllScope = async (user) => {
  const scope = await hrScope.scopeOf(user, RUN);
  if (!scope.all) throw new AppraisalError('Only someone who runs appraisals for all staff can change this', 'NOT_ALL_STAFF', 403);
};

// ---------------------------------------------------------------------------
// Competencies (All-staff runner; readers and runners may read)
// ---------------------------------------------------------------------------

const shapeCompetency = (c) => ({ id: c.id, name: c.name, description: c.description || '', sortOrder: c.sortOrder, status: c.status });

const listCompetencies = async () => (await AppraisalCompetency.findAll({ order: [['sortOrder', 'ASC'], ['id', 'ASC']] })).map(shapeCompetency);

const createCompetency = async (user, input) => {
  await requireAllScope(user);
  const v = clean(A.cleanCompetency(input));
  const max = await AppraisalCompetency.max('sortOrder');
  return shapeCompetency(await AppraisalCompetency.create({ ...v, sortOrder: v.sortOrder ?? (Number(max) || 0) + 10, status: 'active', createdById: user.id }));
};

const updateCompetency = async (user, id, input) => {
  await requireAllScope(user);
  const row = await AppraisalCompetency.findByPk(id);
  if (!row) throw new AppraisalError('Competency not found', 'NOT_FOUND', 404);
  const v = clean(A.cleanCompetency(input, { partial: true }));
  const before = shapeCompetency(row);
  await row.update(v);
  return { before, after: shapeCompetency(row) };
};

// ---------------------------------------------------------------------------
// Cycles
// ---------------------------------------------------------------------------

const shapeCycle = (c, counts = null) => ({
  id: c.id, year: c.year, name: c.name, selfDueOn: c.selfDueOn, reviewDueOn: c.reviewDueOn, status: c.status,
  closedAt: c.closedAt, ...(counts ? { counts } : {}),
});

const listCycles = async () => {
  const cycles = await AppraisalCycle.findAll({ order: [['year', 'DESC']] });
  const rows = await Appraisal.findAll({ attributes: ['cycleId', 'status', [sequelize.fn('COUNT', sequelize.col('id')), 'n']], group: ['cycleId', 'status'], raw: true });
  return cycles.map((c) => {
    const counts = Object.fromEntries(A.STATUSES.map((s) => [s, 0]));
    rows.filter((r) => r.cycleId === c.id).forEach((r) => { counts[r.status] = Number(r.n); });
    return shapeCycle(c, counts);
  });
};

const createCycle = async (user, input) => {
  await requireAllScope(user);
  const v = clean(A.cleanCycle(input));
  if (await AppraisalCycle.findOne({ where: { year: v.year } })) throw new AppraisalError(`There is already a ${v.year} appraisal`, 'YEAR_EXISTS', 409);
  return shapeCycle(await AppraisalCycle.create({ ...v, status: 'open', createdById: user.id }));
};

const updateCycle = async (user, id, input) => {
  await requireAllScope(user);
  const row = await AppraisalCycle.findByPk(id);
  if (!row) throw new AppraisalError('Appraisal cycle not found', 'NOT_FOUND', 404);
  const { status, ...rest } = input || {};
  const v = clean(A.cleanCycle({ ...rest, year: undefined }, { partial: true }));
  delete v.year;
  const next = { ...v };
  const due = { selfDueOn: v.selfDueOn !== undefined ? v.selfDueOn : row.selfDueOn, reviewDueOn: v.reviewDueOn !== undefined ? v.reviewDueOn : row.reviewDueOn };
  if (due.selfDueOn && due.reviewDueOn && due.reviewDueOn < due.selfDueOn) throw new AppraisalError(MESSAGES.DUE_ORDER, 'DUE_ORDER');
  if (status !== undefined) {
    if (!['open', 'closed'].includes(status)) throw new AppraisalError(MESSAGES.BAD_STATUS, 'BAD_STATUS');
    next.status = status;
    if (status === 'closed' && row.status !== 'closed') { next.closedAt = new Date(); next.closedById = user.id; }
    if (status === 'open') { next.closedAt = null; next.closedById = null; }
  }
  const before = shapeCycle(row);
  await row.update(next);
  return { before, after: shapeCycle(row) };
};

/** Seeing cycles and their progress: a runner (any scope) or a reader. */
const assertCycleViewer = (user) => {
  if (!passesAdminGate(user, RUN) && !canReadAppraisals(user)) throw new AppraisalError('You do not have access to appraisal cycles', 'FORBIDDEN', 403);
};

const cycleOr404 = async (id, options = {}) => {
  const c = await AppraisalCycle.findByPk(id, options);
  if (!c) throw new AppraisalError('Appraisal cycle not found', 'NOT_FOUND', 404);
  return c;
};

// ---------------------------------------------------------------------------
// People in a cycle (runner: in scope; reader: everyone) — status only
// ---------------------------------------------------------------------------

const PERSON_INCLUDE = [
  { model: User, attributes: ['id', 'firstName', 'lastName', 'role'], include: [{ model: StaffProfile, attributes: ['employeeId', 'position', 'department', 'departmentId'], required: false }] },
  { model: User, as: 'reviewer', attributes: ['id', 'firstName', 'lastName'], required: false },
];

const shapeRow = (a) => ({
  id: a.id, status: a.status, statusLabel: A.STATUS_LABELS[a.status],
  person: {
    id: a.User?.id, name: fullName(a.User), role: a.User?.role,
    employeeId: a.User?.StaffProfile?.employeeId || null, position: a.User?.StaffProfile?.position || null, department: a.User?.StaffProfile?.department || null,
  },
  reviewer: a.reviewer ? { id: a.reviewer.id, name: fullName(a.reviewer) } : null,
  selfSubmittedAt: a.selfSubmittedAt, sentAt: a.sentAt, acknowledgedAt: a.acknowledgedAt,
});

/** The ids a viewer may list in a cycle: null = everyone (reader or All-staff runner). */
const listableIds = async (user) => {
  if (canReadAppraisals(user)) return null;
  return hrScope.userIdsInScope(user, RUN);
};

const cycleProgress = async (user, cycleId) => {
  const cycle = await cycleOr404(cycleId);
  const ids = await listableIds(user);
  const rows = await Appraisal.findAll({
    where: { cycleId: cycle.id, ...(ids === null ? {} : { UserId: { [Op.in]: ids } }) },
    include: PERSON_INCLUDE, order: [['id', 'ASC']],
  });
  const runScope = await hrScope.scopeOf(user, RUN);
  const runs = passesAdminGate(user, RUN);
  // Anyone active on the staff may review (names only, for the runner's picker).
  const reviewers = runs ? (await User.findAll({
    where: { role: { [Op.in]: INTERNAL_ROLES }, isActive: true }, attributes: ['id', 'firstName', 'lastName'], order: [['firstName', 'ASC'], ['lastName', 'ASC']],
  })).map((u) => ({ id: u.id, name: fullName(u) })) : [];
  return {
    cycle: shapeCycle(cycle),
    canRead: canReadAppraisals(user),
    canRun: runs,
    canRunAll: runScope.all,
    reviewers,
    rows: rows.map(shapeRow).sort((a, b) => (a.person.name || '').localeCompare(b.person.name || '')),
  };
};

/** Active internal staff who could be added (in the runner's reach, not themselves, not already in). */
const eligibleFor = async (user, cycleId) => {
  const ids = await hrScope.userIdsInScope(user, RUN);
  const users = await User.findAll({
    where: { role: { [Op.in]: INTERNAL_ROLES }, isActive: true, id: { [Op.ne]: user.id }, ...(ids === null ? {} : { id: { [Op.in]: ids, [Op.ne]: user.id } }) },
    attributes: ['id', 'firstName', 'lastName', 'role'],
    include: [{ model: StaffProfile, attributes: ['employeeId', 'position', 'department', 'reportsToId', 'deletedAt', 'employmentStatus'], required: false }],
    order: [['firstName', 'ASC'], ['lastName', 'ASC']],
  });
  const taken = new Set((await Appraisal.findAll({ where: { cycleId, status: { [Op.ne]: 'cancelled' } }, attributes: ['UserId'], raw: true })).map((r) => Number(r.UserId)));
  return users.filter((u) => !taken.has(u.id) && !u.StaffProfile?.deletedAt && !['Resigned', 'Terminated'].includes(u.StaffProfile?.employmentStatus));
};

const listEligible = async (user, cycleId) => {
  await cycleOr404(cycleId);
  return (await eligibleFor(user, cycleId)).map((u) => ({
    id: u.id, name: fullName(u), role: u.role, position: u.StaffProfile?.position || null, department: u.StaffProfile?.department || null,
  }));
};

/** Start appraisals for these people (or everyone eligible): ratings copied from the competencies. */
const addPeople = async (user, cycleId, { userIds = null } = {}) => {
  const cycle = await cycleOr404(cycleId);
  if (cycle.status !== 'open') throw new AppraisalError('This appraisal cycle is closed', 'CYCLE_CLOSED', 409);
  const eligible = await eligibleFor(user, cycle.id);
  const wanted = userIds === null ? eligible : eligible.filter((u) => userIds.map(Number).includes(u.id));
  if (userIds !== null && wanted.length !== new Set(userIds.map(Number)).size) {
    throw new AppraisalError('Someone chosen cannot be added (already in, out of your reach, or yourself)', 'NOT_ELIGIBLE', 400);
  }
  const comps = await AppraisalCompetency.findAll({ where: { status: 'active' }, order: [['sortOrder', 'ASC'], ['id', 'ASC']] });
  if (!comps.length) throw new AppraisalError('Add at least one competency first', 'NO_COMPETENCIES', 409);
  const active = new Set((await User.findAll({ where: { role: { [Op.in]: INTERNAL_ROLES }, isActive: true }, attributes: ['id'], raw: true })).map((u) => u.id));
  const created = [];
  const transaction = await sequelize.transaction();
  try {
    for (const u of wanted) {
      const a = await Appraisal.create({
        cycleId: cycle.id, UserId: u.id, status: 'self', createdById: user.id,
        reviewerId: A.defaultReviewer({ personId: u.id, reportsToId: u.StaffProfile?.reportsToId, activeIds: active }),
      }, { transaction });
      await AppraisalRating.bulkCreate(comps.map((c) => ({ appraisalId: a.id, competencyId: c.id, name: c.name, sortOrder: c.sortOrder })), { transaction });
      created.push(a);
    }
    await transaction.commit();
  } catch (err) {
    try { await transaction.rollback(); } catch { /* done */ }
    throw err;
  }
  for (const a of created) notify('appraisal_self', [a.UserId], `Your ${cycle.year} appraisal is open — please complete your self-assessment`, `/hr/appraisals/${a.id}`);
  return { added: created.length };
};

const activeInternal = async (id) => User.findOne({ where: { id, role: { [Op.in]: INTERNAL_ROLES }, isActive: true }, attributes: ['id', 'firstName', 'lastName'] });

/** Runner actions on one appraisal: reviewer | skipSelf | return | cancel. Never their own. */
const runnerAction = async (user, id, { action, reviewerId, note }) => {
  const a = await Appraisal.findByPk(id, { include: [{ model: AppraisalCycle, as: 'cycle' }] });
  if (!a || !(await hrScope.canActOn(user, RUN, a.UserId))) throw new AppraisalError('Appraisal not found', 'NOT_FOUND', 404);
  if (a.UserId === user.id) throw new AppraisalError('Someone else runs your own appraisal', 'OWN_APPRAISAL', 403);
  if (a.cycle.status !== 'open') throw new AppraisalError('This appraisal cycle is closed', 'CYCLE_CLOSED', 409);
  const live = A.LIVE.includes(a.status);
  let log = null;
  if (action === 'reviewer') {
    if (!live) throw new AppraisalError('This appraisal is finished', 'NOT_LIVE', 409);
    const rid = reviewerId == null || reviewerId === '' ? null : Number(reviewerId);
    if (rid !== null) {
      if (rid === a.UserId) throw new AppraisalError('Nobody reviews their own appraisal', 'SELF_REVIEWER');
      if (!(await activeInternal(rid))) throw new AppraisalError('Choose an active member of staff', 'BAD_REVIEWER');
    }
    if (a.status !== 'self' && rid === null) throw new AppraisalError('This appraisal needs a reviewer now', 'NO_REVIEWER');
    if (rid === a.reviewerId) return shapeRow(await Appraisal.findByPk(a.id, { include: PERSON_INCLUDE }));
    await a.update({ reviewerId: rid });
    log = 'reviewer changed';
    if (rid && a.status === 'review') notify('appraisal_review', [rid], 'An appraisal is waiting for your review', `/hr/appraisals/${a.id}`);
  } else if (action === 'skipSelf') {
    if (a.status !== 'self') throw new AppraisalError('Only an appraisal still at self-assessment', 'NOT_SELF');
    if (!a.reviewerId) throw new AppraisalError('Choose a reviewer first', 'NO_REVIEWER');
    await a.update({ status: 'review' });
    log = 'moved to the reviewer without a self-assessment';
    notify('appraisal_review', [a.reviewerId], 'An appraisal is waiting for your review', `/hr/appraisals/${a.id}`);
  } else if (action === 'return') {
    if (a.status !== 'sent') throw new AppraisalError('Only an appraisal waiting to be acknowledged', 'NOT_SENT');
    await a.update({ status: 'review', sentAt: null });
    log = 'returned to the reviewer';
    if (a.reviewerId) notify('appraisal_review', [a.reviewerId], 'An appraisal was returned to you for review', `/hr/appraisals/${a.id}`);
  } else if (action === 'cancel') {
    if (!live) throw new AppraisalError('This appraisal is finished', 'NOT_LIVE', 409);
    const n = String(note || '').trim();
    if (!n) throw new AppraisalError('Say why it is cancelled', 'NOTE_REQUIRED');
    await a.update({ status: 'cancelled', cancelledNote: n.slice(0, 300), cancelledById: user.id });
    log = 'cancelled';
  } else {
    throw new AppraisalError('Unknown action', 'BAD_ACTION');
  }
  await writeUserEditLog({ targetUserId: a.UserId, actor: user, changes: { appraisal: { from: null, to: `${a.cycle.year} appraisal ${log}` } } });
  return shapeRow(await Appraisal.findByPk(a.id, { include: PERSON_INCLUDE }));
};

// ---------------------------------------------------------------------------
// One appraisal — the person, the reviewer, a reader
// ---------------------------------------------------------------------------

const loadFull = (id, transaction) => Appraisal.findByPk(id, {
  include: [
    ...PERSON_INCLUDE,
    { model: AppraisalCycle, as: 'cycle' },
    { model: AppraisalRating, as: 'ratings', separate: true, order: [['sortOrder', 'ASC'], ['id', 'ASC']] },
    { model: AppraisalObjective, as: 'objectives', separate: true, order: [['sortOrder', 'ASC'], ['id', 'ASC']] },
  ],
  transaction,
});

/** The viewer's role, or 404. */
const standing = async (user, id, transaction) => {
  const a = await loadFull(id, transaction);
  const role = A.roleOf({ appraisal: a, userId: user.id, canRead: canReadAppraisals(user) });
  if (!role) throw new AppraisalError('Appraisal not found', 'NOT_FOUND', 404);
  return { a, role };
};

const present = (a, role) => {
  const plain = a.get({ plain: true });
  return {
    ...A.viewFor(plain, role),
    role,
    can: A.actionsFor(role, a.status, a.cycle.status === 'open'),
    cycle: shapeCycle(a.cycle),
    person: shapeRow(a).person,
    reviewer: a.reviewer ? { id: a.reviewer.id, name: fullName(a.reviewer) } : null,
    ratingLabels: A.RATING_LABELS,
  };
};

const getOne = async (user, id) => {
  const { a, role } = await standing(user, id);
  return present(a, role);
};

const applyRatings = async (a, side, list, transaction) => {
  for (const r of list) {
    const patch = side === 'self'
      ? { selfRating: r.rating, ...(r.comment !== undefined ? { selfComment: r.comment || null } : {}) }
      : { reviewerRating: r.rating, ...(r.comment !== undefined ? { reviewerComment: r.comment || null } : {}) };
    await AppraisalRating.update(patch, { where: { id: r.id, appraisalId: a.id }, transaction });
  }
};

/** The person's self-assessment: save a draft, or submit it to the reviewer. */
const saveSelf = async (user, id, body = {}) => {
  const transaction = await sequelize.transaction();
  let submitted = null;
  try {
    const { a, role } = await standing(user, id, transaction);
    if (!A.actionsFor(role, a.status, a.cycle.status === 'open').editSelf) throw new AppraisalError('Your self-assessment cannot be changed now', 'NOT_EDITABLE', 409);
    const ratings = clean(A.cleanRatings(body.ratings, 'self', a.ratings.map((r) => r.id)));
    await applyRatings(a, 'self', ratings, transaction);
    const patch = {};
    if (body.selfSummary !== undefined) {
      if (String(body.selfSummary).length > 4000) throw new AppraisalError(MESSAGES.TOO_LONG, 'TOO_LONG');
      patch.selfSummary = String(body.selfSummary).trim() || null;
    }
    if (body.submit) {
      const fresh = await AppraisalRating.findAll({ where: { appraisalId: a.id }, transaction });
      if (!A.allRated(fresh.map((r) => r.get({ plain: true })), 'self')) throw new AppraisalError('Rate every competency before you submit', 'NOT_RATED');
      if (!a.reviewerId) throw new AppraisalError('HR has not chosen your reviewer yet — your answers are saved; submit once they have', 'NO_REVIEWER', 409);
      Object.assign(patch, { status: 'review', selfSubmittedAt: new Date() });
      submitted = a.reviewerId;
    }
    if (Object.keys(patch).length) await a.update(patch, { transaction });
    await transaction.commit();
  } catch (err) {
    try { await transaction.rollback(); } catch { /* done */ }
    throw err;
  }
  if (submitted) notify('appraisal_review', [submitted], 'An appraisal is waiting for your review', `/hr/appraisals/${id}`);
  return getOne(user, id);
};

/** The reviewer: save a draft, or send it to the person. */
const saveReview = async (user, id, body = {}) => {
  const transaction = await sequelize.transaction();
  let sentTo = null;
  try {
    const { a, role } = await standing(user, id, transaction);
    if (!A.actionsFor(role, a.status, a.cycle.status === 'open').editReview) throw new AppraisalError('This review cannot be changed now', 'NOT_EDITABLE', 409);
    const ratings = clean(A.cleanRatings(body.ratings, 'reviewer', a.ratings.map((r) => r.id)));
    const objectives = clean(A.cleanObjectives(body.objectives));
    await applyRatings(a, 'reviewer', ratings, transaction);
    const known = new Map(a.objectives.map((o) => [o.id, o]));
    let order = a.objectives.reduce((m, o) => Math.max(m, o.sortOrder), 0);
    for (const o of objectives) {
      if (o.id) {
        const row = known.get(o.id);
        if (!row || row.status === 'removed') throw new AppraisalError(MESSAGES.BAD_OBJECTIVES, 'BAD_OBJECTIVES');
        await row.update(o.remove ? { status: 'removed' } : { text: o.text, dueBy: o.dueBy }, { transaction });
      } else if (!o.remove) {
        order += 10;
        await AppraisalObjective.create({ appraisalId: a.id, text: o.text, dueBy: o.dueBy, sortOrder: order, status: 'active', addedById: user.id }, { transaction });
      }
    }
    const patch = {};
    if (body.reviewerSummary !== undefined) {
      if (String(body.reviewerSummary).length > 4000) throw new AppraisalError(MESSAGES.TOO_LONG, 'TOO_LONG');
      patch.reviewerSummary = String(body.reviewerSummary).trim() || null;
    }
    if (body.meetingOn !== undefined) {
      if (body.meetingOn && !/^\d{4}-\d{2}-\d{2}$/.test(String(body.meetingOn))) throw new AppraisalError(MESSAGES.BAD_DATE, 'BAD_DATE');
      patch.meetingOn = body.meetingOn || null;
    }
    if (body.send) {
      const fresh = await AppraisalRating.findAll({ where: { appraisalId: a.id }, transaction });
      if (!A.allRated(fresh.map((r) => r.get({ plain: true })), 'reviewer')) throw new AppraisalError('Rate every competency before you send it', 'NOT_RATED');
      Object.assign(patch, { status: 'sent', sentAt: new Date() });
      sentTo = a.UserId;
    }
    if (Object.keys(patch).length) await a.update(patch, { transaction });
    await transaction.commit();
  } catch (err) {
    try { await transaction.rollback(); } catch { /* done */ }
    throw err;
  }
  if (sentTo) notify('appraisal_sent', [sentTo], 'Your appraisal is ready to read and acknowledge', `/hr/appraisals/${id}`);
  return getOne(user, id);
};

/** The person reads it, may comment, and acknowledges — locked for good. */
const acknowledge = async (user, id, body = {}) => {
  const { a, role } = await standing(user, id);
  if (!A.actionsFor(role, a.status, a.cycle.status === 'open').acknowledge) throw new AppraisalError('This appraisal cannot be acknowledged now', 'NOT_EDITABLE', 409);
  const comment = String(body.personComment ?? '').trim();
  if (comment.length > 4000) throw new AppraisalError(MESSAGES.TOO_LONG, 'TOO_LONG');
  await a.update({ status: 'acknowledged', acknowledgedAt: new Date(), personComment: comment || null });
  if (a.reviewerId) notify('appraisal_acknowledged', [a.reviewerId], `${fullName(a.User)} has acknowledged their appraisal`, `/hr/appraisals/${a.id}`);
  return getOne(user, id);
};

/**
 * For reference beside the form (mockup E): the person's attendance this
 * year to date and their CPD. Same figures they see themselves — no leave.
 */
const reference = async (user, id) => {
  const { a } = await standing(user, id);
  const year = a.cycle.year;
  const today = clinicToday();
  const lastMonth = String(year) < today.slice(0, 4) ? 12 : (String(year) === today.slice(0, 4) ? Number(today.slice(5, 7)) : 0);
  const cfg = await getHrConfig();
  const rows = await workHoursRowsFor(a.UserId);
  const att = { workingDays: 0, worked: 0, late: 0, earlyOut: 0, missedCheckouts: 0, green: 0, gold: 0, red: 0 };
  for (let m = 1; m <= lastMonth; m++) {
    const s = await monthSummaryFor(a.UserId, `${year}-${String(m).padStart(2, '0')}`, cfg, { rows });
    att.workingDays += s.table.workingDays.soFar;
    att.worked += s.table.workingDays.worked;
    att.late += s.table.lateCount;
    att.earlyOut += s.table.earlyOutCount;
    att.missedCheckouts += s.table.missedCheckouts;
    att.green += s.stars.all.green; att.gold += s.stars.all.gold; att.red += s.stars.all.red;
  }
  // Required here (not at the top) to keep the controller → service direction one-way at load.
  const { yearFor } = require('../controllers/cpdController');
  const person = await User.findByPk(a.UserId, { attributes: ['id', 'role'] });
  const cpd = await yearFor(person, year);
  return { year, months: lastMonth, attendance: att, cpd: cpd.summary };
};

// ---------------------------------------------------------------------------
// Mine: my own appraisals, and the ones I review
// ---------------------------------------------------------------------------

const mine = async (user) => {
  const [own, reviewing] = await Promise.all([
    Appraisal.findAll({ where: { UserId: user.id, status: { [Op.ne]: 'cancelled' } }, include: [...PERSON_INCLUDE, { model: AppraisalCycle, as: 'cycle' }], order: [['id', 'DESC']] }),
    Appraisal.findAll({ where: { reviewerId: user.id, status: { [Op.in]: ['self', 'review', 'sent', 'acknowledged'] } }, include: [...PERSON_INCLUDE, { model: AppraisalCycle, as: 'cycle' }], order: [['id', 'DESC']] }),
  ]);
  const withCycle = (a) => ({ ...shapeRow(a), cycle: shapeCycle(a.cycle) });
  return {
    mine: own.map(withCycle),
    reviewing: reviewing.filter((a) => a.UserId !== user.id).map(withCycle),
    toReview: reviewing.filter((a) => a.status === 'review' && a.cycle.status === 'open').length,
    toDo: own.filter((a) => ['self', 'sent'].includes(a.status) && a.cycle.status === 'open').length,
  };
};

module.exports = {
  AppraisalError,
  listCompetencies, createCompetency, updateCompetency,
  assertCycleViewer, listCycles, createCycle, updateCycle, cycleProgress, listEligible, addPeople, runnerAction,
  getOne, saveSelf, saveReview, acknowledge, reference, mine,
};
