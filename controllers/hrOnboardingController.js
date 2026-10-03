// Onboarding checklists (HR Tier 3 Phase 3; mockup C, decisions T3-4 = a,
// O-1…O-8). HTTP shell over services/onboarding.
//
//   HR Suite → Onboarding
//     GET   /api/hr/onboarding?status=open|all       checklists in scope (hr.onboarding)
//     GET   /api/hr/onboarding/count                  open in scope (dashboard)
//     GET   /api/hr/onboarding/templates              every role's lines (hr.onboarding | templates)
//     POST  /api/hr/onboarding/templates              add a line   (hr.onboarding.templates)
//     PATCH /api/hr/onboarding/templates/:id          edit / archive / reorder
//   Staff file (findStaff + inStaffScope('hr.onboarding'))
//     GET   /api/staff/:employeeId/onboarding         the person's checklist (or null)
//     POST  /api/staff/:employeeId/onboarding         start one from the role's template
//     PATCH /api/staff/:employeeId/onboarding         { action: close|reopen, note }
//     POST  /api/staff/:employeeId/onboarding/items   a one-off item
//     PATCH /api/staff/:employeeId/onboarding/items/:itemId  { done, note, remove }
//
// Template edits go to the settings trail (area "HR Suite"). Ticks keep who and
// when on the item itself.

const { success, error } = require('../utils/response');
const { recordSettingChanges } = require('../services/settingChangeLog');
const onboarding = require('../services/onboarding');
const { AUTO_ITEMS, ROLES, cleanTemplateItem } = require('../utils/onboarding');
const db = require('../models');

const { OnboardingTemplateItem } = db;

const TEMPLATE_MESSAGES = {
  LABEL_REQUIRED: 'Give the item a name',
  BAD_AUTO_KEY: 'Unknown automatic check',
  BAD_DUE_DAYS: 'Due in must be 0–365 days, or blank',
  BAD_ROLE: 'Choose a role',
  BAD_STATUS: 'Status must be active or archived',
  BAD_ORDER: 'Order must be a whole number',
};
const ROLE_LABEL = { doctor: 'Doctor', nurse: 'Nurse', lab: 'Lab', staff: 'Front office', admin: 'Admin' };

const fail = (res, err, what, message) => {
  if (err instanceof onboarding.OnboardingError) return error(res, err.message, err.status, { code: err.code });
  console.error(`Onboarding.${what} error:`, err);
  return error(res, message, 500);
};

const shapeLine = (l) => ({ id: l.id, role: l.role, label: l.label, autoKey: l.autoKey, dueDays: l.dueDays, sortOrder: l.sortOrder, status: l.status });

// ---------------------------------------------------------------------------
// HR Suite → Onboarding
// ---------------------------------------------------------------------------

const list = async (req, res) => {
  try {
    return success(res, await onboarding.listFor(req.user, { status: req.query.status === 'all' ? 'all' : 'open' }));
  } catch (err) { return fail(res, err, 'list', 'Failed to load onboarding checklists'); }
};

const count = async (req, res) => {
  try {
    return success(res, { open: await onboarding.openCount(req.user) });
  } catch (err) { return fail(res, err, 'count', 'Failed to count onboarding checklists'); }
};

const templates = async (req, res) => {
  try {
    const rows = await OnboardingTemplateItem.findAll({ order: [['role', 'ASC'], ['sortOrder', 'ASC'], ['id', 'ASC']] });
    return success(res, {
      roles: ROLES.map((r) => ({ key: r, label: ROLE_LABEL[r] })),
      autoItems: Object.entries(AUTO_ITEMS).map(([key, v]) => ({ key, label: v.label, hint: v.hint })),
      items: rows.map(shapeLine),
    });
  } catch (err) { return fail(res, err, 'templates', 'Failed to load templates'); }
};

const logLine = (req, line, before, after) => recordSettingChanges({
  user: req.user, area: 'HR Suite', before, after,
  fields: {
    label: { key: `hr.onboarding.template.${line.id}.label`, label: `Onboarding template (${ROLE_LABEL[line.role]}) item` },
    autoKey: { key: `hr.onboarding.template.${line.id}.auto`, label: `Onboarding template (${ROLE_LABEL[line.role]}) "${line.label}" automatic check` },
    dueDays: { key: `hr.onboarding.template.${line.id}.due`, label: `Onboarding template (${ROLE_LABEL[line.role]}) "${line.label}" due in days` },
    status: { key: `hr.onboarding.template.${line.id}.status`, label: `Onboarding template (${ROLE_LABEL[line.role]}) "${line.label}" status` },
  },
});

const createTemplateItem = async (req, res) => {
  const v = cleanTemplateItem(req.body || {});
  if (v.error) return error(res, TEMPLATE_MESSAGES[v.error], 400, { code: v.error });
  if (!v.value.role) return error(res, TEMPLATE_MESSAGES.BAD_ROLE, 400, { code: 'BAD_ROLE' });
  try {
    const last = await OnboardingTemplateItem.max('sortOrder', { where: { role: v.value.role } });
    const line = await OnboardingTemplateItem.create({
      ...v.value, sortOrder: v.value.sortOrder ?? ((Number(last) || 0) + 10), status: 'active', createdById: req.user.id,
    });
    logLine(req, line, { label: null }, { label: line.label });
    return success(res, shapeLine(line), 201);
  } catch (err) { return fail(res, err, 'createTemplateItem', 'Failed to add the item'); }
};

const updateTemplateItem = async (req, res) => {
  const v = cleanTemplateItem(req.body || {}, { partial: true });
  if (v.error) return error(res, TEMPLATE_MESSAGES[v.error], 400, { code: v.error });
  delete v.value.role;   // a line never moves to another role
  try {
    const line = await OnboardingTemplateItem.findByPk(Number(req.params.id));
    if (!line) return error(res, 'Template item not found', 404);
    if (!Object.keys(v.value).length) return error(res, 'Nothing to change', 400, { code: 'NO_CHANGE' });
    const before = { ...line.get({ plain: true }) };
    await line.update(v.value);
    logLine(req, line, before, line.get({ plain: true }));
    return success(res, shapeLine(line));
  } catch (err) { return fail(res, err, 'updateTemplateItem', 'Failed to save the item'); }
};

// ---------------------------------------------------------------------------
// Staff file
// ---------------------------------------------------------------------------

const staffGet = async (req, res) => {
  try {
    const [checklist, lines] = await Promise.all([
      onboarding.currentFor(req.staffUser.id),
      onboarding.templateFor(req.staffUser.role),
    ]);
    return success(res, { checklist, templateItems: lines.length });
  } catch (err) { return fail(res, err, 'staffGet', 'Failed to load the checklist'); }
};

const staffStart = async (req, res) => {
  try {
    await onboarding.startFor({
      userId: req.staffUser.id, role: req.staffUser.role, startDate: req.staffProfile?.startDate, actorId: req.user.id,
    });
    return success(res, await onboarding.currentFor(req.staffUser.id), 201);
  } catch (err) { return fail(res, err, 'staffStart', 'Failed to start the checklist'); }
};

const staffStatus = async (req, res) => {
  try {
    return success(res, await onboarding.setStatus({
      userId: req.staffUser.id, action: req.body?.action, note: req.body?.note, actorId: req.user.id,
    }));
  } catch (err) { return fail(res, err, 'staffStatus', 'Failed to update the checklist'); }
};

const staffAddItem = async (req, res) => {
  try {
    return success(res, await onboarding.addItem({ userId: req.staffUser.id, body: req.body || {}, actorId: req.user.id }), 201);
  } catch (err) { return fail(res, err, 'staffAddItem', 'Failed to add the item'); }
};

const staffItem = async (req, res) => {
  try {
    return success(res, await onboarding.updateItem({
      userId: req.staffUser.id, itemId: req.params.itemId, body: req.body || {}, actorId: req.user.id,
    }));
  } catch (err) { return fail(res, err, 'staffItem', 'Failed to update the item'); }
};

module.exports = {
  list, count, templates, createTemplateItem, updateTemplateItem,
  staffGet, staffStart, staffStatus, staffAddItem, staffItem,
};
