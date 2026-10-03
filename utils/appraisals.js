// =====================================================================
// Appraisals — the PURE rules (HR Tier 3 Phase 5; mockup E; T3-9 a — a
// yearly clinic-wide window: self-assessment, then reviewer, ratings 1–4 on
// HR-editable competencies plus comments and objectives, the person
// acknowledges; T3-10 a — read by the person, their reviewer and holders of
// hr.appraisals, which full admin access does NOT carry). No database here.
//
// One appraisal walks:  self → review → sent → acknowledged   (or cancelled)
//   self          the person fills their self-assessment (draft until submit)
//   review        the reviewer rates, comments, sets objectives
//   sent          the person reads it, may comment, acknowledges
//   acknowledged  locked for good
//
// Who sees what (viewFor) — one role per viewer, in this order:
//   person   their own appraisal. The reviewer's ratings, comments, summary
//            and objectives only once it is SENT (never a draft).
//   reviewer the person's self-assessment only once SUBMITTED; their own
//            fields always.
//   reader   (hr.appraisals) everything.
// Anyone else: not found. A person never reads their own appraisal as a
// reader or reviewer — the person role wins.
// =====================================================================

const STATUSES = ['self', 'review', 'sent', 'acknowledged', 'cancelled'];
const LIVE = ['self', 'review', 'sent'];
const RATING_LABELS = { 1: 'Needs support', 2: 'Developing', 3: 'Meets', 4: 'Exceeds' };
const STATUS_LABELS = {
  self: 'Self-assessment', review: 'With reviewer', sent: 'To acknowledge',
  acknowledged: 'Acknowledged', cancelled: 'Cancelled',
};
// Starter competencies (seeded once by migration …014, then HR's to edit).
const STARTER_COMPETENCIES = [
  { name: 'Quality of work and patient safety', description: 'Accurate, careful, safe work; follows clinic protocols.' },
  { name: 'Teamwork and communication', description: 'Works well with colleagues and patients; shares information clearly.' },
  { name: 'Reliability and attendance', description: 'On time, dependable, follows through.' },
  { name: 'Learning and development', description: 'Keeps skills current; CPD; takes on feedback.' },
];

const isRating = (v) => Number.isInteger(v) && v >= 1 && v <= 4;

/** The viewer's role on an appraisal, or null (→ 404). */
const roleOf = ({ appraisal, userId, canRead }) => {
  if (!appraisal) return null;
  if (Number(appraisal.UserId) === Number(userId)) return 'person';
  if (appraisal.reviewerId != null && Number(appraisal.reviewerId) === Number(userId)) return 'reviewer';
  if (canRead) return 'reader';
  return null;
};

const selfVisible = (role, status) => role === 'person' || role === 'reader' || (role === 'reviewer' && status !== 'self');
const reviewVisible = (role, status) => role === 'reviewer' || role === 'reader' || (role === 'person' && ['sent', 'acknowledged'].includes(status));

/**
 * What the viewer may do now.
 * @param {string} role       from roleOf
 * @param {string} status
 * @param {boolean} cycleOpen
 */
const actionsFor = (role, status, cycleOpen) => ({
  editSelf: cycleOpen && role === 'person' && status === 'self',
  editReview: cycleOpen && role === 'reviewer' && status === 'review',
  acknowledge: cycleOpen && role === 'person' && status === 'sent',
});

/**
 * Shape an appraisal for this viewer (redacting what their role may not see).
 * `a` is a plain row with `ratings` and `objectives` arrays.
 */
const viewFor = (a, role) => {
  const sv = selfVisible(role, a.status);
  const rv = reviewVisible(role, a.status);
  return {
    id: a.id, status: a.status, statusLabel: STATUS_LABELS[a.status],
    selfSubmittedAt: a.selfSubmittedAt || null, sentAt: a.sentAt || null, acknowledgedAt: a.acknowledgedAt || null,
    meetingOn: rv ? (a.meetingOn || null) : null,
    selfSummary: sv ? (a.selfSummary || '') : null,
    reviewerSummary: rv ? (a.reviewerSummary || '') : null,
    personComment: (role === 'person' || ['acknowledged'].includes(a.status) || role === 'reader') ? (a.personComment || '') : null,
    cancelledNote: a.status === 'cancelled' ? (a.cancelledNote || '') : null,
    ratings: (a.ratings || []).map((r) => ({
      id: r.id, name: r.name, sortOrder: r.sortOrder,
      selfRating: sv ? (r.selfRating ?? null) : null, selfComment: sv ? (r.selfComment || '') : null,
      reviewerRating: rv ? (r.reviewerRating ?? null) : null, reviewerComment: rv ? (r.reviewerComment || '') : null,
    })),
    objectives: rv ? (a.objectives || []).filter((o) => o.status !== 'removed').map((o) => ({ id: o.id, text: o.text, dueBy: o.dueBy || null })) : [],
    visible: { self: sv, review: rv },
  };
};

/**
 * Clean the ratings part of a save. `side` is 'self' or 'reviewer'.
 * @returns {{ value: [{id, rating, comment}] } | { error }}
 */
const cleanRatings = (input, side, knownIds) => {
  if (input === undefined) return { value: [] };
  if (!Array.isArray(input)) return { error: 'BAD_RATINGS' };
  const known = new Set(knownIds.map(Number));
  const out = [];
  for (const r of input) {
    if (!known.has(Number(r?.id))) return { error: 'BAD_RATINGS' };
    const raw = side === 'self' ? r.selfRating : r.reviewerRating;
    const rating = raw === null || raw === undefined || raw === '' ? null : Number(raw);
    if (rating !== null && !isRating(rating)) return { error: 'BAD_RATING' };
    const comment = side === 'self' ? r.selfComment : r.reviewerComment;
    if (comment != null && String(comment).length > 2000) return { error: 'TOO_LONG' };
    out.push({ id: Number(r.id), rating, comment: comment == null ? undefined : String(comment).trim() });
  }
  return { value: out };
};

/** Every competency rated on this side? (needed to submit / send) */
const allRated = (ratings, side) => ratings.length > 0
  && ratings.every((r) => isRating(side === 'self' ? r.selfRating : r.reviewerRating));

/** Clean objectives from the reviewer: [{id?, text, dueBy, remove}] */
const cleanObjectives = (input) => {
  if (input === undefined) return { value: [] };
  if (!Array.isArray(input) || input.length > 20) return { error: 'BAD_OBJECTIVES' };
  const out = [];
  for (const o of input) {
    const text = String(o?.text ?? '').trim();
    if (!o?.remove && !text) return { error: 'OBJECTIVE_TEXT' };
    if (text.length > 300) return { error: 'TOO_LONG' };
    const dueBy = o?.dueBy ? String(o.dueBy) : null;
    if (dueBy && !/^\d{4}-\d{2}-\d{2}$/.test(dueBy)) return { error: 'BAD_DATE' };
    out.push({ id: o?.id ? Number(o.id) : null, text, dueBy, remove: !!o?.remove });
  }
  return { value: out };
};

/** Clean a cycle from the client. */
const cleanCycle = (input = {}, { partial = false } = {}) => {
  const out = {};
  if (!partial || input.year !== undefined) {
    const y = Number(input.year);
    if (!Number.isInteger(y) || y < 2020 || y > 2100) return { error: 'BAD_YEAR' };
    out.year = y;
  }
  if (!partial || input.name !== undefined) {
    const name = String(input.name ?? '').trim();
    out.name = name || (out.year ? `${out.year} appraisal` : '');
    if (!out.name) return { error: 'NAME_REQUIRED' };
    if (out.name.length > 80) return { error: 'TOO_LONG' };
  }
  for (const key of ['selfDueOn', 'reviewDueOn']) {
    if (!partial || input[key] !== undefined) {
      const v = input[key] ? String(input[key]) : null;
      if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return { error: 'BAD_DATE' };
      out[key] = v;
    }
  }
  if (out.selfDueOn && out.reviewDueOn && out.reviewDueOn < out.selfDueOn) return { error: 'DUE_ORDER' };
  return { value: out };
};

/** Clean a competency. */
const cleanCompetency = (input = {}, { partial = false } = {}) => {
  const out = {};
  if (!partial || input.name !== undefined) {
    const name = String(input.name ?? '').trim().replace(/\s+/g, ' ');
    if (!name) return { error: 'NAME_REQUIRED' };
    if (name.length > 120) return { error: 'TOO_LONG' };
    out.name = name;
  }
  if (input.description !== undefined) {
    const d = String(input.description ?? '').trim();
    if (d.length > 300) return { error: 'TOO_LONG' };
    out.description = d || null;
  }
  if (input.sortOrder !== undefined) {
    const n = Number(input.sortOrder);
    if (!Number.isInteger(n)) return { error: 'BAD_ORDER' };
    out.sortOrder = n;
  }
  if (input.status !== undefined) {
    if (!['active', 'archived'].includes(input.status)) return { error: 'BAD_STATUS' };
    out.status = input.status;
  }
  return { value: out };
};

/** The reviewer a new appraisal starts with: whoever the person reports to, if usable. */
const defaultReviewer = ({ personId, reportsToId, activeIds }) => {
  if (!reportsToId || Number(reportsToId) === Number(personId)) return null;
  return activeIds.has(Number(reportsToId)) ? Number(reportsToId) : null;
};

module.exports = {
  STATUSES, LIVE, RATING_LABELS, STATUS_LABELS, STARTER_COMPETENCIES,
  isRating, roleOf, actionsFor, viewFor, cleanRatings, allRated, cleanObjectives,
  cleanCycle, cleanCompetency, defaultReviewer,
};
