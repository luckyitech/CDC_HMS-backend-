// HR Suite → Manual and its shared checklist (5 Oct 2026). Pure: the HR-staff
// gate (constants/permissions isHrStaff + the route middleware), the rules in
// utils/hrChecklist, and the controller's attribution with the models stubbed
// — who ticks or unticks always comes from req.user, never the body. DB
// behaviour was exercised on the scratch MariaDB (migrate up/down, tick, untick).
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const db = require('../models');
const {
  PERMISSIONS: P, PERMISSION_GROUPS, HR_STAFF_CONTROLS, isHrStaff,
} = require('../constants/permissions');
const R = require('../utils/hrChecklist');

const nurse = (extra = {}) => ({ id: 21, role: 'nurse', permissions: [], deniedPermissions: [], staffType: 'clinical', ...extra });
const staff = (extra = {}) => ({ id: 22, role: 'staff', permissions: [], deniedPermissions: [], staffType: 'non_clinical', ...extra });

describe('who counts as HR staff', () => {
  test('the list is every HR Suite control except Self-service', () => {
    const selfService = PERMISSION_GROUPS.find((g) => g.key === 'hr-self').areas.map((a) => a.access);
    assert.ok(selfService.includes(P.HR_SELF) && selfService.includes(P.HR_CHECKIN));
    selfService.forEach((p) => assert.ok(!HR_STAFF_CONTROLS.includes(p), p));
    [P.STAFF_VIEW, P.HR_VIEW, P.LEAVE_MANAGE, P.LEAVE_POLICY, P.HR_REPORTS, P.HR_ROSTER, P.HR_APPRAISALS_RUN,
      P.HR_SETTINGS, P.HR_GRANT, P.HR_CONFIDENTIAL, P.CPD_VERIFY].forEach((p) => assert.ok(HR_STAFF_CONTROLS.includes(p), p));
    assert.equal(new Set(HR_STAFF_CONTROLS).size, HR_STAFF_CONTROLS.length);
  });
  test('an ordinary nurse or receptionist (self-service only) is not', () => {
    assert.equal(isHrStaff(nurse()), false);
    assert.equal(isHrStaff(staff({ permissions: [P.HR_SELF, P.HR_CHECKIN] })), false);
    assert.equal(isHrStaff(null), false);
  });
  test('one HR control is enough', () => {
    assert.equal(isHrStaff(staff({ permissions: [P.HR_REPORTS] })), true);
    assert.equal(isHrStaff(nurse({ permissions: [P.STAFF_VIEW] })), true);
  });
  test('the admin account and admin.access holders are', () => {
    assert.equal(isHrStaff({ id: 1, role: 'admin', permissions: [] }), true);
    assert.equal(isHrStaff({ id: 2, role: 'doctor', permissions: [P.ADMIN_ACCESS], deniedPermissions: [] }), true);
  });
  test('a withdrawn control does not count, but withdrawing one never hides the manual from someone holding another', () => {
    assert.equal(isHrStaff(staff({ permissions: [P.HR_REPORTS], deniedPermissions: [P.HR_REPORTS] })), false);
    assert.equal(isHrStaff(staff({ permissions: [P.LEAVE_MANAGE], deniedPermissions: [P.LEAVE_SICK] })), true);
  });
  test('the frontend mirror lists the same controls', () => {
    const candidates = [
      path.join(__dirname, '..', '..', 'cdc_hms-frontend-', 'cdc-hms', 'src', 'utils', 'permissions.js'),
      path.join(__dirname, '..', '..', 'frontend', 'cdc-hms', 'src', 'utils', 'permissions.js'),
    ];
    const fe = candidates.find((f) => fs.existsSync(f));
    if (!fe) return;
    const src = fs.readFileSync(fe, 'utf8');
    const block = src.match(/export const HR_STAFF_CONTROLS = \[([\s\S]*?)\];/);
    assert.ok(block, 'frontend HR_STAFF_CONTROLS missing');
    const values = Object.fromEntries([...src.matchAll(/^\s+([A-Z_]+):\s+'([a-z.]+)'/gm)].map((m) => [m[1], m[2]]));
    const fe2 = [...block[1].matchAll(/PERMISSIONS\.([A-Z_]+)/g)].map((m) => values[m[1]]);
    assert.deepEqual([...fe2].sort(), [...HR_STAFF_CONTROLS].sort());
  });
});

describe('the route gate', () => {
  const router = require('../routes/hrChecklist');
  const routes = router.stack.filter((l) => l.route);
  const res = () => {
    const r = { statusCode: 200, body: null };
    r.status = (c) => { r.statusCode = c; return r; };
    r.json = (b) => { r.body = b; return r; };
    return r;
  };
  test('every route authenticates, then asks the HR-staff gate', () => {
    assert.ok(routes.length >= 5);
    for (const l of routes) {
      const names = l.route.stack.map((s) => s.name);
      assert.equal(names[0], 'authenticate', l.route.path);
      assert.equal(names[1], 'requireHrStaff', l.route.path);
    }
  });
  test('the gate refuses a non-HR user with 403 and admits HR staff', () => {
    const gate = routes[0].route.stack[1].handle;
    let passed = false;
    const r = res();
    gate({ user: nurse() }, r, () => { passed = true; });
    assert.equal(passed, false);
    assert.equal(r.statusCode, 403);
    assert.equal(r.body.success, false);
    gate({ user: staff({ permissions: [P.STAFF_VIEW] }) }, res(), () => { passed = true; });
    assert.equal(passed, true);
  });
  test('mounted before /api/hr', () => {
    const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    const manual = app.indexOf("'/api/hr/manual'");
    assert.ok(manual > 0 && manual < app.indexOf("app.use('/api/hr', "));
  });
});

describe('rules', () => {
  test('keys: built-in "<section>-<words>", custom "custom-<hex>"', () => {
    assert.equal(R.isValidKey('golive-departments'), true);
    assert.equal(R.isValidKey('day3-holidays'), true);
    assert.equal(R.isValidKey('custom-a1b2c3d4e5'), true);
    ['', 'golive', 'Golive-x', 'golive_x', '../etc', 'a'.repeat(70) + '-x', 'golive-x y'].forEach((k) => assert.equal(R.isValidKey(k), false, k));
    assert.equal(R.sectionOfKey('day3-holidays'), 'day3');
    assert.equal(R.sectionOfKey('custom-a1b2'), null);
  });
  test('only the manual\'s built-in keys and sections are accepted (review nit 6)', () => {
    assert.equal(R.isKnownKey('golive-departments'), true);
    assert.equal(R.isKnownKey('day5-agree-controls'), true);
    assert.equal(R.isKnownKey('custom-a1b2c3d4e5'), true);
    assert.equal(R.isKnownKey('zzz-anything'), false, 'well-formed but not in the manual');
    assert.equal(R.isKnownKey('golive-not-a-real-item'), false);
    assert.equal(R.sectionOfKey('zzz-anything'), null);
    assert.deepEqual(R.SECTIONS, ['golive', 'day1', 'day2', 'day3', 'day4', 'day5']);
    assert.ok(R.cleanNewItem({ section: 'foo', label: 'x' }).error);
    assert.ok(R.cleanNewItem({ section: 'day6', label: 'x' }).error);
    assert.ok(!R.cleanNewItem({ section: 'day5', label: 'x' }).error);
  });
  test('the server key list is the one the frontend was built with (no drift)', () => {
    const fe = [
      path.join(__dirname, '..', '..', 'cdc_hms-frontend-', 'cdc-hms', 'src', 'components', 'hr', 'manual', 'manualContent.js'),
      path.join(__dirname, '..', '..', 'frontend', 'cdc-hms', 'src', 'components', 'hr', 'manual', 'manualContent.js'),
    ].find((f) => fs.existsSync(f));
    if (!fe) return;
    const m = fs.readFileSync(fe, 'utf8').match(/export const CHECKLIST_SECTIONS = (\[[\s\S]*?\]);\n/);
    assert.ok(m, 'CHECKLIST_SECTIONS not found in manualContent.js');
    const frontend = Object.fromEntries(JSON.parse(m[1]).map((sec) => [sec.id, sec.items.map((i) => i.key)]));
    assert.deepEqual(require('../constants/hrChecklistKeys.json').sections, frontend,
      'rebuild with: node scripts/build-hr-manual.mjs --export <dir> --backend <backend repo>');
  });
  test('notes and new items are cleaned', () => {
    assert.deepEqual(R.cleanNote('  done  with  Esther '), { value: 'done with Esther' });
    assert.deepEqual(R.cleanNote(''), { value: null });
    assert.ok(R.cleanNote('x'.repeat(501)).error);
    assert.ok(R.cleanNote(5).error);
    assert.deepEqual(R.cleanNewItem({ section: 'golive', label: ' Order name badges ' }).value, { section: 'golive', label: 'Order name badges' });
    assert.ok(R.cleanNewItem({ section: 'golive', label: '  ' }).error);
    assert.ok(R.cleanNewItem({ section: 'custom', label: 'x' }).error);
    assert.ok(R.cleanNewItem({ section: 'Go Live', label: 'x' }).error);
  });
  test('tick / untick attribute to the actor; a no-op changes nothing', () => {
    const now = new Date('2026-10-05T07:14:00Z');
    assert.deepEqual(R.tickChange({ done: false }, true, 8, now),
      { patch: { done: true, doneById: 8, doneAt: now }, event: { action: 'tick', byId: 8 } });
    assert.deepEqual(R.tickChange({ done: true, doneById: 8 }, false, 9, now),
      { patch: { done: false, doneById: null, doneAt: null }, event: { action: 'untick', byId: 9 } });
    assert.equal(R.tickChange({ done: true }, true, 8, now), null);
    assert.equal(R.noteChange({ note: 'a' }, 'a', 8, now), null);
    assert.equal(R.noteChange({ note: null }, 'b', 8, now).event.byId, 8);
  });
});

describe('the controller attributes from req.user, never the body', () => {
  const controller = require('../controllers/hrChecklistController');
  let rows;
  let events;
  const fakeRow = (data) => ({
    ...data,
    async update(patch) { Object.assign(this, patch); return this; },
  });
  beforeEach(() => {
    rows = new Map();
    events = [];
    db.sequelize.transaction = async (fn) => fn({ LOCK: { UPDATE: 'UPDATE' } });
    db.HrChecklistItem.findOne = async ({ where }) => rows.get(where.itemKey) || null;
    db.HrChecklistItem.findOrCreate = async ({ where, defaults }) => {
      if (!rows.has(where.itemKey)) rows.set(where.itemKey, fakeRow({ done: false, note: null, status: 'active', ...defaults }));
      return [rows.get(where.itemKey), true];
    };
    db.HrChecklistItem.create = async (data) => { const r = fakeRow({ done: false, status: 'active', ...data }); rows.set(data.itemKey, r); return r; };
    db.HrChecklistEvent.create = async (data) => { events.push(data); return data; };
  });
  const res = () => {
    const r = { statusCode: 200 };
    r.status = (c) => { r.statusCode = c; return r; };
    r.json = (b) => { r.body = b; return r; };
    return r;
  };

  test('tick then untick: two history rows, each by the signed-in person', async () => {
    let r = res();
    await controller.setDone({ params: { key: 'golive-departments' }, body: { done: true, doneById: 99, byId: 99 }, user: { id: 8 } }, r);
    assert.equal(r.statusCode, 200);
    const row = rows.get('golive-departments');
    assert.equal(row.done, true);
    assert.equal(row.doneById, 8);
    assert.equal(row.section, 'golive');
    assert.equal(row.createdById, 8);
    assert.ok(row.doneAt instanceof Date);
    assert.deepEqual(events, [{ itemKey: 'golive-departments', action: 'tick', byId: 8 }]);

    r = res();
    await controller.setDone({ params: { key: 'golive-departments' }, body: { done: false }, user: { id: 9 } }, r);
    assert.equal(row.done, false);
    assert.equal(row.doneById, null);
    assert.deepEqual(events[1], { itemKey: 'golive-departments', action: 'untick', byId: 9 });
  });
  test('ticking twice records once', async () => {
    await controller.setDone({ params: { key: 'day1-read' }, body: { done: true }, user: { id: 8 } }, res());
    await controller.setDone({ params: { key: 'day1-read' }, body: { done: true }, user: { id: 9 } }, res());
    assert.equal(events.length, 1);
    assert.equal(rows.get('day1-read').doneById, 8);
  });
  test('a note is attributed and logged', async () => {
    await controller.setNote({ params: { key: 'golive-grace' }, body: { note: 'Agreed 5 min', noteById: 1 }, user: { id: 8 } }, res());
    assert.equal(rows.get('golive-grace').noteById, 8);
    assert.deepEqual(events[0], { itemKey: 'golive-grace', action: 'note', byId: 8, detail: 'Agreed 5 min' });
  });
  test('an unknown built-in key or section is refused and stores nothing', async () => {
    let r = res();
    await controller.setDone({ params: { key: 'zzz-anything' }, body: { done: true }, user: { id: 8 } }, r);
    assert.equal(r.statusCode, 400);
    r = res();
    await controller.setNote({ params: { key: 'golive-not-a-real-item' }, body: { note: 'x' }, user: { id: 8 } }, r);
    assert.equal(r.statusCode, 400);
    r = res();
    await controller.addItem({ body: { section: 'foo', label: 'Invisible' }, user: { id: 8 } }, r);
    assert.equal(r.statusCode, 400);
    assert.equal(rows.size, 0);
    assert.equal(events.length, 0);
  });
  test('an unknown custom key is 404; done must be a boolean', async () => {
    let r = res();
    await controller.setDone({ params: { key: 'custom-deadbeef' }, body: { done: true }, user: { id: 8 } }, r);
    assert.equal(r.statusCode, 404);
    r = res();
    await controller.setDone({ params: { key: 'day1-read' }, body: { done: 'yes' }, user: { id: 8 } }, r);
    assert.equal(r.statusCode, 400);
    assert.equal(events.length, 0);
  });
  test('custom items: added by the signed-in person, archived not deleted, archived items cannot be ticked', async () => {
    let r = res();
    await controller.addItem({ body: { section: 'golive', label: 'Order name badges', createdById: 99 }, user: { id: 8 } }, r);
    assert.equal(r.statusCode, 201);
    const [key] = [...rows.keys()];
    assert.match(key, /^custom-[0-9a-f]{10}$/);
    assert.equal(rows.get(key).createdById, 8);
    assert.equal(rows.get(key).isCustom, true);
    await controller.setStatus({ params: { key }, body: { status: 'archived' }, user: { id: 9 } }, res());
    assert.equal(rows.get(key).status, 'archived');
    assert.equal(rows.get(key).archivedById, 9);
    r = res();
    await controller.setDone({ params: { key }, body: { done: true }, user: { id: 8 } }, r);
    assert.equal(r.statusCode, 409);
    assert.deepEqual(events.map((e) => e.action), ['add', 'archive']);
    r = res();
    await controller.setStatus({ params: { key: 'golive-departments' }, body: { status: 'archived' }, user: { id: 9 } }, r);
    assert.equal(r.statusCode, 404, 'built-in items cannot be archived');
  });
});

describe('migration 20260928000018', () => {
  const rel = 'migrations/20260928000018-hr-manual-checklist.js';
  const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  test('guards with showAllTables and has a down', () => {
    const mig = require(`../${rel}`);
    assert.equal(typeof mig.up, 'function');
    assert.equal(typeof mig.down, 'function');
    assert.match(src, /showAllTables/);
    assert.doesNotMatch(src, /sync\(/);
  });
  test('down refuses while either table has rows, drops only empty tables', async () => {
    const mig = require(`../${rel}`);
    const fakeQi = (n) => {
      const dropped = [];
      return {
        dropped,
        showAllTables: async () => ['HrChecklistItems', 'hrchecklistevents'],
        dropTable: async (t) => { dropped.push(t); },
        sequelize: { query: async () => [[{ n }]] },
      };
    };
    const full = fakeQi(3);
    await assert.rejects(mig.down(full), /down refused: 3 checklist history row\(s\)/);
    assert.deepEqual(full.dropped, []);
    const empty = fakeQi(0);
    await mig.down(empty);
    assert.deepEqual(empty.dropped, ['hrchecklistevents', 'HrChecklistItems']);
  });
  test('the models match the migration columns', () => {
    for (const col of Object.keys(db.HrChecklistItem.rawAttributes).filter((c) => c !== 'id')) assert.match(src, new RegExp(`\\b${col}:`), col);
    for (const col of Object.keys(db.HrChecklistEvent.rawAttributes).filter((c) => c !== 'id')) assert.match(src, new RegExp(`\\b${col}:`), col);
  });
});
