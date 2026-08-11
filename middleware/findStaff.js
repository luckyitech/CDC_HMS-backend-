const { error } = require('../utils/response');
const db = require('../models');

const { User, StaffProfile } = db;

// Resolves :employeeId to the StaffProfile and its User, and attaches both to
// the request. Mirrors findPatient, which does the same for :uhid — controllers
// stay thin and the 404 message is written once rather than in every handler.
//
// Archived staff still resolve. A profile page has to be able to show someone
// who has left, and the alternative is a dead link from every historical
// record that names them. Handlers that must refuse an archived record check
// req.staffProfile.deletedAt themselves.
const findStaff = async (req, res, next) => {
  const { employeeId } = req.params;
  if (!employeeId) return error(res, 'Employee ID is required', 400);

  try {
    const profile = await StaffProfile.findOne({
      where: { employeeId },
      include: [{ model: User }],
    });

    if (!profile || !profile.User) return error(res, 'Staff member not found', 404);

    req.staffProfile = profile;
    req.staffUser    = profile.User;
    next();
  } catch (err) {
    console.error('findStaff error:', err.message);
    return error(res, 'Failed to load staff member', 500);
  }
};

module.exports = findStaff;
