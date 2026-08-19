'use strict';

// Portal entry becomes an explicit grant.
//
// Until now, holding 'admin.access' opened EVERY portal: ProtectedRoute short-
// circuited on it before it ever looked at the requested route. That is the
// behaviour this feature replaces — a person can now be given the Lab portal
// without being given the Admin portal, and vice versa.
//
// The replacement would otherwise take access away at deploy time from everyone
// who currently relies on the old blanket rule. So every existing holder of
// 'admin.access' is granted all five portal capabilities explicitly, which is
// exactly what they could reach yesterday. Nobody gains or loses anything here;
// the change is that from now on it is written down and can be narrowed.
//
// A real 'admin' ROLE account is skipped: it holds everything implicitly (see
// constants/permissions.js), so writing a list onto its row would be a second
// copy of the same fact, free to drift.
//
// Idempotent, with a working down().

const TABLE = 'Users';

const ADMIN_ACCESS = 'admin.access';
const PORTALS = [
  'portal.admin',
  'portal.doctor',
  'portal.staff',
  'portal.lab',
  'portal.inpatient',
];

// Rewrites the permissions JSON array row by row. Done in JS rather than as a
// JSON_* SQL expression because the column is portable JSON and the row count
// here is staff, not patients — tens, not millions.
const remap = async (queryInterface, fn) => {
  const [rows] = await queryInterface.sequelize.query(
    `SELECT id, role, permissions FROM ${TABLE}`
  );

  let changed = 0;
  for (const row of rows) {
    let current = row.permissions;
    // MySQL returns JSON as a parsed value through some drivers and as a string
    // through others; tolerate both rather than assuming.
    if (typeof current === 'string') {
      try { current = JSON.parse(current); } catch { current = []; }
    }
    if (!Array.isArray(current)) current = [];

    const next = fn(current, row);
    if (next === null) continue;

    await queryInterface.sequelize.query(
      `UPDATE ${TABLE} SET permissions = :perms WHERE id = :id`,
      { replacements: { perms: JSON.stringify(next), id: row.id } }
    );
    changed += 1;
  }
  return changed;
};

module.exports = {
  async up(queryInterface) {
    const n = await remap(queryInterface, (current, row) => {
      if (row.role === 'admin') return null;          // holds everything implicitly
      if (!current.includes(ADMIN_ACCESS)) return null;
      const next = [...current];
      let added = false;
      PORTALS.forEach((p) => {
        if (!next.includes(p)) { next.push(p); added = true; }
      });
      return added ? next : null;
    });
    console.log(`Backfilled portal grants for ${n} user(s) holding ${ADMIN_ACCESS}.`);
  },

  async down(queryInterface) {
    // Remove only the portal capabilities. Anything else granted since is left
    // alone — this migration never touched it.
    const n = await remap(queryInterface, (current) => {
      if (!PORTALS.some((p) => current.includes(p))) return null;
      return current.filter((p) => !PORTALS.includes(p));
    });
    console.log(`Removed portal grants from ${n} user(s).`);
  },
};
