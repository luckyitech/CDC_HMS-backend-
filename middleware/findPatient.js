const { error } = require('../utils/response');
const { resolvePatient } = require('../utils/patientFamily');

const findPatient = async (req, res, next) => {
  const family = await resolvePatient(req.params.uhid);
  if (!family) return error(res, 'Patient not found', 404);

  req.patient       = family.patient;
  req.patientIds    = family.patientIds;
  req.isDeactivated = family.isDeactivated;
  next();
};

module.exports = findPatient;
