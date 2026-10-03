// Onboarding checklists — the PURE rules (HR Tier 3 Phase 3; mockup C of
// hr-tier3-mockup; decisions T3-4 = a template per role, O-1…O-8, 3 Oct 2026).
// No database here: services/onboarding loads the facts and the rows.
//
// A checklist is a COPY of the role's template taken when it starts (a
// template, never a link — like permission presets), so editing a template
// never changes anyone's list in progress.
//
// Two kinds of item:
//   automatic — `autoKey` names a fact on the person's file (AUTO_ITEMS). It is
//               done while the fact holds, and only then: archive the contract
//               and the item unticks. Nobody ticks it by hand.
//   manual    — no autoKey; an HR holder ticks it (who and when are kept).
// A checklist is complete when every active item is done (O-5).

const ROLES = ['doctor', 'nurse', 'lab', 'staff', 'admin'];
const CLINICAL = ['doctor', 'nurse', 'lab'];

// The facts an automatic item can watch. `label` is what a new template item
// is called by default; HR may rename the item.
const AUTO_ITEMS = {
  contract:     { label: 'Employment contract on file',          hint: 'An Employment Contract document on the staff file' },
  national_id:  { label: 'National ID copy on file',              hint: 'A National ID document on the staff file' },
  licence:      { label: 'Practising licence with expiry date',   hint: 'Licence number and expiry date on the file, or a Practising Licence document' },
  photo:        { label: 'Photo on file',                         hint: 'A staff photo' },
  phone:        { label: 'Phone registered for check-in',         hint: 'A phone remembered for the entrance tag' },
  permissions:  { label: 'Permissions set',                       hint: 'At least one permission ticked on the Permissions tab' },
  department:   { label: 'Department and position set',           hint: 'Both picked from the lists on the staff file' },
  first_login:  { label: 'Has logged in to the HMS',              hint: 'At least one successful login' },
};
const AUTO_KEYS = Object.keys(AUTO_ITEMS);

const item = (label, autoKey, dueDays) => ({ label, autoKey, dueDays });

/** The starter template for a role (migration …012 seeds these; HR edits them). */
const starterTemplate = (role) => {
  const list = [
    item(AUTO_ITEMS.contract.label, 'contract', 7),
    item(AUTO_ITEMS.national_id.label, 'national_id', 7),
    ...(CLINICAL.includes(role) ? [item(AUTO_ITEMS.licence.label, 'licence', 7)] : []),
    item(AUTO_ITEMS.department.label, 'department', 1),
    item(AUTO_ITEMS.permissions.label, 'permissions', 1),
    item(AUTO_ITEMS.first_login.label, 'first_login', 3),
    item(AUTO_ITEMS.photo.label, 'photo', 14),
    item(AUTO_ITEMS.phone.label, 'phone', 7),
    item('Clinic orientation done', null, 7),
    item('Fire and safety briefing', null, 14),
    item('Confidentiality agreement signed', null, 7),
    item('Uniform and ID badge issued', null, 14),
  ];
  return list.map((x, i) => ({ ...x, sortOrder: (i + 1) * 10 }));
};

/** YYYY-MM-DD + n days. */
const addDays = (iso, n) => {
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Number(n || 0));
  return d.toISOString().slice(0, 10);
};

/** When a copied item is due: the start date (or today) + its days; none without days. */
const dueDateFor = (dueDays, startDate, today) =>
  (dueDays === null || dueDays === undefined || dueDays === '' ? null : addDays(startDate || today, dueDays));

/** A clean template-item write (label required; autoKey from the list; days 0–365). */
const cleanTemplateItem = (body = {}, { partial = false } = {}) => {
  const out = {};
  if (!partial || body.label !== undefined) {
    const label = typeof body.label === 'string' ? body.label.trim() : '';
    if (label.length < 2) return { error: 'LABEL_REQUIRED' };
    out.label = label.slice(0, 160);
  }
  if (!partial || body.autoKey !== undefined) {
    const k = body.autoKey === '' || body.autoKey === null || body.autoKey === undefined ? null : String(body.autoKey);
    if (k !== null && !AUTO_KEYS.includes(k)) return { error: 'BAD_AUTO_KEY' };
    out.autoKey = k;
  }
  if (!partial || body.dueDays !== undefined) {
    if (body.dueDays === '' || body.dueDays === null || body.dueDays === undefined) out.dueDays = null;
    else {
      const n = Number(body.dueDays);
      if (!Number.isInteger(n) || n < 0 || n > 365) return { error: 'BAD_DUE_DAYS' };
      out.dueDays = n;
    }
  }
  if (body.role !== undefined || !partial) {
    if (body.role !== undefined && !ROLES.includes(body.role)) return { error: 'BAD_ROLE' };
    if (body.role !== undefined) out.role = body.role;
  }
  if (body.status !== undefined) {
    if (!['active', 'archived'].includes(body.status)) return { error: 'BAD_STATUS' };
    out.status = body.status;
  }
  if (body.sortOrder !== undefined) {
    const n = Number(body.sortOrder);
    if (!Number.isInteger(n)) return { error: 'BAD_ORDER' };
    out.sortOrder = n;
  }
  return { value: out };
};

/**
 * One item's state for display.
 * @param it     { autoKey, doneAt, dueDate, status }
 * @param facts  { contract: bool, ... } for the person
 */
const itemState = (it, facts, today) => {
  const auto = !!it.autoKey;
  const done = auto ? !!facts[it.autoKey] : !!it.doneAt;
  const overdue = !done && !!it.dueDate && it.dueDate < today;
  return { auto, done, overdue };
};

/**
 * The checklist's progress from its active items.
 * @returns {{ total, done, overdue, complete, percent }}
 */
const progress = (items, facts, today) => {
  const active = items.filter((i) => i.status !== 'removed');
  let done = 0;
  let overdue = 0;
  for (const it of active) {
    const s = itemState(it, facts, today);
    if (s.done) done += 1;
    if (s.overdue) overdue += 1;
  }
  const total = active.length;
  return { total, done, overdue, complete: total > 0 && done === total, percent: total ? Math.round((done / total) * 100) : 0 };
};

module.exports = {
  ROLES, CLINICAL, AUTO_ITEMS, AUTO_KEYS, starterTemplate, addDays, dueDateFor, cleanTemplateItem, itemState, progress,
};
