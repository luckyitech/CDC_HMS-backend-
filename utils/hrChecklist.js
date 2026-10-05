// Pure rules for the shared HR checklist (HR Suite → Manual → Checklist,
// 5 Oct 2026). No database: the controller asks these, the tests assert them.
//
// Keys. Built-in items are defined by the frontend content module (generated
// from the HR Suite Manual) with stable keys such as "golive-departments" or
// "day3-holidays": "<section>-<words>". The server does not hold their
// wording, but it does hold the list of built-in keys and sections:
// constants/hrChecklistKeys.json, written by the same build
// (cdc-hms/scripts/build-hr-manual.mjs --backend), so an unknown key or
// section is refused rather than stored as an invisible row. Items HR adds
// get "custom-<hex>" from the server; a client can never invent one.
const BUILT_IN = require('../constants/hrChecklistKeys.json').sections;
const SECTIONS = Object.keys(BUILT_IN);
const SECTION_OF = new Map(Object.entries(BUILT_IN).flatMap(([section, keys]) => keys.map((k) => [k, section])));

const SECTION_RE = /^[a-z][a-z0-9]{1,19}$/;
const KEY_RE = /^[a-z][a-z0-9]{1,19}(-[a-z0-9]+){1,8}$/;
const MAX_KEY = 64;
const MAX_LABEL = 300;
const MAX_NOTE = 500;

const isCustomKey = (key) => typeof key === 'string' && key.startsWith('custom-');

/** A well-formed item key (built-in or custom). */
const isValidKey = (key) => typeof key === 'string' && key.length <= MAX_KEY && KEY_RE.test(key);

/** The section a BUILT-IN key belongs to ("day3-holidays" → "day3"); null if it is not one. */
const sectionOfKey = (key) => (isValidKey(key) && !isCustomKey(key) ? SECTION_OF.get(key) || null : null);

/** A key the API acts on: a built-in key from the manual, or a well-formed custom key. */
const isKnownKey = (key) => isValidKey(key) && (isCustomKey(key) || SECTION_OF.has(key));

/** A section of the manual's checklist (custom items go into one of these). */
const isValidSection = (section) => typeof section === 'string' && SECTION_RE.test(section) && SECTIONS.includes(section);

const clean = (value, max) => {
  if (value === undefined || value === null) return '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, max);
};

/** { value } or { error } for a note ('' clears it). */
const cleanNote = (value) => {
  if (value !== undefined && value !== null && typeof value !== 'string') return { error: 'The note must be text.' };
  if (typeof value === 'string' && value.trim().length > MAX_NOTE) return { error: `Keep the note under ${MAX_NOTE} characters.` };
  return { value: clean(value, MAX_NOTE) || null };
};

/** { value: { section, label } } or { error } for a new custom item. */
const cleanNewItem = (body = {}) => {
  const label = typeof body.label === 'string' ? clean(body.label, MAX_LABEL + 1) : '';
  if (!label) return { error: 'Write what the item is.' };
  if (label.length > MAX_LABEL) return { error: `Keep the item under ${MAX_LABEL} characters.` };
  if (!isValidSection(body.section)) return { error: 'Choose a section for the item.' };
  return { value: { section: body.section, label } };
};

const fullName = (u) => (u ? `${u.firstName || ''} ${u.lastName || ''}`.trim() || null : null);

/** The patch + history row for a tick (done=true) or untick, attributed to actorId. */
const tickChange = (item, done, actorId, now = new Date()) => {
  if (item && !!item.done === !!done) return null;   // nothing changes
  return {
    patch: done ? { done: true, doneById: actorId, doneAt: now } : { done: false, doneById: null, doneAt: null },
    event: { action: done ? 'tick' : 'untick', byId: actorId },
  };
};

/** The patch + history row for a note change, attributed to actorId. */
const noteChange = (item, note, actorId, now = new Date()) => {
  if ((item?.note || null) === (note || null)) return null;
  return {
    patch: { note: note || null, noteById: note ? actorId : null, noteAt: note ? now : null },
    event: { action: 'note', byId: actorId, detail: note || null },
  };
};

/** What the API returns for one item row. */
const itemView = (row) => ({
  key: row.itemKey,
  section: row.section,
  label: row.label,
  isCustom: !!row.isCustom,
  status: row.status,
  done: !!row.done,
  doneAt: row.doneAt,
  doneBy: fullName(row.doneBy),
  note: row.note,
  noteAt: row.noteAt,
  noteBy: fullName(row.noteBy),
  createdBy: row.isCustom ? fullName(row.createdBy) : null,
  createdAt: row.createdAt,
});

const eventView = (row) => ({
  id: row.id, key: row.itemKey, action: row.action, detail: row.detail, at: row.createdAt, by: fullName(row.by),
});

module.exports = {
  MAX_NOTE, MAX_LABEL,
  SECTIONS, isCustomKey, isValidKey, isKnownKey, sectionOfKey, isValidSection,
  cleanNote, cleanNewItem, tickChange, noteChange, itemView, eventView, fullName,
};
