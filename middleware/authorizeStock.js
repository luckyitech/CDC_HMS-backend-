const { error } = require('../utils/response');
const db = require('../models');
const { User } = db;

// Stock module permission gate. Admins always pass; staff/doctors pass only
// when the admin has granted them canManageStock.
//
// The flag is read from the DATABASE, not the JWT: authenticate's payload was
// signed at login, so a freshly granted user would otherwise have to log out
// and back in before the toggle took effect. One indexed findByPk per request
// is the accepted cost (the plan names this trade-off).
const authorizeStock = async (req, res, next) => {
  try {
    if (req.user.role === 'admin') return next();

    const user = await User.findByPk(req.user.id, { attributes: ['canManageStock'] });
    if (user?.canManageStock) return next();

    return error(res, 'Access denied — stock access has not been granted to your account', 403);
  } catch (err) {
    console.error('authorizeStock error:', err);
    return error(res, 'Authorization service unavailable. Please try again.', 503);
  }
};

module.exports = authorizeStock;
