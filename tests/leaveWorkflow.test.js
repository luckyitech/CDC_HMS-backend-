const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  STATUS, validateParticipants, applyEvent, isLastApprover, chargeValid,
} = require('../utils/leaveWorkflow');

// B27 — the leave workflow (spec §5, decisions D5–D7).

const APPLICANT = 10;
const HOLDERS = new Set([1, 2]);            // hold leave.approve
const ACTIVE = new Set([1, 2, 3, 4, 10]);

const people = (...list) => list.map(([userId, kind, decision = kind === 'approver' ? 'pending' : 'notified']) => ({ userId, kind, decision }));

describe('choosing the people', () => {
  test('one approver who can approve is enough', () => {
    assert.deepEqual(validateParticipants([{ userId: 1, kind: 'approver' }], APPLICANT, { approveHolders: HOLDERS, activeUsers: ACTIVE }),
      { ok: true, errors: [] });
  });
  test('at least one approver must hold leave.approve', () => {
    const r = validateParticipants([{ userId: 3, kind: 'approver' }], APPLICANT, { approveHolders: HOLDERS });
    assert.deepEqual(r.errors, ['NO_APPROVE_HOLDER']);
  });
  test('acknowledgers alone are not enough', () => {
    assert.deepEqual(validateParticipants([{ userId: 1, kind: 'acknowledger' }], APPLICANT, { approveHolders: HOLDERS }).errors, ['NO_APPROVER']);
  });
  test('nobody lists themselves, nobody twice, nobody archived', () => {
    const r = validateParticipants([
      { userId: 1, kind: 'approver' }, { userId: 10, kind: 'approver' }, { userId: 1, kind: 'acknowledger' }, { userId: 99, kind: 'acknowledger' },
    ], APPLICANT, { approveHolders: HOLDERS, activeUsers: ACTIVE });
    assert.deepEqual(r.errors.sort(), ['DUPLICATE', 'INACTIVE', 'SELF']);
  });
  test('an empty list is refused', () => {
    assert.equal(validateParticipants([], APPLICANT).ok, false);
  });
});

describe('deciding', () => {
  test('ALL approvers must approve; acknowledgers never block', () => {
    let p = people([1, 'approver'], [2, 'approver'], [3, 'acknowledger']);
    let r = applyEvent({ status: STATUS.PENDING, participants: p, event: { type: 'approve', actorId: 1 } });
    assert.equal(r.status, STATUS.PENDING); assert.equal(r.final, false);
    r = applyEvent({ status: r.status, participants: r.participants, event: { type: 'approve', actorId: 2 } });
    assert.equal(r.status, STATUS.APPROVED); assert.equal(r.final, true);
  });

  test('a decline is final, even after someone approved', () => {
    const p = people([1, 'approver', 'approved'], [2, 'approver']);
    const r = applyEvent({ status: STATUS.PENDING, participants: p, event: { type: 'decline', actorId: 2 } });
    assert.equal(r.status, STATUS.REJECTED);
    assert.throws(() => applyEvent({ status: r.status, participants: r.participants, event: { type: 'approve', actorId: 1 } }), { code: 'NOT_OPEN' });
  });

  test('the info loop: ask → parked → reply → back to pending for the asker only', () => {
    let r = applyEvent({ status: STATUS.PENDING, participants: people([1, 'approver'], [2, 'approver']), event: { type: 'info', actorId: 2 } });
    assert.equal(r.status, STATUS.INFO_REQUESTED);
    // Others may still answer while it is parked; it stays parked.
    r = applyEvent({ status: r.status, participants: r.participants, event: { type: 'approve', actorId: 1 } });
    assert.equal(r.status, STATUS.INFO_REQUESTED);
    r = applyEvent({ status: r.status, participants: r.participants, event: { type: 'reply', isApplicant: true } });
    assert.equal(r.status, STATUS.PENDING);
    assert.deepEqual(r.participants.map((x) => x.decision), ['approved', 'pending']);
    r = applyEvent({ status: r.status, participants: r.participants, event: { type: 'approve', actorId: 2 } });
    assert.equal(r.status, STATUS.APPROVED);
  });

  test('only a listed approver decides — not an acknowledger, not a stranger', () => {
    const p = people([1, 'approver'], [3, 'acknowledger']);
    assert.throws(() => applyEvent({ status: STATUS.PENDING, participants: p, event: { type: 'approve', actorId: 3 } }), { code: 'NOT_APPROVER' });
    assert.throws(() => applyEvent({ status: STATUS.PENDING, participants: p, event: { type: 'approve', actorId: 4 } }), { code: 'NOT_APPROVER' });
  });

  test('only the applicant replies, and only when asked', () => {
    const p = people([1, 'approver']);
    assert.throws(() => applyEvent({ status: STATUS.INFO_REQUESTED, participants: p, event: { type: 'reply', isApplicant: false } }), { code: 'NOT_APPLICANT' });
    assert.throws(() => applyEvent({ status: STATUS.PENDING, participants: p, event: { type: 'reply', isApplicant: true } }), { code: 'NO_QUESTION' });
  });
});

describe('withdrawing and cancelling', () => {
  const p = people([1, 'approver']);
  test('withdraw while waiting', () => {
    assert.equal(applyEvent({ status: STATUS.INFO_REQUESTED, participants: p, event: { type: 'withdraw', isApplicant: true } }).status, STATUS.WITHDRAWN);
    assert.throws(() => applyEvent({ status: STATUS.APPROVED, participants: p, event: { type: 'withdraw', isApplicant: true } }), { code: 'NOT_OPEN' });
  });
  test('ask to cancel approved leave that has not started', () => {
    assert.equal(applyEvent({ status: STATUS.APPROVED, participants: p, event: { type: 'cancel_request', isApplicant: true } }).status, STATUS.CANCEL_REQUESTED);
    assert.throws(() => applyEvent({ status: STATUS.APPROVED, participants: p, event: { type: 'cancel_request', isApplicant: true, started: true } }), { code: 'STARTED' });
  });
  test('an approver cancels a cancel-request; a manager cancels anything live', () => {
    assert.equal(applyEvent({ status: STATUS.CANCEL_REQUESTED, participants: p, event: { type: 'cancel', actorId: 1 } }).status, STATUS.CANCELLED);
    assert.throws(() => applyEvent({ status: STATUS.APPROVED, participants: p, event: { type: 'cancel', actorId: 1 } }), { code: 'FORBIDDEN' });
    assert.equal(applyEvent({ status: STATUS.APPROVED, participants: p, event: { type: 'cancel', actorId: 9, canManage: true } }).status, STATUS.CANCELLED);
    assert.throws(() => applyEvent({ status: STATUS.REJECTED, participants: p, event: { type: 'cancel', canManage: true } }), { code: 'NOT_CANCELLABLE' });
  });
});

describe('the last approver locks the split', () => {
  test('isLastApprover is true only when everyone else has approved', () => {
    const p = people([1, 'approver', 'approved'], [2, 'approver'], [3, 'acknowledger']);
    assert.equal(isLastApprover(p, 2), true);
    assert.equal(isLastApprover(p, 1), false);
    assert.equal(isLastApprover(p, 3), false);
  });
});

describe('charge splits', () => {
  const enabled = new Set(['Annual', 'Sick']);
  test('2 sick + 3 annual for 5 days is valid', () => {
    assert.deepEqual(chargeValid([{ leaveType: 'Sick', days: 2 }, { leaveType: 'Annual', days: 3 }], 5, enabled), { ok: true });
  });
  test('must add up to the request', () => {
    assert.equal(chargeValid([{ leaveType: 'Annual', days: 4 }], 5, enabled).error, 'SUM_MISMATCH');
  });
  test('half days are fine; no negatives, no duplicates, no disabled types', () => {
    assert.equal(chargeValid([{ leaveType: 'Annual', days: 4.5 }, { leaveType: 'Sick', days: 0.5 }], 5, enabled).ok, true);
    assert.equal(chargeValid([{ leaveType: 'Annual', days: -1 }, { leaveType: 'Sick', days: 6 }], 5, enabled).error, 'BAD_DAYS');
    assert.equal(chargeValid([{ leaveType: 'Annual', days: 2 }, { leaveType: 'Annual', days: 3 }], 5, enabled).error, 'DUPLICATE_TYPE');
    assert.equal(chargeValid([{ leaveType: 'Study', days: 5 }], 5, enabled).error, 'TYPE_NOT_ENABLED');
  });
});
