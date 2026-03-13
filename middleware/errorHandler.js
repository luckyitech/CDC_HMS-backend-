const { Sequelize } = require('sequelize');

const errorHandler = (err, req, res, next) => {
  // Sequelize FK constraint (e.g. delete patient who has related records)
  if (err instanceof Sequelize.ForeignKeyConstraintError) {
    return res.status(400).json({
      success: false,
      message: 'Cannot delete — remove related records first',
    });
  }

  // Sequelize validation (field-level constraints)
  if (err instanceof Sequelize.ValidationError) {
    return res.status(400).json({
      success: false,
      message: err.errors.map(e => e.message).join('; '),
    });
  }

  const statusCode = err.statusCode || 500;

  // Only log stack traces for unexpected 5xx errors
  if (statusCode >= 500) {
    console.error(err.stack);
    // Log the underlying DB error if present (Sequelize wraps MySQL errors in err.parent)
    if (err.parent) console.error('DB error:', err.parent.message, '| SQL:', err.sql || err.parent.sql);
  }

  res.status(statusCode).json({
    success: false,
    message: statusCode < 500 ? err.message : 'Server error',
  });
};

module.exports = errorHandler;
