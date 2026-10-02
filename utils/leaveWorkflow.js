// The leave request workflow — who has decided what, and what that makes the request.
//
// B27 (spec §5, decisions D5–D7, Emu 27 Sep 2026). Pure: the controller loads
// the rows, asks these functions what happens, and writes the answer.
//
//   - The applicant picks the people. APPROVERS must ALL approve; ACKNOWLEDGERS
//     are only told. At least one approver must hold leave.approve. Nobody lists
//     themselves. No separate HR step: every approver approved = Approved.
//   - Any approver may Approve, Decline, or Ask for more information.
//     Decline is final. Asking parks the request (InfoRequested) until the
//     applicant replies; the asker goes back to pending, everyone else keeps
//     their answer.
//   - The approver whose approval completes the request LOCKS the charge
//     split (which balances the days come off).

const STATUS = Object.freeze({
  PENDING: 'Pending',
  INFO_REQUESTED: 'InfoRequested',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',          // shown as "Declined"
  WITHDRAWN: 'Withdrawn',
  CANCEL_REQUESTED: 'CancelRequested',
  CANCELLED: 'Cancelled',
});

const ALL_STATUSES = Object.values(STATUS);
const OPEN_STATUSES = [STATUS.PENDING, STATUS.INFO_REQUESTED];
// Statuses whose days count against a balance. Booked = waiting; taken = approved
// (CancelRequested is still approved leave until someone cancels it).
const TAKEN_STATUSES = [STATUS.APPROVED, STATUS.CANCEL_REQUESTED];
const BOOKED_STATUSES = OPEN_STATUSES;

// COVER (HR Tier 2, 2 Oct 2026): the colleague who covers the applicant's work.
// Never an approver — approversOf() and every decision rule ignore it; their
// "agreed"/"can't cover" is stored as decision approved/declined and shown only.
const KIND = Object.freeze({ APPROVER: 'approver', ACKNOWLEDGER: 'acknowledger', COVER: 'cover' });
const DECISION = Object.freeze({
  PENDING: 'pending', APPROVED: 'approved', DECLINED: 'declined', INFO: 'info_requested', NOTIFIED: 'notified',
});

class WorkflowError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

/**
 * Checks the people the applicant chose.
 *
 * @param {object[]} list          [{ userId, kind }]
 * @param {number}   applicantId
 * @param {object}   ctx
 * @param {Set<number>} ctx.approveHolders   users who hold leave.approve
 * @param {Set<number>} ctx.activeUsers      users who are active staff (not archived)
 * @returns {{ ok: boolean, errors: string[] }}
 */
const validateParticipants = (list, applicantId, { approveHolders = new Set(), activeUsers = null } = {}) => {
  const errors = [];
  if (!Array.isArray(list) || list.length === 0) return { ok: false, errors: ['NO_APPROVER'] };

  const seen = new Set();
  for (const p of list) {
    const id = Number(p?.userId);
    if (!Number.isInteger(id) || id <= 0) { errors.push('BAD_USER'); continue; }
    if (![KIND.APPROVER, KIND.ACKNOWLEDGER].includes(p.kind)) errors.push('BAD_KIND');
    if (id === Number(applicantId)) errors.push('SELF');
    if (seen.has(id)) errors.push('DUPLICATE');
    seen.add(id);
    if (activeUsers && !activeUsers.has(id)) errors.push('INACTIVE');
  }

  const approvers = list.filter((p) => p?.kind === KIND.APPROVER);
  if (approvers.length === 0) errors.push('NO_APPROVER');
  else if (!approvers.some((p) => approveHolders.has(Number(p.userId)))) errors.push('NO_APPROVE_HOLDER');

  const unique = [...new Set(errors)];
  return { ok: unique.length === 0, errors: unique };
};

/**
 * The applicant's chosen people with HR's required approvers forced in (HR
 * Tier 2): a required person already listed becomes an approver; a missing
 * one is added as an approver, first. The applicant is never added to their
 * own request. Pure — the controller passes only active required approvers.
 *
 * @param {object[]} list          [{ userId, kind }]
 * @param {number[]} requiredIds
 * @param {number}   applicantId
 * @returns {object[]}             [{ userId, kind, required? }]
 */
const mergeRequired = (list, requiredIds = [], applicantId) => {
  const req = [...new Set(requiredIds.map(Number))].filter((id) => Number.isInteger(id) && id > 0 && id !== Number(applicantId));
  const out = (Array.isArray(list) ? list : []).map((p) => (req.includes(Number(p?.userId))
    ? { ...p, userId: Number(p.userId), kind: KIND.APPROVER, required: true }
    : { ...p }));
  const missing = req.filter((id) => !out.some((p) => Number(p.userId) === id))
    .map((id) => ({ userId: id, kind: KIND.APPROVER, required: true }));
  return [...missing, ...out];
};

/**
 * Is this cover choice acceptable? → null or an error code.
 *   BAD_COVER — not a person; COVER_SELF — the applicant; COVER_LISTED — already
 *   an approver/acknowledger (one role each); COVER_INACTIVE — archived or gone.
 */
const coverError = (coverId, applicantId, list = [], activeUsers = null) => {
  if (coverId === undefined || coverId === null || coverId === '') return null;
  const id = Number(coverId);
  if (!Number.isInteger(id) || id <= 0) return 'BAD_COVER';
  if (id === Number(applicantId)) return 'COVER_SELF';
  if (list.some((p) => Number(p?.userId) === id)) return 'COVER_LISTED';
  if (activeUsers && !activeUsers.has(id)) return 'COVER_INACTIVE';
  return null;
};

const clone = (participants) => participants.map((p) => ({ ...p }));
const approversOf = (participants) => participants.filter((p) => p.kind === KIND.APPROVER);

/**
 * Applies one event to a request.
 *
 * @param {object} args
 * @param {string}   args.status          current StaffLeave.status
 * @param {object[]} args.participants    [{ userId, kind, decision }]
 * @param {object}   args.event           { type, actorId, isApplicant, canManage }
 *   type ∈ approve | decline | info | reply | withdraw | cancel_request | cancel
 * @returns {{ status: string, participants: object[], final: boolean }}
 *   `final` = this event made the request Approved (the caller locks charges
 *   and applies the approval side effects).
 * @throws {WorkflowError}
 */
const applyEvent = ({ status, participants = [], event = {} }) => {
  const next = clone(participants);
  const actor = next.find((p) => Number(p.userId) === Number(event.actorId));
  const isApprover = !!actor && actor.kind === KIND.APPROVER;

  switch (event.type) {
    case 'approve':
    case 'decline':
    case 'info': {
      if (!OPEN_STATUSES.includes(status)) throw new WorkflowError('NOT_OPEN', 'This request is no longer waiting for a decision.');
      if (!isApprover) throw new WorkflowError('NOT_APPROVER', 'You are not an approver on this request.');
      if (actor.decision === DECISION.APPROVED && event.type === 'approve') {
        throw new WorkflowError('ALREADY_DECIDED', 'You have already approved this request.');
      }

      if (event.type === 'decline') {
        actor.decision = DECISION.DECLINED;
        return { status: STATUS.REJECTED, participants: next, final: false };
      }
      if (event.type === 'info') {
        actor.decision = DECISION.INFO;
        return { status: STATUS.INFO_REQUESTED, participants: next, final: false };
      }

      actor.decision = DECISION.APPROVED;
      const approvers = approversOf(next);
      const waitingOnInfo = approvers.some((p) => p.decision === DECISION.INFO);
      const allApproved = approvers.length > 0 && approvers.every((p) => p.decision === DECISION.APPROVED);
      if (allApproved) return { status: STATUS.APPROVED, participants: next, final: true };
      return { status: waitingOnInfo ? STATUS.INFO_REQUESTED : STATUS.PENDING, participants: next, final: false };
    }

    case 'reply': {
      if (!event.isApplicant) throw new WorkflowError('NOT_APPLICANT', 'Only the person who applied can reply.');
      if (status !== STATUS.INFO_REQUESTED) throw new WorkflowError('NO_QUESTION', 'Nobody has asked for more information.');
      next.forEach((p) => { if (p.decision === DECISION.INFO) p.decision = DECISION.PENDING; });
      return { status: STATUS.PENDING, participants: next, final: false };
    }

    case 'withdraw': {
      if (!event.isApplicant) throw new WorkflowError('NOT_APPLICANT', 'Only the person who applied can withdraw it.');
      if (!OPEN_STATUSES.includes(status)) throw new WorkflowError('NOT_OPEN', 'Only a request still waiting for a decision can be withdrawn.');
      return { status: STATUS.WITHDRAWN, participants: next, final: false };
    }

    case 'cancel_request': {
      if (!event.isApplicant) throw new WorkflowError('NOT_APPLICANT', 'Only the person who applied can ask to cancel.');
      if (status !== STATUS.APPROVED) throw new WorkflowError('NOT_APPROVED', 'Only approved leave can be cancelled.');
      if (event.started) throw new WorkflowError('STARTED', 'This leave has already started — ask HR to cut it short.');
      return { status: STATUS.CANCEL_REQUESTED, participants: next, final: false };
    }

    case 'cancel': {
      const allowed = event.canManage || (isApprover && status === STATUS.CANCEL_REQUESTED);
      if (!allowed) throw new WorkflowError('FORBIDDEN', 'You cannot cancel this leave.');
      if (![...OPEN_STATUSES, STATUS.APPROVED, STATUS.CANCEL_REQUESTED].includes(status)) {
        throw new WorkflowError('NOT_CANCELLABLE', 'This leave cannot be cancelled.');
      }
      return { status: STATUS.CANCELLED, participants: next, final: false };
    }

    default:
      throw new WorkflowError('BAD_EVENT', `Unknown event ${event.type}`);
  }
};

/**
 * Would this person's approval complete the request? The screen uses it to
 * tell the last approver that their charge split is the one that sticks.
 */
const isLastApprover = (participants, userId) => {
  const approvers = approversOf(participants);
  const me = approvers.find((p) => Number(p.userId) === Number(userId));
  if (!me) return false;
  return approvers.every((p) => p === me || p.decision === DECISION.APPROVED);
};

/**
 * Checks a charge split: [{ leaveType, days }].
 * Must add up to the request's days, each part positive, each type enabled
 * this year, each type at most once.
 */
const chargeValid = (charges, totalDays, enabledTypes = null) => {
  if (!Array.isArray(charges) || charges.length === 0) return { ok: false, error: 'NO_CHARGES' };
  const seen = new Set();
  let sum = 0;
  for (const c of charges) {
    const days = Number(c?.days);
    if (!c || typeof c.leaveType !== 'string' || !c.leaveType) return { ok: false, error: 'BAD_TYPE' };
    if (!Number.isFinite(days) || days <= 0) return { ok: false, error: 'BAD_DAYS' };
    if (Math.round(days * 100) % 25 !== 0) return { ok: false, error: 'BAD_DAYS' };   // quarter-day steps at most
    if (seen.has(c.leaveType)) return { ok: false, error: 'DUPLICATE_TYPE' };
    if (enabledTypes && !enabledTypes.has(c.leaveType)) return { ok: false, error: 'TYPE_NOT_ENABLED' };
    seen.add(c.leaveType);
    sum += days;
  }
  if (Math.abs(sum - Number(totalDays)) > 0.001) return { ok: false, error: 'SUM_MISMATCH' };
  return { ok: true };
};

/**
 * The On Leave sweep (phase 3): which staff profiles change today.
 *
 *   - Active → On Leave: approved leave covers today.
 *   - On Leave → Active: no approved leave covers today AND approved leave
 *     ended within the last week. The second condition is what keeps a
 *     status HR set by hand (no leave record behind it) from being undone.
 *   Suspended / Resigned / Terminated are never touched.
 *
 * @param {object} args
 * @param {{ userId:number, status:string }[]} args.profiles
 * @param {Set<number>} args.coveringToday
 * @param {Set<number>} args.endedRecently
 * @returns {{ toOnLeave: number[], toActive: number[] }}
 */
const employmentFlips = ({ profiles = [], coveringToday = new Set(), endedRecently = new Set() } = {}) => ({
  toOnLeave: profiles.filter((p) => p.status === 'Active' && coveringToday.has(p.userId)).map((p) => p.userId),
  toActive: profiles
    .filter((p) => p.status === 'On Leave' && !coveringToday.has(p.userId) && endedRecently.has(p.userId))
    .map((p) => p.userId),
});

module.exports = {
  employmentFlips,
  STATUS,
  ALL_STATUSES,
  OPEN_STATUSES,
  TAKEN_STATUSES,
  BOOKED_STATUSES,
  KIND,
  DECISION,
  WorkflowError,
  validateParticipants,
  mergeRequired,
  coverError,
  applyEvent,
  isLastApprover,
  chargeValid,
};
