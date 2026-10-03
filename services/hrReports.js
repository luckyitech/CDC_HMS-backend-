// HR reports — the DB side (HR Tier 3 Phase 2; mockup B, decisions T3-3,
// R-1…R-8). Loads the people the viewer may report on (their hr.reports scope,
// through services/hrScope — out of scope simply isn't counted), then asks the
// pure rules in utils/hrReports. Every figure reuses the calculation the rest
// of the HR Suite already shows:
//   leave owed   → leaveService.summaryFor (the staff file's balances)
//   CPD          → utils/cpd summariseCpd + the HR CPD targets
//   punctuality  → hrAttendanceService.monthSummaryFor (the "My stars" card)
//   expiries     → utils/expiry, the same reads as the expiry reminders
// Departments are read from StaffProfile.departmentId, never the display text.

const { Op } = require('sequelize');
const db = require('../models');
const { clinicToday } = require('../utils/clinicTime');
const { getHrConfig } = require('../utils/hrConfig');
const { PERMISSIONS } = require('../constants/permissions');
const { STAFF_ROLES } = require('../constants/staffRoles');
const { summariseCpd, cadreForRole } = require('../utils/cpd');
const { isHealthDocument } = require('../utils/hrAccess');
const R = require('../utils/hrReports');
const hrScope = require('./hrScope');
const leaveService = require('./leaveService');
const attendance = require('./hrAttendanceService');

const { User, StaffProfile, Department, CpdActivity, StaffDocument, StaffWorkHours } = db;

const fullName = (u) => `${u.firstName || ''} ${u.lastName || ''}`.trim();

/** A few at a time: each person is a handful of small queries. */
const inBatches = async (items, fn, size = 5) => {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(...await Promise.all(items.slice(i, i + size).map(fn)));
  return out;
};

/**
 * Everyone the viewer may report on — internal accounts, active or not (the
 * leavers count in "movement"), limited to their hr.reports scope.
 */
const peopleInScope = async (user) => {
  const ids = await hrScope.userIdsInScope(user, PERMISSIONS.HR_REPORTS);
  if (Array.isArray(ids) && !ids.length) return [];
  const where = { role: { [Op.in]: STAFF_ROLES } };
  if (ids) where.id = { [Op.in]: ids };
  const users = await User.findAll({
    where,
    attributes: ['id', 'firstName', 'lastName', 'role', 'isActive'],
    include: [{
      model: StaffProfile,
      required: false,
      attributes: ['employeeId', 'departmentId', 'position', 'startDate', 'endDate', 'employmentStatus', 'deletedAt', 'licenseExpiry', 'licenseNumber', 'licenseBody'],
    }],
    order: [['firstName', 'ASC'], ['lastName', 'ASC']],
  });
  return users.map((u) => ({
    id: u.id,
    name: fullName(u),
    role: u.role,
    isActive: !!u.isActive,
    profile: u.StaffProfile ? u.StaffProfile.get({ plain: true }) : null,
    departmentId: u.StaffProfile?.departmentId ?? null,
    employeeId: u.StaffProfile?.employeeId || null,
    position: u.StaffProfile?.position || null,
  }));
};

const departmentNames = async () => {
  const rows = await Department.findAll({ attributes: ['id', 'name'], raw: true });
  return rows;
};

/** The person fields every report row starts with. */
const personCols = (p, names) => ({
  id: p.id,
  name: p.name,
  employeeId: p.employeeId,
  role: p.role,
  position: p.position,
  department: p.departmentId ? (names.get(Number(p.departmentId)) || null) : null,
});

/** Leave owed (Annual) per person + the sick total (R-3, R-8). */
const leaveReport = async (people, year, today, names) => {
  const policy = await leaveService.loadPolicy(year);
  const asOf = year === Number(today.slice(0, 4)) ? today : `${year}-12-31`;
  let sickDays = 0;
  const rows = await inBatches(people, async (p) => {
    const { summary } = await leaveService.summaryFor(p.id, year, asOf, { policy });
    sickDays += R.privateTaken(summary, leaveService.PRIVATE_TYPES);
    return { ...personCols(p, names), departmentId: p.departmentId, annual: R.annualLine(summary) };
  });
  return {
    year,
    asOf,
    policyStatus: policy ? 'published' : 'none',
    people: rows,
    sick: R.sickTotal(sickDays, people.length),
  };
};

/** CPD per person with a target (R-5). */
const cpdReport = async (people, year, today, names) => {
  const cfg = await getHrConfig();
  const targets = cfg.cpdTargets || {};
  const ids = people.map((p) => p.id);
  const acts = ids.length ? await CpdActivity.findAll({
    where: { UserId: { [Op.in]: ids }, status: { [Op.ne]: 'archived' }, date: { [Op.between]: [`${year}-01-01`, `${year}-12-31`] } },
    attributes: ['UserId', 'status', 'points'],
    raw: true,
  }) : [];
  const byUser = new Map();
  acts.forEach((a) => { const l = byUser.get(Number(a.UserId)) || []; l.push(a); byUser.set(Number(a.UserId), l); });
  const rows = people.map((p) => {
    const target = Number(targets[cadreForRole(p.role)] || 0);
    const s = R.cpdStanding(summariseCpd(byUser.get(p.id) || [], target), year, today);
    return { ...personCols(p, names), ...s };
  }).filter((r) => r.status !== 'no_target');
  return { year, people: rows };
};

/** Licences and staff-visible documents expired or expiring (R-6). */
const expiryReport = async (people, today, window, names) => {
  const byId = new Map(people.map((p) => [p.id, p]));
  const items = [];
  for (const p of people) {
    if (p.profile?.licenseExpiry) {
      items.push({
        ...personCols(p, names), kind: 'licence',
        item: `Practising licence${p.profile.licenseBody ? ` (${p.profile.licenseBody})` : ''}`,
        expiryDate: p.profile.licenseExpiry,
      });
    }
  }
  if (people.length) {
    const docs = await StaffDocument.findAll({
      where: { UserId: { [Op.in]: [...byId.keys()] }, isArchived: false, visibility: 'Staff', expiryDate: { [Op.ne]: null } },
      attributes: ['id', 'UserId', 'category', 'fileName', 'expiryDate'],
    });
    for (const d of docs) {
      if (isHealthDocument(d)) continue;   // a sick note is never listed
      items.push({
        ...personCols(byId.get(Number(d.UserId)), names), kind: 'document',
        item: d.category || d.fileName || 'Document', expiryDate: d.expiryDate,
      });
    }
  }
  return { window, rows: R.expiryRows(items, today, window) };
};

/** One month's punctuality per person (R-4). */
const punctualityReport = async (people, month, names) => {
  const cfg = await getHrConfig();
  const ids = people.map((p) => p.id);
  const hourRows = ids.length
    ? await StaffWorkHours.findAll({ where: { UserId: { [Op.in]: ids }, status: 'active' } })
    : [];
  const hoursBy = new Map();
  hourRows.forEach((r) => { const l = hoursBy.get(r.UserId) || []; l.push(r.get({ plain: true })); hoursBy.set(r.UserId, l); });
  const rows = await inBatches(people, async (p) => {
    const summary = await attendance.monthSummaryFor(p.id, month, cfg, { rows: hoursBy.get(p.id) || [] });
    return { ...personCols(p, names), ...R.punctualityLine(summary) };
  });
  return { month, people: rows };
};

/**
 * Everything on the Reports page for the viewer.
 * @param opts { year, month, window }
 */
const build = async (user, { year, month, window } = {}) => {
  const today = clinicToday();
  const y = Number(year) || Number(today.slice(0, 4));
  const m = /^\d{4}-\d{2}$/.test(month || '') ? month : today.slice(0, 7);
  const w = R.cleanWindow(window);

  const [all, departments] = await Promise.all([peopleInScope(user), departmentNames()]);
  const names = new Map(departments.map((d) => [Number(d.id), d.name]));
  const employed = all.filter((p) => R.isEmployed(p, today));

  const [leave, cpd, expiries, punctuality] = await Promise.all([
    leaveReport(employed, y, today, names),
    cpdReport(employed, y, today, names),
    expiryReport(employed, today, w, names),
    punctualityReport(employed.filter((p) => p.profile?.employmentStatus !== 'Suspended'), m, names),
  ]);

  const owedBy = new Map(leave.people.map((p) => [p.id, p.annual?.owed || 0]));
  const headcount = R.headcountTable(employed.map((p) => ({ ...p, leaveOwed: owedBy.get(p.id) || 0 })), departments);
  headcount.suspended = employed.filter((p) => p.profile?.employmentStatus === 'Suspended').length;
  const mv = R.movement(all, y);
  const movement = {
    year: y,
    joined: mv.joined.map((p) => ({ ...personCols(p, names), date: p.date })),
    left: mv.left.map((p) => ({ ...personCols(p, names), date: p.date })),
  };

  const reports = { headcount, movement, leave, expiries, cpd, punctuality };
  return {
    today,
    year: y,
    month: m,
    window: w,
    cadres: R.CADRES,
    windows: R.EXPIRY_WINDOWS,
    people: employed.length,
    tiles: R.tiles(reports),
    ...reports,
  };
};

module.exports = { build, peopleInScope };
