// For PURE tests of middleware that now asks services/hrScope (HR Tier 3
// Phase 1): stands in for the two reads hrScope makes, as on deploy day —
// nobody has a department limit stored and nobody has a department yet. Every
// node --test file runs in its own process, so this never leaks into another
// file. Tests of scoping itself use tests/hrTier3Phase1.test.js.
const db = require('../models');

db.PermissionScope.findAll = async () => [];
db.StaffProfile.findOne = async () => null;
db.StaffProfile.findAll = async () => [];

module.exports = db;
