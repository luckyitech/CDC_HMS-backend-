// =====================================================================
// Today's Consultation — the tool list and each doctor's choice of it
// (7 Oct 2026, decision D16).
//
// Emu: "everything in the today's visit is a tool — including notes. So we
// will eventually make them all options and doctors can choose how their
// consultation will look." This is that mechanism, built once:
//
//   TOOLS              every tool the screen knows, by id. The frontend keeps
//                      the same ids in constants/consultationTools.js (a test
//                      fails if they differ).
//   cleanToolPrefs     one doctor's choice — order, hidden, always-open —
//                      reduced to known ids, saved in UserPreferences under
//                      the key 'consultation.tools'.
//
// 10 Oct 2026 (Emu, plan M1–M9): EVERY section of Today's Consultation is a
// module — Consultation notes, Physical examination,
// Treatment plan, GLP-1, Dermatology, Orders. TOOLS is listed in the clinic's
// default order (M7). Orders (prescriptions, labs, billing) is `neverHidden`:
// it may be moved but never hidden (M3) — cleanToolPrefs drops it from
// `hidden` silently. Completing a visit needs an active diagnosis (M4), so
// hiding Notes or Plan never blocks a doctor.
//
// 10 Oct 2026 (later): the Initial assessment module is RETIRED — its content
// became history sections inside Consultation notes (utils/noteSections.js).
// A saved 'assessment' id in anyone's preference is dropped by cleanToolPrefs.
//
// A tool that needs a clinic module (Dermatology) is simply not shown while
// the module is off; the preference is kept, so switching the module back on
// restores each doctor's layout.
// =====================================================================

const TOOLS = [
  { id: 'notes',       label: 'Consultation notes' },
  { id: 'exam',        label: 'Physical examination' },
  { id: 'plan',        label: 'Treatment plan' },
  { id: 'glp1',        label: 'GLP-1 / GIP agonist monitoring' },
  { id: 'dermatology', label: 'Dermatology · skin record', module: 'dermatology' },
  { id: 'orders',      label: 'Orders', neverHidden: true },
];
const TOOL_IDS = TOOLS.map((t) => t.id);
const NEVER_HIDDEN = TOOLS.filter((t) => t.neverHidden).map((t) => t.id);
const COMPLETES_VISIT = NEVER_HIDDEN;   // old name (D16), kept for callers

const ids = (v) => (Array.isArray(v) ? [...new Set(v.filter((x) => TOOL_IDS.includes(x)))] : []);

/**
 * @param {*} value  what the client sent
 * @returns {{order:string[], hidden:string[], open:string[]}}
 */
const cleanToolPrefs = (value) => {
  const v = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const order = ids(v.order);
  const hidden = ids(v.hidden).filter((id) => !NEVER_HIDDEN.includes(id));
  const open = ids(v.open).filter((id) => !hidden.includes(id));
  return { order, hidden, open };
};

// Every preference a user may store, with its cleaner. Anything else is refused.
const PREFERENCE_KEYS = {
  'consultation.tools': cleanToolPrefs,
};

module.exports = { TOOLS, TOOL_IDS, NEVER_HIDDEN, COMPLETES_VISIT, cleanToolPrefs, PREFERENCE_KEYS };
