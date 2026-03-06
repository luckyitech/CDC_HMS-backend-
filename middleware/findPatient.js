const { error } = require('../utils/response');
const db = require('../models');

const { Patient } = db;

const findPatient = async (req, res, next) => {
  const patient = await Patient.findOne({ where: { uhid: req.params.uhid } });
  if (!patient) return error(res, 'Patient not found', 404);
  req.patient = patient;
  next();
};

module.exports = findPatient;
