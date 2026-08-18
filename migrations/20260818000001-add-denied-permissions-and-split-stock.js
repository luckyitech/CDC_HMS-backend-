'use strict';

// Per-staff portal permissions — the two schema changes the Permissions tab needs.
//
// 1. Users.deniedPermissions — capabilities explicitly WITHDRAWN from a user.
//    `permissions` already stores what a role has been given on top of; this
//    stores what it has been held back from, so an admin can keep one person
//    out of a section their role would otherwise open. Nullable-by-default JSON
//    array, so every existing row reads as "nothing withdrawn" — which is what
//    was true before this column existed.
//
// 2. 'stock.manage' -> 'stock.access' + 'stock.write'. The old capability was
//    all-or-nothing and could not express "may look at stock levels but may not
//    move the ledger". Every current holder keeps exactly what they had: both
//    halves. Nobody gains or loses access in this migration.
//
// Both steps are guarded and re-runnable. down() reverses the split and drops
// the column.
//
// NOTE: down() destroys any withdrawals recorded in deniedPermissions. Take a
// dump before running migrate:undo after go-live.

const TABLE = 'Users';
const COLUMN = 'deniedPermissions';

const LEGACY = 'stock.manage';
const SPLIT = ['stock.access', 'stock.write'];

// Rewrites the permissions JSON array on every row, in place. Done in JS rather
// than as a JSON_* SQL expression because the column is portable JSON and the
// row count here is staff, not patients — tens, not millions.
const remap = async (queryInterface, fn) => {
  const [rows] = await queryInterface.sequelize.query(
    `SELECT id, permissions FROM ${TABLE}`
  );

  for (const row of rows) {
    let current = row.permissions;
    // MySQL returns JSON as a string through some drivers and as a parsed value
    // through others; tolerate both rather than assuming.
    if (typeof current === 'string') {
      try { current = JSON.parse(current); } catch { current = []; }
    }
    if (!Array.isArray(current)) current = [];

    const next = fn(current);
    if (next === null) continue;   // unchanged — skip the write

    await queryInterface.sequelize.query(
      `UPDATE ${TABLE} SET permissions = :perms WHERE id = :id`,
      { replacements: { perms: JSON.stringify(next), id: row.id } }
    );
  }
};

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable(TABLE);
    if (!table[COLUMN]) {
      // Added NULLABLE first, then backfilled, then constrained.
      //
      // Adding it as NOT NULL in one step fails on a table that already has
      // rows: there is no value for them to take, and a JSON column cannot
      // carry a literal DEFAULT that would supply one. On MariaDB — where JSON
      // is longtext plus a json_valid() CHECK — the constraint rejects the
      // empty string it would otherwise write, so the whole migration aborts
      // partway. Three steps cannot half-apply in a way that loses anything.
      await queryInterface.addColumn(TABLE, COLUMN, {
        type: Sequelize.JSON,
        allowNull: true,
      });

      await queryInterface.sequelize.query(
        `UPDATE ${TABLE} SET ${COLUMN} = '[]' WHERE ${COLUMN} IS NULL`
      );

      // Now that every row holds a value, match the `permissions` column this
      // sits alongside (20260801120000) so the two behave identically.
      await queryInterface.changeColumn(TABLE, COLUMN, {
        type: Sequelize.JSON,
        allowNull: false,
      });
    }

    await remap(queryInterface, (current) => {
      if (!current.includes(LEGACY)) return null;
      const next = current.filter((p) => p !== LEGACY);
      SPLIT.forEach((p) => { if (!next.includes(p)) next.push(p); });
      return next;
    });
  },

  async down(queryInterface) {
    // Collapse the split back to the single capability. Someone granted only
    // stock.access (read-only — a state the old model could not express) folds
    // up to stock.manage, because read-only is not representable going back.
    await remap(queryInterface, (current) => {
      if (!SPLIT.some((p) => current.includes(p))) return null;
      const next = current.filter((p) => !SPLIT.includes(p));
      if (!next.includes(LEGACY)) next.push(LEGACY);
      return next;
    });

    const table = await queryInterface.describeTable(TABLE);
    if (table[COLUMN]) await queryInterface.removeColumn(TABLE, COLUMN);
  },
};
