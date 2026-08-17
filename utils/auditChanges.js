// Builds a { field: { from, to } } diff for UserEditLog, keeping only fields
// that actually changed.
//
// Values are compared as strings because Sequelize hands back Dates, JSON
// objects and numbers where the request body carried strings — a raw !==
// would report every submitted field as changed and fill the audit log with
// noise that hides the real edits.
const buildChanges = (before, after) => {
  const changes = {};
  const serialize = (v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v ?? ''));

  Object.keys(after).forEach((field) => {
    if (serialize(before[field]) !== serialize(after[field])) {
      changes[field] = { from: before[field] ?? null, to: after[field] };
    }
  });

  return changes;
};

module.exports = { buildChanges };
