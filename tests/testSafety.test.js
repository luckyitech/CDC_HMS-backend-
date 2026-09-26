const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// Test safety (26 Sep 2026). On 19 Sep a harness guarded by a block-list ran
// `sync({ force: true })` against a developer's database and dropped every
// clinical table. These tests keep that from ever happening again:
//   1. the shared guard (tests/_guard.js) only accepts a plainly throw-away
//      database — an allow-list, not a block-list;
//   2. EVERY script in the repo that can destroy tables calls that guard, and
//      calls it before it does anything destructive.

const { whyNot } = require('./_guard');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'uploads', 'private', 'migrations', 'logs']);
const DESTRUCTIVE = [
  /\.sync\(\s*\{[^}]*\bforce\s*:\s*true/,     // sequelize.sync({ force: true })
  /\bTRUNCATE\b/,                              // raw TRUNCATE
  /\btruncate\s*:\s*true/,                     // Model.destroy({ truncate: true })
  /\bdropAllTables\s*\(/,                      // queryInterface.dropAllTables()
  /\bDROP\s+(TABLE|DATABASE)\b/i,              // raw DROP
];

const listJs = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  if (e.isDirectory()) return SKIP_DIRS.has(e.name) ? [] : listJs(path.join(dir, e.name));
  return e.name.endsWith('.js') ? [path.join(dir, e.name)] : [];
});

const SELF = new Set([path.join(__dirname, '_guard.js'), __filename]);

// Comments are removed before scanning: a warning comment that MENTIONS
// sync({ force: true }) above the guard is documentation, not a statement.
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/^([ \t]*)\/\/.*$/gm, (m, lead) => lead + ' '.repeat(m.length - lead.length));

const firstMatch = (src) => {
  let at = -1;
  for (const re of DESTRUCTIVE) {
    const m = re.exec(src);
    if (m && (at < 0 || m.index < at)) at = m.index;
  }
  return at;
};

test('the guard accepts only a plainly throw-away local test database', () => {
  const ok = { CONFIRM_TEST_DB: '1', DB_NAME: 'cdc_scratch', DB_HOST: '127.0.0.1', NODE_ENV: 'development' };
  assert.deepStrictEqual(whyNot(ok), []);
  assert.deepStrictEqual(whyNot({ ...ok, DB_NAME: 'hms_test', DB_HOST: 'localhost' }), []);

  // Every one of these must be refused.
  const refused = {
    'no confirmation': { ...ok, CONFIRM_TEST_DB: undefined },
    'confirmation not exactly 1': { ...ok, CONFIRM_TEST_DB: 'true' },
    'the local dev database': { ...ok, DB_NAME: 'cdc_hms' },
    'a name nobody put on a block-list': { ...ok, DB_NAME: 'cdc' },
    'a copy of prod': { ...ok, DB_NAME: 'cdc_hms_copy' },
    'prod, even if it says test': { ...ok, DB_NAME: 'prod_test' },
    'no name': { ...ok, DB_NAME: '' },
    'a remote host': { ...ok, DB_HOST: '102.68.87.103' },
    'no host': { ...ok, DB_HOST: undefined },
    'production mode': { ...ok, NODE_ENV: 'production' },
  };
  for (const [why, env] of Object.entries(refused)) {
    assert.ok(whyNot(env).length > 0, `should refuse: ${why}`);
  }
});

test('every script that can drop or empty tables calls the guard first', () => {
  const offenders = [];
  let destructiveFiles = 0;
  for (const file of listJs(ROOT)) {
    if (SELF.has(file)) continue;
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    const danger = firstMatch(src);
    if (danger < 0) continue;
    destructiveFiles += 1;
    const guard = src.indexOf('assertThrowawayDb(');
    const rel = path.relative(ROOT, file);
    if (guard < 0) offenders.push(`${rel}: destroys tables but never calls assertThrowawayDb()`);
    else if (guard > danger) offenders.push(`${rel}: calls assertThrowawayDb() only AFTER its first destructive statement`);
  }
  assert.deepStrictEqual(offenders, [], `\n${offenders.join('\n')}\nImport tests/_guard.js and call assertThrowawayDb() at the top.`);
  // The scan must actually be finding the harnesses — if this drops to 0 the
  // patterns above have stopped matching and the test would pass vacuously.
  assert.ok(destructiveFiles >= 9, `expected the known harnesses to be scanned, found ${destructiveFiles}`);
});

test('npm test never runs the database harnesses', () => {
  const { scripts } = require('../package.json');
  assert.match(scripts.test, /tests\/\*\.test\.js/);
  assert.doesNotMatch(scripts.test, /_gmc|_comms|_hr|\*\*/, 'npm test must stay unit-only (top-level tests/*.test.js)');
});
