const { success } = require('../utils/response');
const db = require('../models');

const { PatientAccessLog } = db;

// GET /api/patients/:uhid/access-log
//
// Who has opened this patient's clinical record.
//
// Read PER PATIENT, never per member of staff. The distinction matters: "who
// has looked at Moses' file" is an accountability question a patient is
// entitled to ask, while "what has Bridgit been looking at today" is
// surveillance of a colleague, and the two need different justification. The
// table is indexed for the first and deliberately not for the second.
//
// The log is itself sensitive — it reveals who is being treated, by whom and
// for what section of the record — so it is restricted to a real administrator
// account rather than to anyone holding clinical.view.
const list = async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);

  // Matched on both keys: the collection routes log by uhid alone (they filter
  // by query parameter and never resolve a patient row), while the per-patient
  // routes log the id. Querying one would silently return half the history.
  const where = {
    [db.Sequelize.Op.or]: [
      { patientId: req.patient.id },
      { uhid: req.patient.uhid },
    ],
  };

  const rows = await PatientAccessLog.findAll({
    where,
    order: [['accessedAt', 'DESC']],
    limit,
  });

  return success(res, rows.map((r) => ({
    id:         r.id,
    who:        r.userName || `user #${r.userId}`,
    role:       r.userRole,
    section:    r.section,
    accessedAt: r.accessedAt,
    ipAddress:  r.ipAddress,
  })));
};

module.exports = { list };
