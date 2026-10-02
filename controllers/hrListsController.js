// HR Suite → Settings → Lists: departments, positions and the one-off tidy
// screen (HR Tier 3 Phase 1). Rules and the one write path live in
// services/staffLists; this file is the HTTP shell plus the settings audit
// trail (area "HR Suite", like every other HR settings write).

const { success, error } = require('../utils/response');
const staffLists = require('../services/staffLists');
const { recordSettingChanges } = require('../services/settingChangeLog');

const KIND_OF = { departments: 'department', positions: 'position' };

const fail = (res, err, what) => {
  if (err instanceof staffLists.ListError) return error(res, err.message, err.status, { code: err.code });
  console.error(`HrLists.${what} error:`, err);
  return error(res, 'Failed to save the list', 500);
};

/** GET /api/hr/lists — both lists with how many files use each entry. */
const list = async (req, res) => {
  try {
    return success(res, await staffLists.lists());
  } catch (err) { return fail(res, err, 'list'); }
};

/** POST /api/hr/lists/:list  { name, cadre? } */
const create = async (req, res) => {
  const kind = KIND_OF[req.params.list];
  try {
    const entry = await staffLists.createEntry(kind, req.body, req.user.id);
    recordSettingChanges({
      user: req.user, area: 'HR Suite',
      before: { entry: null }, after: { entry: entry.name },
      fields: { entry: { key: `hr.lists.${kind}.${entry.id}`, label: `${kind === 'department' ? 'Department' : 'Position'} added` } },
    });
    return success(res, entry);
  } catch (err) { return fail(res, err, 'create'); }
};

/** PATCH /api/hr/lists/:list/:id  { name?, cadre?, status? } */
const update = async (req, res) => {
  const kind = KIND_OF[req.params.list];
  try {
    const { entry, before, after, filesRenamed } = await staffLists.updateEntry(kind, Number(req.params.id), req.body);
    const label = kind === 'department' ? 'Department' : 'Position';
    recordSettingChanges({
      user: req.user, area: 'HR Suite', before, after,
      fields: {
        name: { key: `hr.lists.${kind}.${entry.id}.name`, label: `${label} name` },
        status: { key: `hr.lists.${kind}.${entry.id}.status`, label: `${label} "${entry.name}" status` },
        ...(kind === 'position' ? { cadre: { key: `hr.lists.position.${entry.id}.cadre`, label: `Position "${entry.name}" cadre` } } : {}),
      },
    });
    return success(res, { ...entry, filesRenamed });
  } catch (err) { return fail(res, err, 'update'); }
};

/** GET /api/hr/lists/tidy — today's unlinked free text, grouped. */
const tidy = async (req, res) => {
  try {
    return success(res, await staffLists.tidyGroups());
  } catch (err) { return fail(res, err, 'tidy'); }
};

/** POST /api/hr/lists/tidy  { departments: [{key, departmentId}], positions: [{key, positionId}] } */
const applyTidy = async (req, res) => {
  try {
    const counts = await staffLists.applyTidy(req.body, req.user);
    recordSettingChanges({
      user: req.user, area: 'HR Suite',
      before: { tidy: '—' }, after: { tidy: `${counts.departments} department(s), ${counts.positions} position(s) linked` },
      fields: { tidy: { key: 'hr.lists.tidy', label: 'Staff files linked to the lists' } },
    });
    // `linked` = how many files changed; the rest is the refreshed tidy picture.
    return success(res, { linked: counts, ...(await staffLists.tidyGroups()) });
  } catch (err) { return fail(res, err, 'applyTidy'); }
};

module.exports = { list, create, update, tidy, applyTidy };
