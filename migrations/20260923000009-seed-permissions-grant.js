'use strict';

// permissions.grant — seed the first key-holder.
//
// The capability is deliberately NOT covered by admin.access and cannot be
// self-granted, which creates a bootstrap problem: on day one nobody holds it
// and nobody can hand it out. This migration gives it to one named account,
// after which that person grants it to whoever else should hold it. The true
// 'admin' account stays a fallback holder regardless (see
// constants/permissions.js canGrantPermissions), so this cannot lock anyone out.
//
// Data-only. Touches exactly one row's `permissions` JSON list, adds one entry,
// no-ops if the user is absent or already holds it. `down` removes that one
// entry from that one user. Decision of record:
// claude/session-2026-09-24-permissions-grant-decision.md

const SEED_EMAIL = 'ebrahim@cdiabetescentre.com';
const CAP = 'permissions.grant';

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
