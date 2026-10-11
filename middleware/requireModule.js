const { error } = require('../utils/response');
const { isModuleOn } = require('../services/clinicModules');

// Refuses every request to a specialist module the clinic has not switched on
// (services/clinicModules). 404, not 403: while a module is off it does not
// exist for this clinic — the same answer whether or not the caller could
// otherwise use it, so nothing about it leaks.
//
//   router.use(requireModule('dermatology'));
const requireModule = (key) => async (req, res, next) => {
  try {
    if (await isModuleOn(key)) return next();
    return error(res, 'Not found', 404, { code: 'MODULE_OFF' });
  } catch (err) {
    console.error('requireModule error:', err);
    return error(res, 'Server error', 500);
  }
};

module.exports = requireModule;
