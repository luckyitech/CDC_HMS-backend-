// HR Suite → Reports (HR Tier 3 Phase 2; mockup B, decisions T3-3, R-1…R-8).
// The HTTP shell: the figures are built by services/hrReports (scope-aware,
// through services/hrScope) from the pure rules in utils/hrReports.
//
//   GET /api/hr/reports?year=&month=&window=             the page (JSON)
//   GET /api/hr/reports/:report/download?year=&month=&window=   one report as .csv
//
// Gate: hr.reports at the route. A department-limited holder simply gets the
// people in their scope — nothing out of scope is counted or listed.
// Sick leave leaves the server only as one total (R-3) and is in no .csv.
// Every download is written to the settings trail (area "HR Suite"): the files
// hold personal data (leave balances, punctuality by name) once they leave the
// HMS — the same rule as the leave register.

const { success, error } = require('../utils/response');
const { sendCsv } = require('../utils/csv');
const { recordSettingChanges } = require('../services/settingChangeLog');
const hrReports = require('../services/hrReports');

const ROLE_LABEL = { doctor: 'Doctor', nurse: 'Nurse', lab: 'Lab', staff: 'Front office', admin: 'Admin' };
const n = (v) => (v === null || v === undefined ? '' : String(v));
const person = (r) => [r.employeeId || '', r.name, ROLE_LABEL[r.role] || r.role || '', r.department || 'No department'];
const PERSON_HEAD = ['Employee ID', 'Name', 'Role', 'Department'];

const CPD_STATUS = { met: 'Target met', on_track: 'On track', behind: 'Behind' };

// Each downloadable report: its title for the file and the trail, and how
// its rows become a table. `period` names what the figures cover.
const CSV = {
  headcount: {
    title: 'Headcount by department',
    period: (d) => d.today,
    table: (d) => ({
      headers: ['Department', ...d.cadres.map((c) => c.label), 'Total', 'Annual leave owed (days)'],
      rows: [...d.headcount.rows, d.headcount.totals].map((r) => [
        r.name, ...d.cadres.map((c) => r.counts[c.key]), r.total, n(r.leaveOwed),
      ]),
    }),
  },
  movement: {
    title: 'Joiners and leavers',
    period: (d) => String(d.year),
    table: (d) => ({
      headers: ['Movement', 'Date', ...PERSON_HEAD],
      rows: [
        ...d.movement.joined.map((r) => ['Joined', r.date, ...person(r)]),
        ...d.movement.left.map((r) => ['Left', r.date, ...person(r)]),
      ],
    }),
  },
  leave: {
    title: 'Annual leave owed',
    period: (d) => String(d.year),
    table: (d) => ({
      headers: [...PERSON_HEAD, 'Entitled', 'Carried in', 'Taken', 'Booked', 'Remaining'],
      rows: d.leave.people.map((r) => [
        ...person(r),
        ...(r.annual
          ? [r.annual.entitled === null ? 'Unlimited' : n(r.annual.entitled), n(r.annual.carriedIn), n(r.annual.taken), n(r.annual.booked), r.annual.remaining === null ? '' : n(r.annual.remaining)]
          : ['', '', '', '', '']),
      ]),
    }),
  },
  expiries: {
    title: 'Licences and documents expiring',
    period: (d) => `${d.today}-next-${d.window}-days`,
    table: (d) => ({
      headers: [...PERSON_HEAD, 'Item', 'Expiry date', 'Days left', 'Status'],
      rows: d.expiries.rows.map((r) => [
        ...person(r), r.item, r.expiryDate, r.daysLeft, r.status === 'expired' ? 'Expired' : 'Due',
      ]),
    }),
  },
  cpd: {
    title: 'CPD progress',
    period: (d) => String(d.year),
    table: (d) => ({
      headers: [...PERSON_HEAD, 'Target', 'Verified points', 'Pending points', 'Expected by now', 'Status'],
      rows: d.cpd.people.map((r) => [
        ...person(r), r.target, r.verified, r.pending, r.expectedByNow, CPD_STATUS[r.status] || r.status,
      ]),
    }),
  },
  punctuality: {
    title: 'Punctuality',
    period: (d) => d.month,
    table: (d) => ({
      headers: [...PERSON_HEAD, 'Working days so far', 'Days in', 'On leave', 'On time', 'Late', 'On time %',
        'Average minutes late', 'Left early', 'Missed check-outs', 'Working days with no check-in'],
      rows: d.punctuality.people.map((r) => [
        ...person(r), r.workingDays, r.daysWorked, r.leaveDays, r.onTime, r.late, n(r.onTimeRate),
        r.avgLateMinutes, r.earlyOut, r.missedCheckouts, r.noCheckIn,
      ]),
    }),
  },
};
const REPORTS = Object.keys(CSV);

const opts = (q) => ({ year: q.year, month: q.month, window: q.window });

/** GET /api/hr/reports — the whole page. */
const page = async (req, res) => {
  try {
    return success(res, await hrReports.build(req.user, opts(req.query)));
  } catch (err) {
    console.error('HrReports.page error:', err);
    return error(res, 'Failed to build the HR reports', 500);
  }
};

/** GET /api/hr/reports/:report/download — one report as .csv (logged). */
const download = async (req, res) => {
  const spec = CSV[req.params.report];
  if (!spec) return error(res, 'Unknown report', 404);
  try {
    const data = await hrReports.build(req.user, opts(req.query));
    const { headers, rows } = spec.table(data);
    const period = spec.period(data);
    recordSettingChanges({
      user: req.user, area: 'HR Suite',
      before: { d: null },
      after: { d: `${spec.title} — ${period} — ${rows.length} row${rows.length === 1 ? '' : 's'}` },
      fields: { d: { key: `hr.reports.download.${req.params.report}`, label: 'HR report downloaded' } },
    });
    return sendCsv(res, `hr-report-${req.params.report}-${period}.csv`, headers, rows);
  } catch (err) {
    console.error('HrReports.download error:', err);
    return error(res, 'Failed to build the report', 500);
  }
};

module.exports = { page, download, REPORTS, CSV };
