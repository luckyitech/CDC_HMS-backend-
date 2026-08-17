const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// =====================================================================
// Login tracking.
//
// The failure this guards against is silent: logLogin swallows insert errors,
// so a role listed as tracked but missing from the UserLoginLog enum simply
// never appears — no exception, no log line, just an empty Activity tab that
// looks like the person has never signed in.
//
// Asserted against the source rather than a live database so it runs anywhere.
// =====================================================================

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const trackedRoles = () => {
  const src = read('services/activityLogService.js');
  const match = src.match(/TRACKED_ROLES = new Set\(\[([^\]]*)\]/);
  assert.ok(match, 'TRACKED_ROLES not found');
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
};

const enumRoles = () => {
  const src = read('models/UserLoginLog.js');
  const match = src.match(/role:\s*\{[\s\S]*?DataTypes\.ENUM\(([^)]*)\)/);
  assert.ok(match, 'role ENUM not found');
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
};

describe('login tracking', () => {
  test('nurses and admins are tracked', () => {
    const tracked = trackedRoles();
    assert.ok(tracked.includes('nurse'), 'nurse logins are not tracked');
    assert.ok(tracked.includes('admin'), 'admin logins are not tracked');
  });

  test('patients are not tracked — different trust boundary', () => {
    assert.equal(trackedRoles().includes('patient'), false);
  });

  // The one that matters: a mismatch here fails silently at runtime.
  test('every tracked role is storable by the model', () => {
    const storable = enumRoles();
    trackedRoles().forEach((role) => {
      assert.ok(storable.includes(role),
        `${role} is tracked but missing from the UserLoginLog role enum — its logins would be dropped`);
    });
  });

  test('a migration widens the enum rather than relying on sync', () => {
    const files = fs.readdirSync(path.join(__dirname, '..', 'migrations'));
    const widening = files.find((f) => f.includes('user-login-log-role'));
    assert.ok(widening, 'no migration widens the UserLoginLogs role enum');

    const src = read(path.join('migrations', widening));
    assert.ok(src.includes("'nurse'") && src.includes("'admin'"));
  });
});
