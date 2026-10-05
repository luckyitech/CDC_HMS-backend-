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

const {
  TAKEN_STATUSES, employmentFlips, STATUS, KIND, CANCEL_REMINDER, cancelRemindersDue,
} = require('../utils/leaveWorkflow');
const { clinicDatePlusDays, nairobiHour } = require('../utils/clinicTime');
const { PERMISSIONS } = require('../constants/permissions');
const { runExpiryReminders } = require('./expiryReminders');
const { OVERNIGHT_GRACE_HOURS } = require('./hrAttendanceService');

const { StaffAttendance, StaffLeave, StaffProfile, LeaveParticipant, LeaveEvent, User } = db;

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

// HR fixes #3 (5 Oct 2026): an approved leave whose applicant asked to cancel
// still counts as taken until someone decides. If it starts TOMORROW and is
// still undecided, its approvers are reminded once — the 'notified' event on
// the leave's timeline (data.reminder) is both the record and the de-dupe, so
// a restart never sends twice. Never names the leave type (it may be sick).
// Waits until 06:00 Nairobi, like the expiry pass, so nobody gets a bell or an
// email just after midnight. A leave with no approvers (recorded by HR) goes
// to the leave.manage holders whose scope covers the person — anyone who may
// decide the cancel; if there is nobody, nothing is written (so a later
// approver is still reminded).
const shortDate = (iso) => new Date(`${iso}T12:00:00Z`)
  .toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

const runCancelRequestReminders = async (now = new Date()) => {
  if (nairobiHour(now) < 6) return 0;
  const tomorrow = clinicDatePlusDays(1, now);
  const leaves = await StaffLeave.findAll({
    where: { status: STATUS.CANCEL_REQUESTED, startDate: tomorrow },
    attributes: ['id', 'UserId', 'status', 'startDate', 'endDate'],
    include: [{ model: User, attributes: ['firstName', 'lastName'] }],
  });
  if (!leaves.length) return 0;
  const events = await LeaveEvent.findAll({
    where: { leaveId: { [Op.in]: leaves.map((l) => l.id) }, type: 'notified' },
    attributes: ['leaveId', 'data'],
  });
  const reminded = new Set(events
    .filter((e) => (parseJsonColumn(e.data) || {}).reminder === CANCEL_REMINDER)
    .map((e) => Number(e.leaveId)));
  const due = cancelRemindersDue(leaves.map((l) => l.get({ plain: true })), tomorrow, reminded);
  const hrNotify = require('./hrNotify');
  const hrScope = require('./hrScope');
  let sent = 0;
  for (const l of due) {
    const approvers = (await LeaveParticipant.findAll({ where: { leaveId: l.id, kind: KIND.APPROVER }, attributes: ['UserId'], raw: true }))
      .map((p) => p.UserId);
    const recipients = approvers.length ? approvers
      : (await hrScope.holdersFor(PERMISSIONS.LEAVE_MANAGE, l.UserId)).filter((id) => Number(id) !== Number(l.UserId));
    if (!recipients.length) continue;   // nobody to tell — and nothing recorded
    // Record first: a failed send must not turn into a reminder every 5 minutes.
    await LeaveEvent.create({
      leaveId: l.id, actorId: null, type: 'notified',
      note: approvers.length
        ? 'Reminder sent to the approvers: the leave starts tomorrow and the cancel request is still undecided.'
        : 'Reminder sent to HR (no approvers on this leave): it starts tomorrow and the cancel request is still undecided.',
      data: { reminder: CANCEL_REMINDER, recipients },
    });
    sent += 1;
    const name = l.User ? `${l.User.firstName} ${l.User.lastName}` : 'A colleague';
    const start = String(l.startDate).slice(0, 10);
    const end = String(l.endDate).slice(0, 10);
    await hrNotify.notify('leave_cancelled', {
      recipients,
      title: `Still to decide: ${name} asked to cancel leave that starts tomorrow`,
      body: `${start === end ? shortDate(start) : `${shortDate(start)} – ${shortDate(end)}`}. Until someone cancels it, it still counts as leave taken. Open the HMS to cancel it or keep it.`,
      link: `/hr/leave?id=${l.id}`,
    });
  }
  if (sent) console.log(`[HR] cancel-request reminders: ${sent} sent`);
  return sent;
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
  runCancelRequestReminders().catch((err) => console.error('[HR] cancel-request reminders failed:', err.message));
};

const startScheduler = () => {
  if (timer) return;
  runAll();
  timer = setInterval(runAll, INTERVAL_MS);
  if (timer.unref) timer.unref();
  console.log('[HR] missed-checkout sweep armed (every 5 minutes).');
};

const stopScheduler = () => { if (timer) { clearInterval(timer); timer = null; } };

module.exports = {
  isStale, runSweep, runLeaveStatusSweep, runExpiryReminders, runCancelRequestReminders, startScheduler, stopScheduler,
};
