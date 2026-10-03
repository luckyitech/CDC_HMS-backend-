// HR Tier 3 Phase 5 — appraisals (T3-9 a, T3-10 a). Pure: who sees what,
// the walk, cleaning, the frozen starter competencies, and the two controls —
// hr.appraisals.run (scoped, delegable) and hr.appraisals (confidential: not
// admin.access, not delegable, never in a preset). DB behaviour is proven by
// the scratch e2e harness.
require('./_noScopeRows');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const A = require('../utils/appraisals');
const { ALERT_EVENTS } = require('../utils/hrConfig');
const {
  PERMISSIONS: P, SCOPABLE, HR_DELEGABLE, HR_NOT_DELEGABLE, ADMIN_ACCESS_COVERS, PRESET_EXCLUDED, PERMISSION_GROUPS,
  canReadAppraisals, passesAdminGate,
} = require('../constants/permissions');

const src = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const user = (role, permissions = [], denied = [], id = 1) => ({ id, role, permissions, deniedPermissions: denied });

describe('the controls (T3-10 a)', () => {
  test('hr.appraisals.run: scopable, delegable, admin access', () => {
    assert.ok(SCOPABLE.includes(P.HR_APPRAISALS_RUN));
    assert.ok(HR_DELEGABLE.includes(P.HR_APPRAISALS_RUN));
    assert.ok(ADMIN_ACCESS_COVERS.includes(P.HR_APPRAISALS_RUN));
  });
  test('hr.appraisals: not admin access, not delegable, never in a preset, not scopable', () => {
    assert.ok(!ADMIN_ACCESS_COVERS.includes(P.HR_APPRAISALS));
    assert.ok(HR_NOT_DELEGABLE.includes(P.HR_APPRAISALS));
    assert.ok(!HR_DELEGABLE.includes(P.HR_APPRAISALS));
    assert.ok(PRESET_EXCLUDED.includes(P.HR_APPRAISALS));
    assert.ok(!SCOPABLE.includes(P.HR_APPRAISALS));
  });
  test('canReadAppraisals: an explicit grant or the true admin — never admin.access; a withdrawal wins', () => {
    assert.equal(canReadAppraisals(user('staff', [P.HR_APPRAISALS])), true);
    assert.equal(canReadAppraisals(user('admin')), true);
    assert.equal(canReadAppraisals(user('staff', [P.ADMIN_ACCESS])), false);
    assert.equal(canReadAppraisals(user('staff', [P.HR_APPRAISALS], [P.HR_APPRAISALS])), false);
    assert.equal(canReadAppraisals(user('staff', [P.HR_APPRAISALS_RUN])), false);
    assert.equal(passesAdminGate(user('staff', [P.ADMIN_ACCESS]), P.HR_APPRAISALS_RUN), true);
  });
  test('both on the Development card; reading warns', () => {
    const g = PERMISSION_GROUPS.find((x) => x.key === 'hr-development');
    assert.ok(g.areas.some((a) => a.access === P.HR_APPRAISALS_RUN));
    const read = g.areas.find((a) => a.access === P.HR_APPRAISALS);
    assert.ok(read && read.warning);
  });
  test('no route gate names hr.appraisals; the service asks canReadAppraisals', () => {
    for (const f of fs.readdirSync(path.join(__dirname, '../routes'))) {
      const t = src(`routes/${f}`);
      assert.doesNotMatch(t.replace(/\/\/.*$/gm, ''), /'hr\.appraisals'/, f);
    }
    assert.match(src('services/appraisals.js'), /canReadAppraisals\(user\)/);
  });
  test('runner lists ask the hr.appraisals.run scope', () => {
    const s = src('services/appraisals.js');
    assert.match(s, /hrScope\.userIdsInScope\(user, RUN\)/);
    assert.match(s, /hrScope\.canActOn\(user, RUN, a\.UserId\)/);
  });
  test('alerts exist and carry no rating or comment', () => {
    for (const e of ['appraisal_self', 'appraisal_review', 'appraisal_sent', 'appraisal_acknowledged']) assert.ok(ALERT_EVENTS.includes(e), e);
    const s = src('services/appraisals.js');
    assert.match(s, /body: 'Open the HR Suite to see it\.'/);
    for (const m of s.matchAll(/notify\('appraisal_\w+', \[[^\]]*\], ([^\n]*)\)/g)) assert.doesNotMatch(m[1], /Rating|Comment|Summary/);
  });
});

describe('competencies and the migration (T3-9 a)', () => {
  test('the migration\'s frozen starters equal the rules\' starters', () => {
    assert.deepEqual(require('../migrations/20260928000014-hr-appraisals')._starters, A.STARTER_COMPETENCIES);
  });
  test('…014 refuses a lossy down', () => assert.match(src('migrations/20260928000014-hr-appraisals.js'), /down refused/));
  test('ratings are 1–4 with labels', () => {
    assert.deepEqual(Object.keys(A.RATING_LABELS).map(Number), [1, 2, 3, 4]);
    assert.ok(A.isRating(4) && !A.isRating(0) && !A.isRating(5) && !A.isRating(2.5));
  });
  test('cleaning', () => {
    assert.equal(A.cleanCompetency({ name: '' }).error, 'NAME_REQUIRED');
    assert.deepEqual(A.cleanCompetency({ name: '  Team  work ' }).value, { name: 'Team work' });
    assert.equal(A.cleanCycle({ year: 2026, selfDueOn: '2026-11-30', reviewDueOn: '2026-11-01' }).error, 'DUE_ORDER');
    assert.deepEqual(A.cleanCycle({ year: 2026 }).value, { year: 2026, name: '2026 appraisal', selfDueOn: null, reviewDueOn: null });
    assert.equal(A.cleanRatings([{ id: 9, selfRating: 3 }], 'self', [1, 2]).error, 'BAD_RATINGS');
    assert.equal(A.cleanRatings([{ id: 1, selfRating: 5 }], 'self', [1, 2]).error, 'BAD_RATING');
    assert.deepEqual(A.cleanRatings([{ id: 1, reviewerRating: '3', reviewerComment: ' ok ' }], 'reviewer', [1]).value, [{ id: 1, rating: 3, comment: 'ok' }]);
    assert.equal(A.cleanObjectives([{ text: '' }]).error, 'OBJECTIVE_TEXT');
    assert.deepEqual(A.cleanObjectives([{ id: 4, remove: true }]).value, [{ id: 4, text: '', dueBy: null, remove: true }]);
  });
  test('default reviewer = who they report to, if active and not themselves', () => {
    const active = new Set([5, 6]);
    assert.equal(A.defaultReviewer({ personId: 1, reportsToId: 5, activeIds: active }), 5);
    assert.equal(A.defaultReviewer({ personId: 1, reportsToId: 9, activeIds: active }), null);
    assert.equal(A.defaultReviewer({ personId: 5, reportsToId: 5, activeIds: active }), null);
    assert.equal(A.defaultReviewer({ personId: 1, reportsToId: null, activeIds: active }), null);
  });
});

describe('who sees what (T3-10 a)', () => {
  const base = {
    id: 1, UserId: 10, reviewerId: 20, selfSummary: 'I did well', reviewerSummary: 'Draft review', personComment: 'Thanks',
    meetingOn: '2026-11-20',
    ratings: [{ id: 1, name: 'Teamwork', sortOrder: 10, selfRating: 3, selfComment: 'me', reviewerRating: 4, reviewerComment: 'rev' }],
    objectives: [{ id: 1, text: 'Lead foot clinic', status: 'active' }, { id: 2, text: 'old', status: 'removed' }],
  };
  const at = (status) => ({ ...base, status });

  test('roles: person first, then reviewer, then reader; anyone else is not found', () => {
    assert.equal(A.roleOf({ appraisal: at('self'), userId: 10, canRead: true }), 'person');
    assert.equal(A.roleOf({ appraisal: at('self'), userId: 20, canRead: true }), 'reviewer');
    assert.equal(A.roleOf({ appraisal: at('self'), userId: 30, canRead: true }), 'reader');
    assert.equal(A.roleOf({ appraisal: at('self'), userId: 30, canRead: false }), null);
  });
  test('the reviewer never sees a self-assessment before it is submitted', () => {
    const v = A.viewFor(at('self'), 'reviewer');
    assert.equal(v.selfSummary, null);
    assert.equal(v.ratings[0].selfRating, null);
    assert.equal(v.ratings[0].reviewerRating, 4);
    assert.equal(A.viewFor(at('review'), 'reviewer').ratings[0].selfRating, 3);
  });
  test('the person never sees the review before it is sent', () => {
    for (const s of ['self', 'review']) {
      const v = A.viewFor(at(s), 'person');
      assert.equal(v.reviewerSummary, null, s);
      assert.equal(v.ratings[0].reviewerRating, null, s);
      assert.deepEqual(v.objectives, [], s);
      assert.equal(v.meetingOn, null, s);
    }
    const v = A.viewFor(at('sent'), 'person');
    assert.equal(v.reviewerSummary, 'Draft review');
    assert.equal(v.ratings[0].reviewerComment, 'rev');
    assert.deepEqual(v.objectives.map((o) => o.text), ['Lead foot clinic']);
  });
  test('a reader sees everything; the reviewer sees the person\'s comment only once acknowledged', () => {
    const r = A.viewFor(at('self'), 'reader');
    assert.equal(r.selfSummary, 'I did well');
    assert.equal(r.reviewerSummary, 'Draft review');
    assert.equal(A.viewFor(at('sent'), 'reviewer').personComment, null);
    assert.equal(A.viewFor(at('acknowledged'), 'reviewer').personComment, 'Thanks');
  });
  test('what each may do, and nothing once the cycle closes', () => {
    assert.deepEqual(A.actionsFor('person', 'self', true), { editSelf: true, editReview: false, acknowledge: false });
    assert.deepEqual(A.actionsFor('reviewer', 'review', true), { editSelf: false, editReview: true, acknowledge: false });
    assert.deepEqual(A.actionsFor('person', 'sent', true), { editSelf: false, editReview: false, acknowledge: true });
    assert.deepEqual(A.actionsFor('reader', 'review', true), { editSelf: false, editReview: false, acknowledge: false });
    assert.deepEqual(A.actionsFor('person', 'self', false), { editSelf: false, editReview: false, acknowledge: false });
    assert.deepEqual(A.actionsFor('reviewer', 'sent', true), { editSelf: false, editReview: false, acknowledge: false });
  });
  test('allRated', () => {
    assert.equal(A.allRated([{ selfRating: 3 }, { selfRating: null }], 'self'), false);
    assert.equal(A.allRated([{ reviewerRating: 1 }, { reviewerRating: 4 }], 'reviewer'), true);
    assert.equal(A.allRated([], 'self'), false);
  });
});
