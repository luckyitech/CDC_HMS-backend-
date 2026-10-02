// Team leave calendar — B27 phase 5 (decision D12; 29 Sep 2026).
// GET /api/leave/calendar?from&to&cadre  (PARTICIPATE — every internal role)
//
// A month grid of who is away. Approved leave shows green, pending amber, public
// holidays "H", weekend days (weight 0) hatched. Names and dates are always
// visible so staff can arrange cover — but the LEAVE TYPE is health-sensitive:
//
//   - leave.view holders see the real type of every leave except a private
//     one; leave.sick holders see private types too (HR Tier 3 split —
//     leave.manage carries both, so its holders see exactly what they did).
//   - everyone else sees the type only for the types HR ticked on the "team
//     calendar" setting; any other type shows as "Away" (dates only).
//   - Sick (and any PRIVATE_TYPES) is LOCKED private: it is never on the toggle
//     and always shows as "Away" to anyone without leave.sick — showing it to
//     the whole clinic would disclose health data (spec §11).
//
// Reuses leaveService.holidayMap / PRIVATE_TYPES / listTypes / loadPolicy — no
// new leave logic here.

const { Op } = require('sequelize');
const { success, error } = require('../utils/response');
const { clinicToday } = require('../utils/clinicTime');
const { datesInRange, DEFAULT_WEEK_WEIGHTS } = require('../utils/leaveCalc');
const { OPEN_STATUSES, TAKEN_STATUSES } = require('../utils/leaveWorkflow');
const { PERMISSIONS, INTERNAL_ROLES } = require('../constants/permissions');
const hrScope = require('../services/hrScope');
const { inScope } = require('../utils/hrScope');
const { getHrConfig } = require('../utils/hrConfig');
const leaveService = require('../services/leaveService');
const db = require('../models');

const { StaffLeave, User, StaffProfile } = db;

const MAX_DAYS = 92;                 // a quarter at most, to keep the payload small
const fullName = (u) => (u ? `${u.firstName} ${u.lastName}`.trim() : null);
const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const monthStart = (iso) => `${iso.slice(0, 7)}-01`;
const monthEnd = (iso) => {
  const [y, m] = iso.slice(0, 7).split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

/** GET /api/leave/calendar?from&to&cadre */
const calendar = async (req, res) => {
  try {
    const today = clinicToday();
    let from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : monthStart(today);
    let to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : monthEnd(from);
    if (to < from) to = from;
    if (datesInRange(from, to).length > MAX_DAYS) to = addDays(from, MAX_DAYS - 1);

    const cadre = INTERNAL_ROLES.includes(req.query.cadre) ? req.query.cadre : null;
    // HR Tier 3 Phase 1: the real type is shown only where the viewer's
    // leave.view / leave.sick scope reaches that person's department; everyone
    // still sees names and dates (the calendar is for every internal role).
    const viewScope = await hrScope.scopeOf(req.user, PERMISSIONS.LEAVE_VIEW);
    const sickScope = await hrScope.scopeOf(req.user, PERMISSIONS.LEAVE_SICK);

    const [types, cfg, holidayMap, policy] = await Promise.all([
      leaveService.listTypes({ includeRetired: true }),
      getHrConfig(),
      leaveService.holidayMap(),
      leaveService.loadPolicy(Number(from.slice(0, 4))),
    ]);
    const typeNames = Object.fromEntries(types.map((t) => [t.key, t.name]));
    const visible = new Set((cfg.calendarVisibleTypes || []).filter((k) => !leaveService.PRIVATE_TYPES.has(k)));
    const weekWeights = policy?.weekWeights || DEFAULT_WEEK_WEIGHTS;
    const maxPerDay = policy && policy.maxCadreAwayPerDay != null ? policy.maxCadreAwayPerDay : null;

    const userWhere = { isActive: true, role: { [Op.in]: cadre ? [cadre] : INTERNAL_ROLES } };
    const leaves = await StaffLeave.findAll({
      where: {
        status: { [Op.in]: [...OPEN_STATUSES, ...TAKEN_STATUSES] },
        startDate: { [Op.lte]: to },
        endDate: { [Op.gte]: from },
      },
      attributes: ['id', 'UserId', 'leaveType', 'startDate', 'endDate', 'status'],
      include: [{
        model: User,
        attributes: ['id', 'firstName', 'lastName', 'role'],
        where: userWhere,
        include: [{ model: StaffProfile, attributes: ['position', 'departmentId'], required: false }],
      }],
      order: [['startDate', 'ASC']],
    });

    const labelFor = (key, departmentId) => {
      const viewAll = inScope(viewScope, departmentId);
      const sick = inScope(sickScope, departmentId);
      if (leaveService.PRIVATE_TYPES.has(key)) {
        return sick ? { label: typeNames[key] || key, leaveType: key } : { label: 'Away', leaveType: null };
      }
      if (viewAll) return { label: typeNames[key] || key, leaveType: key };
      if (visible.has(key)) return { label: typeNames[key] || key, leaveType: key };
      return { label: 'Away', leaveType: null };   // hidden or private → dates only
    };

    // One row per person, their segments clipped to the window.
    const byUser = new Map();
    for (const l of leaves) {
      const uid = l.UserId;
      if (!byUser.has(uid)) {
        byUser.set(uid, {
          userId: uid, name: fullName(l.User) || 'Former colleague', role: l.User?.role || null,
          position: l.User?.StaffProfile?.position || null, segments: [],
        });
      }
      const { label, leaveType } = labelFor(l.leaveType, l.User?.StaffProfile?.departmentId ?? null);
      byUser.get(uid).segments.push({
        from: String(l.startDate).slice(0, 10) < from ? from : String(l.startDate).slice(0, 10),
        to: String(l.endDate).slice(0, 10) > to ? to : String(l.endDate).slice(0, 10),
        state: TAKEN_STATUSES.includes(l.status) ? 'approved' : 'pending',
        label,
        leaveType,
      });
    }
    const rows = [...byUser.values()].sort((a, b) => a.name.localeCompare(b.name));

    // Holidays in the window; the days that are weekend (weight 0).
    const dates = datesInRange(from, to);
    const holidays = dates.filter((d) => holidayMap.has(d)).map((d) => ({ date: d, name: holidayMap.get(d) }));
    const weekendDays = dates.filter((d) => {
      const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
      return Number(weekWeights[wd]) === 0;
    });

    // Cadre clash: per working day, per role, how many are away (approved or
    // pending), against maxCadreAwayPerDay. Warning only.
    const clashes = [];
    if (maxPerDay != null) {
      const holidaySet = new Set(holidays.map((h) => h.date));
      const weekendSet = new Set(weekendDays);
      const perRoleDay = {};   // role -> date -> Set(userId)
      for (const r of rows) {
        for (const seg of r.segments) {
          for (const d of datesInRange(seg.from, seg.to)) {
            if (holidaySet.has(d) || weekendSet.has(d)) continue;
            (perRoleDay[r.role] ||= {});
            (perRoleDay[r.role][d] ||= new Set()).add(r.userId);
          }
        }
      }
      const names = (role, d) => rows.filter((r) => r.role === role && perRoleDay[role][d]?.has(r.userId)).map((r) => r.name);
      for (const [role, days] of Object.entries(perRoleDay)) {
        for (const [d, set] of Object.entries(days)) {
          if (set.size > maxPerDay) clashes.push({ date: d, cadre: role, count: set.size, names: names(role, d) });
        }
      }
      clashes.sort((a, b) => a.date.localeCompare(b.date) || a.cadre.localeCompare(b.cadre));
    }

    return success(res, {
      from, to, today, cadre,
      // `manage` kept for the screen: true when this viewer sees real types.
      manage: viewScope.all || viewScope.departmentIds.size > 0,
      weekWeights,
      holidays,
      weekendDays,
      maxCadreAwayPerDay: maxPerDay,
      rows,
      clashes,
    });
  } catch (err) {
    console.error('LeaveCalendar.calendar error:', err);
    return error(res, 'Failed to load the team calendar', 500);
  }
};

module.exports = { calendar };
