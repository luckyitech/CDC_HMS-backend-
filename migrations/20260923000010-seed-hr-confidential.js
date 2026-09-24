'use strict';

// hr.confidential — seed the first holder.
//
// Confidential staff documents (contracts, appraisals, disciplinary letters,
// the archived files) need an explicit grant that admin.access deliberately
// does NOT carry — see constants/permissions.js HR_CONFIDENTIAL. That creates
// the same bootstrap problem as permissions.grant (…000009): on day one nobody
// holds it, so the whole confidential drawer would be unreadable to everyone
// except the true 'admin' account. This gives it to one named account, who
// grants it onward as the clinic decides.
//
// Data-only. Touches exactly one row's `permissions` JSON list, adds one entry,
// no-ops if the user is absent or already holds it. `down` removes that one
// entry from that one user. Same shape as …000009, incl. the MariaDB-safe read.

const SEED_EMAIL = 'ebrahim@cdiabetescentre.com';
const CAP = 'hr.confidential';

const resolveTable = async (qi, name) => {
  const tables = await qi.showAllTables();
  return tables.find((t) => String(t).toLowerCase() === name.toLowerCase());
};

// MySQL 8 returns a JSON column as a parsed value; MariaDB (and some drivers)
// return the raw string. Read it defensively — the same rule as utils/jsonColumn.
const toList = (value) => {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try { const v = JSON.parse(value); return Array.isArray(v) ? v : []; } catch { return []; }
  }
  return [];
};

const loadUser = async (qi, usersTable) => {
  const [rows] = await qi.sequelize.query(
    `SELECT id, permissions FROM ${usersTable} WHERE email = :email LIMIT 1`,
    { replacements: { email: SEED_EMAIL } }
  );
  return rows[0] || null;
};

const writePermissions = async (qi, usersTable, id, list) => {
  await qi.sequelize.query(
    `UPDATE ${usersTable} SET permissions = :perms WHERE id = :id`,
    { replacements: { perms: JSON.stringify(list), id } }
  );
};

module.exports = {
  async up(queryInterface) {
    const usersTable = await resolveTable(queryInterface, 'Users');
    if (!usersTable) return;
    const user = await loadUser(queryInterface, usersTable);
    if (!user) return;                       // account not on this DB (e.g. a fresh local) — nothing to seed
    const current = toList(user.permissions);
    if (current.includes(CAP)) return;       // already a holder — idempotent
    await writePermissions(queryInterface, usersTable, user.id, [...current, CAP]);
  },

  async down(queryInterface) {
    const usersTable = await resolveTable(queryInterface, 'Users');
    if (!usersTable) return;
    const user = await loadUser(queryInterface, usersTable);
    if (!user) return;
    const current = toList(user.permissions);
    if (!current.includes(CAP)) return;
    await writePermissions(queryInterface, usersTable, user.id, current.filter((p) => p !== CAP));
  },
};
