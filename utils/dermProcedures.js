// =====================================================================
// Dermatology procedures — pure rules (Phase 3, 7 Oct 2026; decision H8).
//
// A procedure is RECORDED, not billed: a name from the clinic's list (the
// administrator keeps it in System Settings → Specialist modules), free-text
// details, and the findings it treated (one or more). Who did it comes from
// the login. Same-day edits by the author; afterwards an amendment with a
// reason (kept in DermEdits); never deleted — "entered in error".
//
// The clinic's list is a Setting row 'derm.procedures' (JSON array of names).
// No row = the starter list below. A procedure keeps the name it was saved
// with even if the list later changes.
// =====================================================================

const SETTING_KEY = 'derm.procedures';

const DEFAULT_PROCEDURES = [
  'Punch biopsy', 'Shave biopsy', 'Incisional biopsy', 'Excision biopsy',
  'Cryotherapy', 'Electrocautery', 'Curettage', 'Intralesional steroid injection',
  'Incision and drainage', 'Sharp debridement', 'Wound dressing', 'Nail avulsion',
];

// The name each skin-biopsy specimen type records as (H9).
const BIOPSY_PROCEDURE = {
  punch: 'Punch biopsy', shave: 'Shave biopsy', incisional: 'Incisional biopsy', excision: 'Excision biopsy',
};

const MAX_LIST = 60;
const MAX_NAME = 120;
const MAX_TARGETS = 30;
const PROCEDURE_FIELDS = ['name', 'details', 'findingIds'];

const fail = (message, field) => ({ ok: false, message, field });

/** Validate the administrator's list: 1–60 distinct names, each 1–120 characters. */
const cleanProcedureList = (list) => {
  if (!Array.isArray(list)) return fail('The procedure list must be a list of names', 'procedures');
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    if (typeof raw !== 'string') return fail('Each procedure must be a name', 'procedures');
    const name = raw.trim().replace(/\s+/g, ' ');
    if (!name) continue;
    if (name.length > MAX_NAME) return fail(`"${name.slice(0, 30)}…" is too long (${MAX_NAME} characters)`, 'procedures');
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  if (!out.length) return fail('Keep at least one procedure on the list', 'procedures');
  if (out.length > MAX_LIST) return fail(`At most ${MAX_LIST} procedures`, 'procedures');
  return { ok: true, value: out };
};

/** Parse the stored setting; anything unreadable falls back to the starter list. */
const parseProcedureList = (stored) => {
  if (!stored) return [...DEFAULT_PROCEDURES];
  try {
    const r = cleanProcedureList(JSON.parse(stored));
    return r.ok ? r.value : [...DEFAULT_PROCEDURES];
  } catch { return [...DEFAULT_PROCEDURES]; }
};

/**
 * Validate a procedure. `list` is the clinic's current list — a NEW name must
 * be on it (matched case-insensitively, stored as the list spells it). On an
 * edit (`partial`), only what was sent is checked, and the name it already
 * has (`currentName`) stays valid even if it has since left the list.
 */
const cleanProcedure = (body = {}, list = DEFAULT_PROCEDURES, { partial = false, currentName = null } = {}) => {
  const value = {};
  if (!partial || body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) return fail('Choose the procedure', 'name');
    const wanted = body.name.trim().toLowerCase();
    const hit = list.find((n) => n.toLowerCase() === wanted)
      || (currentName && currentName.toLowerCase() === wanted ? currentName : null);
    if (!hit) return fail('Choose a procedure from the clinic list', 'name');
    value.name = hit;
  }
  if (!partial || body.details !== undefined) {
    if (body.details === null || body.details === undefined) value.details = null;
    else if (typeof body.details !== 'string') return fail('Details must be text', 'details');
    else if (body.details.length > 4000) return fail('Details are too long', 'details');
    else value.details = body.details.trim() || null;
  }
  if (!partial || body.findingIds !== undefined) {
    if (!Array.isArray(body.findingIds)) return fail('Choose the finding(s) treated', 'findingIds');
    const ids = [...new Set(body.findingIds.map(Number))];
    if (!ids.length) return fail('Choose the finding(s) treated', 'findingIds');
    if (ids.some((n) => !Number.isInteger(n) || n <= 0)) return fail('Unknown finding', 'findingIds');
    if (ids.length > MAX_TARGETS) return fail(`At most ${MAX_TARGETS} findings per procedure`, 'findingIds');
    value.findingIds = ids.sort((a, b) => a - b);
  }
  return { ok: true, value };
};

/** Same rule as a day's look (D7): the author, the same clinic day, edits in place. */
const procedureChangeMode = (procedure, userId, today) => (
  procedure.performedById === userId && procedure.procedureDate === today ? 'edit' : 'amend'
);

module.exports = {
  SETTING_KEY, DEFAULT_PROCEDURES, BIOPSY_PROCEDURE, PROCEDURE_FIELDS,
  cleanProcedureList, parseProcedureList, cleanProcedure, procedureChangeMode,
};
