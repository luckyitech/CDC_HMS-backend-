// =====================================================================
// HR Suite (B21) — missed check-out sweep.
//
// A session still 'open' after the clinic day it belongs to has ended is a
// forgotten tap-out. Every five minutes (and once at boot) such rows become
// 'missed_checkout': hours stop accruing, the calendar shows an outlined
// out-star, and the HR dashboard lists it under "Needs attention" until HR
// amends it with a reason. Nothing is guessed — no default shift length.
//
// Armed from server.js beside the Lab Inbox poller, inside its own try/catch,
// so a failure here can never affect the API.
// =====================================================================

const { Op } = require('sequelize');
const db = require('../models');
const { clinicToday } = require('../utils/clinicTime');
const { parseJsonColumn } = require('../utils/jsonColumn');

const { TAKEN_STATUSES, employmentFlips } = require('../utils/leaveWorkflow');
const { runExpiryReminders } = require('./expiryReminders');
const { OVERNIGHT_GRACE_HOURS } = require('./hrAttendanceService');

const { StaffAttendance, StaffLeave, StaffProfile } = db;

// B27 phase 3 — the On Leave sweep rides on the same five-minute timer: the
// staff-file pill says "On Leave" while approved leave covers today and goes
// back to Active the day after it ends (utils/leaveWorkflow employmentFlips —
// never over a status HR set by hand, never over Suspended/Resigned/Terminated).
const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const runLeaveStatusSweep = async (now = new Date()) => {
  const today = clinicToday(now);
  const weekAgo = addDays(today, -7);
  const [covering, ended, profiles] = await Promise.all([
    StaffLeave.findAll({ where: { status: { [Op.in]: TAKEN_STATUSES }, startDate: { [Op.lte]: today }, endDate: { [Op.gte]: today } }, attributes: ['UserId'], raw: true }),
    StaffLeave.findAll({ where: { status: { [Op.in]: TAKEN_STATUSES }, endDate: { [Op.gte]: weekAgo, [Op.lt]: today } }, attributes: ['UserId'], raw: true }),
    StaffProfile.findAll({ where: { employmentStatus: { [Op.in]: ['Active', 'On Leave'] } }, attributes: ['UserId', 'employmentStatus'], raw: true }),
  ]);
  const flips = employmentFlips({
    profiles: profiles.map((p) => ({ userId: p.UserId, status: p.employmentStatus })),
    coveringToday: new Set(covering.map((r) => r.UserId)),
    endedRecently: new Set(ended.map((r) => r.UserId)),
  });
  if (flips.toOnLeave.length) {
    await StaffProfile.update({ employmentStatus: 'On Leave' }, { where: { UserId: { [Op.in]: flips.toOnLeave }, employmentStatus: 'Active' } });
  }
  if (flips.toActive.length) {
    await StaffProfile.update({ employmentStatus: 'Active' }, { where: { UserId: { [Op.in]: flips.toActive }, employmentStatus: 'On Leave' } });
  }
  const n = flips.toOnLeave.length + flips.toActive.length;
  if (n) console.log(`[HR] leave status sweep: ${flips.toOnLeave.length} on leave, ${flips.toActive.length} back`);
  return flips;
};

const INTERVAL_MS = 5 * 60 * 1000;
let timer = null;

// A session whose expected check-out is TODAY (a rostered night shift, HR
// Tier 3 Phase 4) is not stale at midnight: it waits until OVERNIGHT_GRACE_HOURS
// after the shift's end. Every other open session from an earlier day is.
const isStale = (row, today, now = new Date()) => {
  if (!(row.clinicDate < today)) return false;
  if (!row.expectedOutAt) return true;
  const out = new Date(row.expectedOutAt);
  if (clinicToday(out) < today) return true;
  return now.getTime() > out.getTime() + OVERNIGHT_GRACE_HOURS * 3600 * 1000;
};

const runSweep = async (now = new Date()) => {
  const today = clinicToday(now);
  const stale = (await StaffAttendance.findAll({ where: { status: 'open', clinicDate: { [Op.lt]: today } } }))
    .filter((row) => isStale(row, today, now));
  for (const row of stale) {
    const diag = parseJsonColumn(row.diagnostics) || {};
    await row.update({ status: 'missed_checkout', diagnostics: { ...diag, sweptAt: now.toISOString() } });
  }
  if (stale.length) console.log(`[HR] missed-checkout sweep closed ${stale.length}`);
  return stale.length;
};

// Each sweep in its own catch: one failing never stops the others. The expiry
// pass (B27 phase 5) rides the same timer but only does real work once a day,
// after 06:00 Nairobi (services/expiryReminders guards this).
const runAll = () => {
  runSweep().catch((err) => console.error('[HR] missed-checkout sweep failed:', err.message));
  runLeaveStatusSweep().catch((err) => console.error('[HR] leave status sweep failed:', err.message));
  runExpiryReminders().catch((err) => console.error('[HR] expiry reminders failed:', err.message));
};

const startScheduler = () => {
  if (timer) return;
  runAll();
  timer = setInterval(runAll, INTERVAL_MS);
  if (timer.unref) timer.unref();
  console.log('[HR] missed-checkout sweep armed (every 5 minutes).');
};

const stopScheduler = () => { if (timer) { clearInterval(timer); timer = null; } };

module.exports = { isStale, runSweep, runLeaveStatusSweep, runExpiryReminders, startScheduler, stopScheduler };
