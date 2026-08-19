const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  ALL_PERMISSIONS, PERMISSION_GROUPS, PERMISSIONS,
} = require('../constants/permissions');

// =====================================================================
// The vocabulary has to stay honest.
//
// Every toggle on the Permissions tab is a promise that granting it changes
// what somebody can do. The ways that promise silently breaks are all
// mechanical, so they are all testable:
//
//   - a capability exists but no route checks it   -> a toggle that does nothing
//   - a capability gates a route but no toggle offers it -> unreachable access
//   - a route names a capability that does not exist     -> a gate nobody passes
//   - a '.view' capability sits on a mutation            -> read access grants writes
//
// This reads the route files rather than a hand-kept list, so it keeps telling
// the truth as routes are added.
// =====================================================================

const ROUTES_DIR = path.join(__dirname, '..', 'routes');

// Capabilities checked somewhere other than an authorize() argument list, so a
// scan of the route text cannot see them. Each needs a reason.
const CHECKED_ELSEWHERE = {
  [PERMISSIONS.ADMIN_ACCESS]:
    "authorize()'s implicit admin bypass — it is not named in gates by design",
  [PERMISSIONS.STOCK_ACCESS]:
    'routes/stock.js via requirePermission(), as the stockRead middleware',
  [PERMISSIONS.STOCK_WRITE]:
    'routes/stock.js via requirePermission(), as the stockWrite middleware',
};

// Portal capabilities gate the frontend shell. A portal is a set of screens,
// not an API concept, so no route can check one.
const isPortal = (p) => p.startsWith('portal.');

/** Every route in the tree, with its method and the capabilities in its gate. */
const scanRoutes = () => {
  const found = [];
  for (const file of fs.readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.js'))) {
    const text = fs.readFileSync(path.join(ROUTES_DIR, file), 'utf8');
    const consts = Object.fromEntries(
      [...text.matchAll(/const\s+(\w+)\s*=\s*\[([^\]]*)\]/g)].map((m) => [m[1], m[2]])
    );
    // Split at each router.<verb>( so multi-line route definitions stay whole.
    for (const chunk of text.split(/(?=router\.(?:get|post|put|patch|delete)\()/)) {
      const head = chunk.match(/^router\.(get|post|put|patch|delete)\(\s*'([^']*)'/);
      if (!head) continue;
      const caps = new Set(
        [...chunk.matchAll(/'([a-z]+\.[a-z]+)'/g)].map((m) => m[1]).filter((c) => !c.endsWith('.js'))
      );
      for (const spread of [...chunk.matchAll(/\.\.\.(\w+)/g)].map((m) => m[1])) {
        if (consts[spread]) {
          for (const m of consts[spread].matchAll(/'([a-z]+\.[a-z]+)'/g)) caps.add(m[1]);
        }
      }
      found.push({ method: head[1].toUpperCase(), path: head[2], file, caps: [...caps] });
    }
  }
  return found;
};

const ROUTES = scanRoutes();
const GATED = new Set(ROUTES.flatMap((r) => r.caps));
const IN_TAB = PERMISSION_GROUPS.flatMap((g) => g.areas)
  .flatMap((a) => [a.access, a.write])
  .filter(Boolean);

describe('the permission vocabulary is complete and honest', () => {
  test('every capability is offered somewhere on the Permissions tab', () => {
    const missing = ALL_PERMISSIONS.filter((p) => !IN_TAB.includes(p));
    assert.deepEqual(missing, [],
      'a capability no toggle offers is access nobody can be granted');
  });

  test('the tab offers no capability that does not exist', () => {
    const unknown = IN_TAB.filter((p) => !ALL_PERMISSIONS.includes(p));
    assert.deepEqual(unknown, [], 'a toggle for a capability nothing checks does nothing');
  });

  test('no capability is offered twice', () => {
    const seen = new Set(); const dupes = [];
    IN_TAB.forEach((p) => (seen.has(p) ? dupes.push(p) : seen.add(p)));
    assert.deepEqual(dupes, [],
      'two controls writing the same capability fight each other');
  });

  test('every capability actually gates something', () => {
    const dead = ALL_PERMISSIONS
      .filter((p) => !isPortal(p))
      .filter((p) => !GATED.has(p))
      .filter((p) => !CHECKED_ELSEWHERE[p]);
    assert.deepEqual(dead, [],
      'granting this changes nothing — the toggle is a lie. Gate a route with it, '
      + 'or add it to CHECKED_ELSEWHERE with the reason.');
  });

  test('no route names a capability that does not exist', () => {
    const bogus = ROUTES.flatMap((r) => r.caps.filter((c) => !ALL_PERMISSIONS.includes(c))
      .map((c) => `${c} in ${r.file} ${r.method} ${r.path}`));
    assert.deepEqual(bogus, [],
      'a typo in a gate is a capability nobody can ever hold');
  });
});

describe('read capabilities do not grant writes', () => {
  test("no '.view' capability sits on a mutation route", () => {
    const offenders = ROUTES
      .filter((r) => r.method !== 'GET')
      .flatMap((r) => r.caps.filter((c) => c.endsWith('.view'))
        .map((c) => `${c} on ${r.method} ${r.file}${r.path}`));
    assert.deepEqual(offenders, [],
      'someone granted read access would be able to write');
  });

  test('every module with a write also has a way to see what it acts on', () => {
    // A write capability with no read route and no paired access capability is
    // unusable: you could change a thing you cannot look at.
    const areas = PERMISSION_GROUPS.flatMap((g) => g.areas).filter((a) => a.write);
    for (const area of areas) {
      const readable = area.access
        || ROUTES.some((r) => r.method === 'GET' && r.caps.includes(area.write));
      assert.ok(readable,
        `${area.name}: has a write capability but no paired access and no readable route`);
    }
  });
});
