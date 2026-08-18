const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');

const db = require('../models');
const { PERMISSIONS } = require('../constants/permissions');
const userController = require('../controllers/userController');

// =====================================================================
// GET /api/users must report what a user can actually do.
//
// listUsers selects an explicit column list, and `permissions` was missing from
// it. Nothing failed loudly: formatUserResponse read undefined, reported
// permissions: [] and every capability false, and the API quietly disagreed
// with what the server enforces. A screen built on that would show a person as
// holding nothing while they in fact hold admin access.
//
// The column list is the fragile part — anyone adding a derived field to
// formatUserResponse has to remember to add its source column here. This test
// is what catches that.
// =====================================================================

if (process.env.NODE_ENV === 'production') {
  throw new Error('Refusing to run against production.');
}

const TAG = '__TEST_USERLIST__';
const made = [];

const mkRes = () => {
  const r = { code: 200, body: null };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
};

before(async () => { await db.sequelize.authenticate(); });

after(async () => {
  await db.User.destroy({ where: { id: { [Op.in]: made.length ? made : [0] } } });
  await db.sequelize.close();
});

describe('listUsers reports real capabilities', () => {
  test('a granted user comes back holding what was granted', async () => {
    const u = await db.User.create({
      firstName: 'List', lastName: 'Perms',
      email: `${TAG}.${Date.now()}@cdc.test`,
      password: 'x', role: 'doctor', isActive: true,
      permissions: [PERMISSIONS.ADMIN_ACCESS, PERMISSIONS.STOCK_ACCESS],
      deniedPermissions: [PERMISSIONS.MONITORING_VIEW],
    });
    made.push(u.id);

    const res = mkRes();
    await userController.listUsers({ query: {}, user: { role: 'admin' } }, res);
    assert.equal(res.code, 200);

    const rows = res.body.data?.users || res.body.data || [];
    const row = rows.find((r) => r.id === u.id);
    assert.ok(row, 'the user should appear in the list');

    // The actual regression: these were [] / false for every row.
    assert.ok(row.permissions.includes(PERMISSIONS.ADMIN_ACCESS),
      'permissions must be selected, or the API reports capabilities nobody has');
    assert.equal(row.hasAdminAccess, true);
    assert.equal(row.canManageStock, true);
    assert.ok(row.deniedPermissions.includes(PERMISSIONS.MONITORING_VIEW),
      'withdrawals must be reported too, or a restricted account looks unrestricted');
  });

  test('a user with nothing granted is reported as such', async () => {
    const u = await db.User.create({
      firstName: 'List', lastName: 'Bare',
      email: `${TAG}.bare.${Date.now()}@cdc.test`,
      password: 'x', role: 'staff', isActive: true,
      permissions: [], deniedPermissions: [],
    });
    made.push(u.id);

    const res = mkRes();
    await userController.listUsers({ query: {}, user: { role: 'admin' } }, res);
    const rows = res.body.data?.users || res.body.data || [];
    const row = rows.find((r) => r.id === u.id);

    assert.deepEqual(row.permissions, []);
    assert.equal(row.hasAdminAccess, false);
    assert.equal(row.canManageStock, false);
  });
});
