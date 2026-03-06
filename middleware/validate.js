const { validationResult } = require('express-validator');
const { error } = require('../utils/response');

// Sits at the end of a validation chain in a route.
// If any rule failed, it returns all error messages as a 400.
// If everything passed, it calls next() and the controller runs.
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return error(res, errors.array().map(e => e.msg).join(', '), 400);
  }
  next();
};

module.exports = validate;
