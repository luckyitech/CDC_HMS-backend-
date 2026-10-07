// Autosave drafts — the pure rules (6 Oct 2026). DB work lives in
// controllers/formDraftController and services/draftSweep; both ask here.
//
// A draft is the author's own unsaved typing. It is never part of the medical
// record: only the author reads it, the real save deletes it, and a draft
// untouched for DRAFT_LIFETIME_DAYS is deleted (one bell reminder on
// REMINDER_DAY first).

const DRAFT_LIFETIME_DAYS = 14;
const REMINDER_DAY = 12;
const DAY_MS = 24 * 3600 * 1000;

// Roughly 2 MB of form state. The physical exam keeps clinical photos in its
// state; anything larger than this is refused (the form keeps its local copy).
const MAX_PAYLOAD_CHARS = 2 * 1024 * 1024;

// formKey: lower-case words and dashes ('consultation-notes', 'ward-round');
// contextKey: '' or a short id-like value ('adm-12', '2026-10-06').
const FORM_KEY_RE = /^[a-z][a-z0-9-]{1,63}$/;
const CONTEXT_KEY_RE = /^[A-Za-z0-9:_.-]{0,64}$/;

const clip = (value, max) => (value == null ? null : String(value).trim().slice(0, max) || null);

const isFormKey = (k) => typeof k === 'string' && FORM_KEY_RE.test(k);
const cleanContextKey = (k) => {
  if (k == null || k === '') return '';
  const s = String(k);
  return CONTEXT_KEY_RE.test(s) ? s : null;
};

/**
 * Validates a save. Returns { ok: true, value } or { ok: false, message, code }.
 * `payload` may be any JSON value except undefined/null.
 */
const cleanSave = (body = {}) => {
  if (!isFormKey(body.formKey)) return { ok: false, code: 'BAD_FORM_KEY', message: 'Unknown form.' };
  const contextKey = cleanContextKey(body.contextKey);
  if (contextKey === null) return { ok: false, code: 'BAD_CONTEXT', message: 'Bad draft context.' };
  if (body.payload === undefined || body.payload === null) {
    return { ok: false, code: 'NO_PAYLOAD', message: 'Nothing to save.' };
  }
  let text;
  try { text = JSON.stringify(body.payload); } catch { return { ok: false, code: 'NO_PAYLOAD', message: 'Nothing to save.' }; }
  if (text.length > MAX_PAYLOAD_CHARS) {
    return { ok: false, code: 'TOO_LARGE', message: 'This draft is too large to keep on the server; it stays on this device.' };
  }
  return {
    ok: true,
    value: {
      formKey: body.formKey,
      contextKey,
      label: clip(body.label, 120),
      device: clip(body.device, 60),
      payload: text,
    },
  };
};

/** The stored payload back as a value (null if unreadable). */
const readPayload = (text) => {
  if (text == null) return null;
  if (typeof text !== 'string') return text;
  try { return JSON.parse(text); } catch { return null; }
};

const ageDays = (updatedAt, now = new Date()) =>
  (now.getTime() - new Date(updatedAt).getTime()) / DAY_MS;

const isExpired = (draft, now = new Date()) => ageDays(draft.updatedAt, now) >= DRAFT_LIFETIME_DAYS;

const needsReminder = (draft, now = new Date()) =>
  !draft.reminderSentAt && !isExpired(draft, now) && ageDays(draft.updatedAt, now) >= REMINDER_DAY;

/** The date a draft will be deleted. */
const expiresAt = (updatedAt) => new Date(new Date(updatedAt).getTime() + DRAFT_LIFETIME_DAYS * DAY_MS);

/** What the API returns for one draft. `withPayload` false for lists. */
const draftView = (row, { withPayload = true, patient = null } = {}) => {
  if (!row) return null;
  const view = {
    id: row.id,
    formKey: row.formKey,
    contextKey: row.contextKey || '',
    label: row.label || null,
    device: row.device || null,
    updatedAt: row.updatedAt,
    expiresAt: expiresAt(row.updatedAt),
  };
  if (withPayload) view.payload = readPayload(row.payload);
  if (patient) view.patient = patient;
  return view;
};

module.exports = {
  DRAFT_LIFETIME_DAYS,
  REMINDER_DAY,
  MAX_PAYLOAD_CHARS,
  isFormKey,
  cleanContextKey,
  cleanSave,
  readPayload,
  ageDays,
  isExpired,
  needsReminder,
  expiresAt,
  draftView,
};
