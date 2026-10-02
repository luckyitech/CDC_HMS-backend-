// HR Suite Tier 2 (2 Oct 2026) — cover person, required approvers, leave
// register, holidays on a Sunday. Pure rules + static route checks.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { mergeRequired, coverError, applyEvent, isLastApprover, validateParticipants, KIND } = require('../utils/leaveWorkflow');
const { observedDayFor } = require('../utils/leaveCalc');
const { csvCell, csvText } = require('../utils/csv');
const { ALERT_EVENTS, DEFAULTS } = require('../utils/hrConfig');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

describe('required approvers are forced in', () => {
  test('a missing required approver is added first, as an approver', () => {
    const out = mergeRequired([{ userId: 5, kind: 'approver' }], [9], 1);
    assert.deepEqual(out.map((p) => [p.userId, p.kind]), [[9, 'approver'], [5, 'approver']]);
  });
  test('a required person listed as acknowledger becomes an approver', () => {
    const out = mergeRequired([{ userId: 9, kind: 'acknowledger' }], [9], 1);
    assert.deepEqual(out.map((p) => [p.userId, p.kind]), [[9, 'approver']]);
  });
  test('never the applicant, never twice', () => {
    const out = mergeRequired([{ userId: 9, kind: 'approver' }], [9, 9, 1], 1);
    assert.deepEqual(out.map((p) => p.userId), [9]);
  });
  test('the client cannot drop a required approver (they come back)', () => {
    assert.ok(mergeRequired([], [9], 1).some((p) => p.userId === 9 && p.kind === 'approver'));
  });
});

describe('cover person', () => {
  test('choices', () => {
    assert.equal(coverError(null, 1, []), null);
    assert.equal(coverError(7, 1, [], new Set([7])), null);
    assert.equal(coverError(1, 1, []), 'COVER_SELF');
    assert.equal(coverError(7, 1, [{ userId: 7, kind: 'approver' }]), 'COVER_LISTED');
    assert.equal(coverError(7, 1, [], new Set()), 'COVER_INACTIVE');
    assert.equal(coverError('x', 1, []), 'BAD_COVER');
  });
  test('cover is not a kind the applicant can choose for an approver/acknowledger', () => {
    const r = validateParticipants([{ userId: 7, kind: 'cover' }, { userId: 8, kind: 'approver' }], 1, { approveHolders: new Set([8]) });
    assert.ok(r.errors.includes('BAD_KIND'));
  });
  test('a waiting or declining cover never blocks approval', () => {
    const participants = [
      { userId: 8, kind: KIND.APPROVER, decision: 'pending' },
      { userId: 7, kind: KIND.COVER, decision: 'declined' },
    ];
    const r = applyEvent({ status: 'Pending', participants, event: { type: 'approve', actorId: 8 } });
    assert.equal(r.status, 'Approved');
    assert.equal(r.final, true);
    assert.equal(isLastApprover(participants, 8), true);
  });
  test('the cover cannot approve', () => {
    const participants = [{ userId: 8, kind: KIND.APPROVER, decision: 'pending' }, { userId: 7, kind: KIND.COVER, decision: 'pending' }];
    assert.throws(() => applyEvent({ status: 'Pending', participants, event: { type: 'approve', actorId: 7 } }), /not an approver/);
  });
});

describe('a holiday on a Sunday', () => {
  test('observed on the Monday', () => {
    assert.equal(observedDayFor('2027-10-10'), '2027-10-11');   // Utamaduni
    assert.equal(observedDayFor('2027-12-12'), '2027-12-13');   // Jamhuri
    assert.equal(observedDayFor('2027-12-26'), '2027-12-27');   // Boxing Day
  });
  test('the next day that is not already a holiday (Christmas on a Sunday → Tuesday)', () => {
    assert.equal(observedDayFor('2022-12-25', new Set(['2022-12-25', '2022-12-26'])), '2022-12-27');
  });
  test('not a Sunday → nothing', () => {
    assert.equal(observedDayFor('2026-10-20'), null);
  });
  test('the switch defaults on', () => {
    assert.equal(DEFAULTS.observeSundayHolidays, true);
  });
});

describe('csv', () => {
  test('quotes commas, quotes and line breaks; defuses formulas', () => {
    assert.equal(csvCell('a,b'), '"a,b"');
    assert.equal(csvCell('say "hi"'), '"say ""hi"""');
    assert.equal(csvCell('=SUM(A1)'), "'=SUM(A1)");
    assert.equal(csvCell(null), '');
  });
  test('BOM + CRLF', () => {
    const t = csvText(['A', 'B'], [[1, 2]]);
    assert.ok(t.startsWith('﻿A,B\r\n1,2'));
  });
});

describe('routes and notices', () => {
  const leave = read('routes', 'leave.js');
  const staff = read('routes', 'staff.js');
  test('the leave register is leave.manage', () => {
    assert.match(leave, /const MANAGE = \['admin', 'leave\.manage'\];/);
    assert.match(leave, /router\.get\('\/register', authenticate, authorize\(\.\.\.MANAGE\)/);
  });
  test('the cover answer is a PARTICIPATE route; the controller checks the cover', () => {
    assert.match(leave, /router\.post\('\/requests\/:id\/cover', authenticate, authorize\(\.\.\.PARTICIPATE\)/);
    assert.match(read('controllers', 'leaveApprovalController.js'), /if \(!detail\.me\.canAnswerCover\)/);
  });
  test('the Sunday switch is leave.policy', () => {
    assert.match(leave, /router\.put\('\/holidays\/observe-sunday', authenticate, authorize\(\.\.\.POLICY\)/);
  });
  test('required approvers: read with the Leave tab, set by leave.manage, never on your own file', () => {
    assert.match(staff, /router\.get\('\/:employeeId\/required-approvers', authenticate, findStaff, leaveViewOrSelf/);
    assert.match(staff, /router\.put\('\/:employeeId\/required-approvers', authenticate, authorize\(\.\.\.LEAVE_MANAGE\)/);
    assert.match(read('controllers', 'requiredApproverController.js'), /person\.id === req\.user\.id\) return error\(res, [^\n]*OWN_FILE/);
  });
  test('submit forces the required approvers in, whatever the client sends', () => {
    assert.match(read('controllers', 'hrSelfLeaveController.js'), /mergeRequired\(chosen, await activeRequiredIds\(me\.id\), me\.id\)/);
  });
  test('the cover is told dates only — never the type or the reason', () => {
    const src = read('controllers', 'hrSelfLeaveController.js');
    const block = src.slice(src.indexOf("notify('leave_cover_request'"), src.indexOf("notify('leave_cover_request'") + 400);
    assert.doesNotMatch(block, /typeForNotice|leaveType|reason/);
  });
  test('the answer notice carries no note', () => {
    const src = read('controllers', 'leaveApprovalController.js');
    const block = src.slice(src.indexOf("notify('leave_cover_answered'"), src.indexOf("notify('leave_cover_answered'") + 500);
    assert.doesNotMatch(block, /note/);
  });
  test('the new alert events exist', () => {
    for (const e of ['leave_cover_request', 'leave_cover_answered']) assert.ok(ALERT_EVENTS.includes(e), e);
  });
  test('every register download is logged', () => {
    assert.match(read('controllers', 'leaveApprovalController.js'), /label: 'Leave register downloaded'/);
  });
  test('holiday reads honour the switch through one where-clause', () => {
    const src = read('services', 'leaveService.js');
    assert.match(src, /if \(!cfg\.observeSundayHolidays\) where\.source = \{ \[Op\.ne\]: 'auto' \}/);
    assert.equal((src.match(/await countingWhere\(/g) || []).length, 2);
  });
});

describe('migration 20260928000009', () => {
  const src = read('migrations', '20260928000009-leave-cover-required-approvers-observed-holidays.js');
  test('down refuses while cover rows, cover events or required approvers exist', () => {
    assert.match(src, /WHERE kind = 'cover'/);
    assert.match(src, /type IN \('cover_agreed','cover_declined'\)/);
    assert.match(src, /HR has set \$\{n\} required approver/);
  });
  test('guards with describeTable / showAllTables and compares names case-insensitively', () => {
    assert.match(src, /toLowerCase\(\) === name\.toLowerCase\(\)/);
    assert.match(src, /describeTable/);
  });
});
