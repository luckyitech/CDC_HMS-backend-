// Appraisals (HR Tier 3 Phase 5; mockup E; T3-9 a, T3-10 a). HTTP shell over
// services/appraisals.
//
//   Everyone (PARTICIPATE; what they may do is decided per appraisal)
//     GET   /api/hr/appraisals/mine                 my appraisals + the ones I review
//     GET   /api/hr/appraisals/competencies         the competencies (names are not secret)
//     GET   /api/hr/appraisals/:id                  one appraisal, redacted for my role (else 404)
//     GET   /api/hr/appraisals/:id/reference        attendance + CPD beside the form
//     PUT   /api/hr/appraisals/:id/self             the person: save / { submit: true }
//     PUT   /api/hr/appraisals/:id/review           the reviewer: save / { send: true }
//     POST  /api/hr/appraisals/:id/acknowledge      the person: { personComment }
//   Cycles — runners (hr.appraisals.run) and readers (hr.appraisals) see progress, never content
//     GET   /api/hr/appraisals/cycles               (runner or reader)
//     GET   /api/hr/appraisals/cycles/:id           progress (runner: in scope; reader: everyone)
//     POST  /api/hr/appraisals/cycles               (All-staff runner)
//     PATCH /api/hr/appraisals/cycles/:id           dates, name, open/closed (All-staff runner)
//     GET   /api/hr/appraisals/cycles/:id/eligible  who could be added (runner)
//     POST  /api/hr/appraisals/cycles/:id/people    { userIds | all: true } (runner)
//     PATCH /api/hr/appraisals/:id/run              { action: reviewer|skipSelf|return|cancel } (runner)
//     POST/PATCH /api/hr/appraisals/competencies…   (All-staff runner)
//
// Cycle and competency edits go to the settings trail (area "HR Suite").

const { success, error } = require('../utils/response');
const { recordSettingChanges } = require('../services/settingChangeLog');
const svc = require('../services/appraisals');

const fail = (res, err, what, message) => {
  if (err instanceof svc.AppraisalError) return error(res, err.message, err.status, { code: err.code });
  console.error(`Appraisal.${what} error:`, err);
  return error(res, message, 500);
};
const id = (req) => Number(req.params.id);

const wrap = (what, message, fn) => async (req, res) => {
  try { return await fn(req, res); } catch (err) { return fail(res, err, what, message); }
};

const mine = wrap('mine', 'Failed to load your appraisals', async (req, res) => success(res, await svc.mine(req.user)));
const competencies = wrap('competencies', 'Failed to load the competencies', async (req, res) => success(res, { competencies: await svc.listCompetencies() }));

const logCompetency = (req, before, after) => recordSettingChanges({
  user: req.user, area: 'HR Suite', before, after,
  fields: {
    name: { key: `hr.appraisals.competency.${after.id}.name`, label: 'Appraisal competency' },
    description: { key: `hr.appraisals.competency.${after.id}.description`, label: `Appraisal competency "${after.name}" description` },
    status: { key: `hr.appraisals.competency.${after.id}.status`, label: `Appraisal competency "${after.name}" status` },
  },
});
const createCompetency = wrap('createCompetency', 'Failed to add the competency', async (req, res) => {
  const c = await svc.createCompetency(req.user, req.body);
  logCompetency(req, {}, c);
  return success(res, c, 201);
});
const updateCompetency = wrap('updateCompetency', 'Failed to save the competency', async (req, res) => {
  const { before, after } = await svc.updateCompetency(req.user, id(req), req.body);
  logCompetency(req, before, after);
  return success(res, after);
});

const logCycle = (req, before, after) => recordSettingChanges({
  user: req.user, area: 'HR Suite', before, after,
  fields: {
    name: { key: `hr.appraisals.cycle.${after.year}.name`, label: `${after.year} appraisal name` },
    selfDueOn: { key: `hr.appraisals.cycle.${after.year}.selfDue`, label: `${after.year} appraisal self-assessment due` },
    reviewDueOn: { key: `hr.appraisals.cycle.${after.year}.reviewDue`, label: `${after.year} appraisal review due` },
    status: { key: `hr.appraisals.cycle.${after.year}.status`, label: `${after.year} appraisal window` },
  },
});
const cycles = wrap('cycles', 'Failed to load appraisal cycles', async (req, res) => {
  svc.assertCycleViewer(req.user);
  return success(res, { cycles: await svc.listCycles() });
});
const createCycle = wrap('createCycle', 'Failed to open the appraisal', async (req, res) => {
  const c = await svc.createCycle(req.user, req.body);
  logCycle(req, {}, c);
  return success(res, c, 201);
});
const updateCycle = wrap('updateCycle', 'Failed to save the appraisal cycle', async (req, res) => {
  const { before, after } = await svc.updateCycle(req.user, id(req), req.body);
  logCycle(req, before, after);
  return success(res, after);
});
const cycleProgress = wrap('cycleProgress', 'Failed to load the appraisal cycle', async (req, res) => {
  svc.assertCycleViewer(req.user);
  return success(res, await svc.cycleProgress(req.user, id(req)));
});
const eligible = wrap('eligible', 'Failed to load staff', async (req, res) => success(res, { people: await svc.listEligible(req.user, id(req)) }));
const addPeople = wrap('addPeople', 'Failed to add people', async (req, res) => success(res, await svc.addPeople(req.user, id(req), {
  userIds: req.body.all === true ? null : (Array.isArray(req.body.userIds) ? req.body.userIds : []),
})));
const run = wrap('run', 'Failed to update the appraisal', async (req, res) => success(res, await svc.runnerAction(req.user, id(req), req.body)));

const getOne = wrap('getOne', 'Failed to load the appraisal', async (req, res) => success(res, await svc.getOne(req.user, id(req))));
const reference = wrap('reference', 'Failed to load attendance and CPD', async (req, res) => success(res, await svc.reference(req.user, id(req))));
const saveSelf = wrap('saveSelf', 'Failed to save your self-assessment', async (req, res) => success(res, await svc.saveSelf(req.user, id(req), req.body)));
const saveReview = wrap('saveReview', 'Failed to save the review', async (req, res) => success(res, await svc.saveReview(req.user, id(req), req.body)));
const acknowledge = wrap('acknowledge', 'Failed to acknowledge', async (req, res) => success(res, await svc.acknowledge(req.user, id(req), req.body)));

module.exports = {
  mine, competencies, createCompetency, updateCompetency,
  cycles, createCycle, updateCycle, cycleProgress, eligible, addPeople, run,
  getOne, reference, saveSelf, saveReview, acknowledge,
};
