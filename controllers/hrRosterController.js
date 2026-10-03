// Shift roster (HR Tier 3 Phase 4; mockup D; T3-5/6/7 a, RO-1…RO-12). HTTP
// shell over services/roster.
//
//   HR Suite → Roster (hr.roster, department-scoped)
//     GET   /api/hr/roster/departments                       the grids the viewer may open
//     GET   /api/hr/roster/week?department=&weekStart=       one department's week
//     PUT   /api/hr/roster/week/cell                         set / change / clear a cell
//     POST  /api/hr/roster/week/copy                         copy last week into empty cells
//     PATCH /api/hr/roster/week                              { minCover }
//     POST  /api/hr/roster/week/publish                      draft → published (one way)
//   Shift types (hr.roster.shifts; hr.roster may read)
//     GET   /api/hr/roster/shift-types?all=1
//     POST  /api/hr/roster/shift-types
//     PATCH /api/hr/roster/shift-types/:id
//   My profile (hr.self)
//     GET   /api/hr/me/roster                                my published shifts, next 14 days
//
// `department` is a department id, or 'none' for staff with no department.
// Shift-type edits go to the settings trail (area "HR Suite").

const { success, error } = require('../utils/response');
const { recordSettingChanges } = require('../services/settingChangeLog');
const roster = require('../services/roster');

const fail = (res, err, what, message) => {
  if (err instanceof roster.RosterError) return error(res, err.message, err.status, { code: err.code });
  console.error(`Roster.${what} error:`, err);
  return error(res, message, 500);
};

const args = (src) => ({ department: src.department, weekStart: src.weekStart });

const departments = async (req, res) => {
  try { return success(res, { departments: await roster.departmentsFor(req.user) }); }
  catch (err) { return fail(res, err, 'departments', 'Failed to load departments'); }
};

const week = async (req, res) => {
  try { return success(res, await roster.weekView(req.user, args(req.query))); }
  catch (err) { return fail(res, err, 'week', 'Failed to load the roster'); }
};

const setCell = async (req, res) => {
  try {
    const { userId, date, shiftTypeId, off, clear } = req.body;
    return success(res, await roster.setCell(req.user, { ...args(req.body), userId, date, shiftTypeId, off: off === true, clear: clear === true }));
  } catch (err) { return fail(res, err, 'setCell', 'Failed to save the shift'); }
};

const copy = async (req, res) => {
  try { return success(res, await roster.copyLastWeek(req.user, args(req.body))); }
  catch (err) { return fail(res, err, 'copy', 'Failed to copy last week'); }
};

const updateWeek = async (req, res) => {
  try { return success(res, await roster.setMinCover(req.user, { ...args(req.body), minCover: req.body.minCover })); }
  catch (err) { return fail(res, err, 'updateWeek', 'Failed to save the week'); }
};

const publish = async (req, res) => {
  try { return success(res, await roster.publish(req.user, args(req.body))); }
  catch (err) { return fail(res, err, 'publish', 'Failed to publish the week'); }
};

const shiftTypes = async (req, res) => {
  try { return success(res, { types: await roster.listTypes({ all: req.query.all === '1' }) }); }
  catch (err) { return fail(res, err, 'shiftTypes', 'Failed to load shift types'); }
};

const logType = (req, id, before, after) => recordSettingChanges({
  user: req.user, area: 'HR Suite', before, after,
  fields: {
    name: { key: `hr.roster.shift.${id}.name`, label: 'Shift type name' },
    startTime: { key: `hr.roster.shift.${id}.start`, label: `Shift "${after.name || before.name}" start` },
    endTime: { key: `hr.roster.shift.${id}.end`, label: `Shift "${after.name || before.name}" end` },
    colour: { key: `hr.roster.shift.${id}.colour`, label: `Shift "${after.name || before.name}" colour` },
    status: { key: `hr.roster.shift.${id}.status`, label: `Shift "${after.name || before.name}" status` },
  },
});

const createShiftType = async (req, res) => {
  try {
    const type = await roster.createType(req.user, req.body);
    logType(req, type.id, {}, type);
    return success(res, type, 201);
  } catch (err) { return fail(res, err, 'createShiftType', 'Failed to add the shift type'); }
};

const updateShiftType = async (req, res) => {
  try {
    const { before, after } = await roster.updateType(req.user, Number(req.params.id), req.body);
    logType(req, after.id, before, after);
    return success(res, after);
  } catch (err) { return fail(res, err, 'updateShiftType', 'Failed to save the shift type'); }
};

const mine = async (req, res) => {
  try { return success(res, await roster.myShifts(req.user.id)); }
  catch (err) { return fail(res, err, 'mine', 'Failed to load your shifts'); }
};

module.exports = { departments, week, setCell, copy, updateWeek, publish, shiftTypes, createShiftType, updateShiftType, mine };
