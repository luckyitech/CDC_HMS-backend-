// =====================================================================
// THE guard for anything that can destroy a database: sync({ force }),
// TRUNCATE, dropping tables. Every script under tests/ that does any of that
// must call assertThrowawayDb() BEFORE it loads the models — enforced by
// tests/testSafety.test.js, which fails `npm test` if a destructive script
// skips it.
//
// Why an ALLOW-list: on 19 Sep 2026 a harness guarded only by a block-list of
// names ran `sync({ force: true })` against a developer's database and dropped
// every clinical table. A block-list fails open for any name nobody thought of
// (a renamed prod DB, a copy called "cdc"); an allow-list fails closed.
//
// A database is treated as throw-away only when ALL of these hold:
//   - CONFIRM_TEST_DB=1 is set deliberately,
//   - DB_NAME says so: contains "test" or "scratch", and never "prod",
//   - DB_HOST is this machine (localhost / 127.0.0.1 / ::1),
//   - NODE_ENV is not "production".
// =====================================================================

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/** Every reason this environment is NOT a throw-away database ([] = safe). */
const whyNot = (env = process.env) => {
  const reasons = [];
  const name = String(env.DB_NAME || '');
  const host = String(env.DB_HOST || '');
  if (env.CONFIRM_TEST_DB !== '1') reasons.push('CONFIRM_TEST_DB is not "1"');
  if (!name) reasons.push('DB_NAME is not set');
  else {
    if (!/test|scratch/i.test(name)) reasons.push(`DB_NAME "${name}" does not contain "test" or "scratch"`);
    if (/prod/i.test(name)) reasons.push(`DB_NAME "${name}" contains "prod"`);
  }
  if (!LOCAL_HOSTS.has(host)) reasons.push(`DB_HOST "${host}" is not this machine`);
  if (String(env.NODE_ENV || '').toLowerCase() === 'production') reasons.push('NODE_ENV is "production"');
  return reasons;
};

/**
 * Stop the process unless the configured database is plainly throw-away.
 * @param {string} label       shown in the refusal, e.g. 'gmc test'
 * @param {number} [exitCode]  0 for smoke harnesses (a refusal is not a test
 *                             failure); 1 for manual scripts, so a mistaken run
 *                             is visibly an error
 */
const assertThrowawayDb = (label, exitCode = 0) => {
  const reasons = whyNot(process.env);
  if (!reasons.length) return;
  console.error(`[${label}] refusing to run — this script DROPS TABLES and the database is not a throw-away test database:`);
  for (const r of reasons) console.error(`  - ${r}`);
  console.error('Point .env.test at an empty local database whose name contains "test" or "scratch", and set CONFIRM_TEST_DB=1.');
  process.exit(exitCode);
};

module.exports = { whyNot, assertThrowawayDb, LOCAL_HOSTS };
