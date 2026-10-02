// A member of staff's own record — what they may change themselves, and what
// they must ask HR to change. B27 phase 4 (My profile), decision D11.
//
// Pure: no database. hrProfileController loads the rows and asks these
// functions.
//
//   CONTACT   — phone, address, city, emergency contact. Saved DIRECTLY by the
//               person (logged in UserEditLog like any other edit).
//   REQUEST   — name, date of birth, gender, National ID, licence and
//               qualification details. Sent as a change request that a holder
//               of hr.profile.approve approves or rejects; an approved change
//               is written to the staff file and logged.
//   Everything else (position, department, employment dates, email, status)
//   is HR's and read-only to the person.
//
// Email is deliberately NOT requestable: it is the login and where the HMS
// sends password resets — HR changes it on the staff file.

const CONTACT_FIELDS = ['phone', 'address', 'city', 'emergencyContact'];
const EMERGENCY_KEYS = ['name', 'relationship', 'phone'];

// key → where it lives and how it is checked.
const REQUESTABLE = {
  firstName:       { label: 'First name',         table: 'user',    type: 'text', max: 60, required: true },
  lastName:        { label: 'Last name',          table: 'user',    type: 'text', max: 60, required: true },
  dateOfBirth:     { label: 'Date of birth',      table: 'profile', type: 'date' },
  gender:          { label: 'Gender',             table: 'profile', type: 'select', options: ['Male', 'Female', 'Other'] },
  idNumber:        { label: 'National ID',        table: 'profile', type: 'text', max: 40 },
  licenseNumber:   { label: 'Licence number',     table: 'profile', type: 'text', max: 60 },
  licenseBody:     { label: 'Licence issuing body', table: 'profile', type: 'text', max: 120 },
  licenseExpiry:   { label: 'Licence expiry',     table: 'profile', type: 'date' },
  specialty:       { label: 'Specialty',          table: 'profile', type: 'text', max: 120 },
  qualification:   { label: 'Qualification',      table: 'profile', type: 'text', max: 160 },
  institution:     { label: 'Institution',        table: 'profile', type: 'text', max: 160 },
  yearsExperience: { label: 'Years of experience', table: 'profile', type: 'int', min: 0, max: 70 },
};

const isIsoDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
  && !Number.isNaN(new Date(`${v}T00:00:00Z`).getTime())
  && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

const clip = (v, max) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};

/** A value as it is stored and compared: dates YYYY-MM-DD, numbers as strings, '' → null. */
const normalise = (field, value) => {
  const def = REQUESTABLE[field];
  if (value === null || value === undefined || value === '') return null;
  if (def?.type === 'date') {
    // dateOfBirth is a DATE (datetime) column and arrives as a Date object.
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
    return String(value).slice(0, 10);
  }
  return String(value).trim();
};

/**
 * Checks one change request.
 * @returns {{ ok: boolean, error?: string, value?: string|null }}  value = what will be stored
 */
const validateRequest = (field, rawValue) => {
  const def = REQUESTABLE[field];
  if (!def) return { ok: false, error: 'FIELD_NOT_REQUESTABLE' };
  const value = rawValue === undefined ? null : rawValue;
  if (value === null || value === '') {
    if (def.required) return { ok: false, error: 'VALUE_REQUIRED' };
    return { ok: true, value: null };
  }
  switch (def.type) {
    case 'date':
      if (!isIsoDate(String(value))) return { ok: false, error: 'BAD_DATE' };
      return { ok: true, value: String(value) };
    case 'select':
      if (!def.options.includes(value)) return { ok: false, error: 'BAD_OPTION' };
      return { ok: true, value };
    case 'int': {
      const n = Number(value);
      if (!Number.isInteger(n) || n < def.min || n > def.max) return { ok: false, error: 'BAD_NUMBER' };
      return { ok: true, value: String(n) };
    }
    default: {
      const v = clip(value, def.max);
      if (!v && def.required) return { ok: false, error: 'VALUE_REQUIRED' };
      return { ok: true, value: v };
    }
  }
};

/**
 * Cleans a contact edit. Unknown keys are dropped; undefined leaves a field
 * as it is; '' clears it.
 * @returns {{ ok: boolean, error?: string, user: object, profile: object }}
 */
const cleanContact = (body = {}) => {
  const user = {};
  const profile = {};
  if (body.phone !== undefined) {
    const phone = clip(body.phone, 30);
    if (phone && !/^[+()\d\s-]{5,30}$/.test(phone)) return { ok: false, error: 'BAD_PHONE', user, profile };
    user.phone = phone;
  }
  if (body.address !== undefined) profile.address = clip(body.address, 255);
  if (body.city !== undefined) profile.city = clip(body.city, 100);
  if (body.emergencyContact !== undefined) {
    const ec = body.emergencyContact;
    if (ec !== null && (typeof ec !== 'object' || Array.isArray(ec))) return { ok: false, error: 'BAD_EMERGENCY', user, profile };
    const out = {};
    for (const k of EMERGENCY_KEYS) out[k] = ec ? clip(ec[k], k === 'phone' ? 30 : 100) : null;
    profile.emergencyContact = Object.values(out).some(Boolean) ? out : null;
  }
  return { ok: true, user, profile };
};

/** The value a field holds now, from the user and profile rows. */
const currentValue = (field, user, profile) => {
  const def = REQUESTABLE[field];
  if (!def) return null;
  const raw = def.table === 'user' ? user?.[field] : profile?.[field];
  return normalise(field, raw);
};

/**
 * The to-do list on My profile (mockup 4). Pure: the caller passes what it
 * found. Newest-most-urgent first.
 *
 * @param {object} a
 * @param {{ licenceExpiresInDays:number|null }} a.licence
 * @param {{ id, fileName, category, expiresInDays }[]} a.documents   own, live, expiring ≤ 60 d
 * @param {{ id, status, typeName, startDate, owed:boolean }[]} a.leave   own open requests
 * @param {number} a.pendingChanges
 */
const todoItems = ({ licence = {}, documents = [], leave = [], pendingChanges = 0 } = {}) => {
  const items = [];
  const d = licence.licenceExpiresInDays;
  if (d !== null && d !== undefined && d <= 60) {
    items.push({ kind: 'licence', tone: d < 0 ? 'bad' : 'warn', text: d < 0 ? 'Your practising licence has expired' : `Your practising licence expires in ${d} day${d === 1 ? '' : 's'}`, link: '?tab=credentials' });
  }
  for (const doc of documents) {
    items.push({
      kind: 'document', tone: doc.expiresInDays < 0 ? 'bad' : 'warn',
      text: doc.expiresInDays < 0 ? `${doc.category || doc.fileName} has expired` : `${doc.category || doc.fileName} expires in ${doc.expiresInDays} day${doc.expiresInDays === 1 ? '' : 's'}`,
      link: '?tab=documents',
    });
  }
  for (const l of leave) {
    if (l.status === 'InfoRequested') items.push({ kind: 'leave', tone: 'warn', text: 'An approver asked a question about your leave', link: `/hr/me/leave?open=${l.id}` });
    else if (l.owed) items.push({ kind: 'leave', tone: 'warn', text: 'Add the document your leave request needs', link: `/hr/me/leave?open=${l.id}` });
    else items.push({ kind: 'leave', tone: 'info', text: `${l.typeName} leave from ${l.startDate} is waiting for approval`, link: `/hr/me/leave?open=${l.id}` });
  }
  if (pendingChanges > 0) items.push({ kind: 'change', tone: 'info', text: `${pendingChanges} change${pendingChanges === 1 ? '' : 's'} to your record waiting for HR`, link: '?tab=overview' });
  const rank = { bad: 0, warn: 1, info: 2 };
  return items.sort((a, b) => rank[a.tone] - rank[b.tone]);
};

module.exports = {
  CONTACT_FIELDS,
  EMERGENCY_KEYS,
  REQUESTABLE,
  validateRequest,
  cleanContact,
  currentValue,
  normalise,
  todoItems,
};
