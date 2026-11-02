const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { cleanIp, clientIp, parseNetwork, matchNetwork, isPublicIp } = require('../utils/ip');
const { deviceLabel } = require('../utils/deviceLabel');
const { successReasons, failedBurstReached, isOutsideHours } = require('../utils/signinFlags');
const { PROVIDERS } = require('../services/ipLookup');
const perms = require('../constants/permissions');

// =====================================================================
// Sign-in tracking (16 Oct 2026) — the pure parts: what an address is, which
// network it is on, what a device is called, when a sign-in is suspicious,
// how the lookup answers are read, and who may see any of it.
// =====================================================================

describe('client addresses', () => {
  test('IIS forms are cleaned to a bare address', () => {
    assert.equal(cleanIp('197.248.95.205:58192'), '197.248.95.205');
    assert.equal(cleanIp('::ffff:197.248.95.205'), '197.248.95.205');
    assert.equal(cleanIp('[2001:db8::1]:443'), '2001:db8::1');
    assert.equal(cleanIp('  41.90.1.2 '), '41.90.1.2');
    assert.equal(cleanIp('not an ip'), null);
    assert.equal(cleanIp(''), null);
    assert.equal(cleanIp(null), null);
  });

  test('the address comes from req.ip (trusted hop), never the left-most forwarded entry', () => {
    const req = { ip: '197.248.95.205:58192', headers: { 'x-forwarded-for': '1.2.3.4, 197.248.95.205:58192' } };
    assert.equal(clientIp(req), '197.248.95.205');
  });

  test('public vs private', () => {
    assert.equal(isPublicIp('197.248.95.205'), true);
    for (const ip of ['10.0.0.5', '192.168.1.10', '172.20.1.1', '127.0.0.1', '100.64.3.4', '::1', 'fe80::1']) {
      assert.equal(isPublicIp(ip), false, ip);
    }
  });
});

describe('clinic networks', () => {
  const networks = [
    { value: '197.248.95.205', label: 'Main line' },
    { value: '41.90.64.0/24', label: 'Backup line' },
    { value: '2001:db8:1::/48', label: 'IPv6' },
  ];
  test('single addresses and ranges match', () => {
    assert.equal(matchNetwork('197.248.95.205', networks).label, 'Main line');
    assert.equal(matchNetwork('41.90.64.77', networks).label, 'Backup line');
    assert.equal(matchNetwork('2001:db8:1:5::9', networks).label, 'IPv6');
    assert.equal(matchNetwork('41.90.65.1', networks), null);
    assert.equal(matchNetwork('197.248.95.206', networks), null);
  });
  test('entries are validated', () => {
    assert.deepEqual(parseNetwork('41.90.64.0/24'), { address: '41.90.64.0', prefix: 24, family: 'ipv4' });
    assert.equal(parseNetwork('41.90.64.0/33'), null);
    assert.equal(parseNetwork('300.1.1.1'), null);
    assert.equal(parseNetwork('1.2.3.4/24/1'), null);
  });
});

describe('device labels', () => {
  test('common browsers', () => {
    assert.equal(deviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'), 'Mac · Safari');
    assert.equal(deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 Edg/120.0'), 'Windows · Edge');
    assert.equal(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0 Mobile/15E148 Safari/604.1'), 'iPhone · Chrome');
    assert.equal(deviceLabel('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36'), 'Android · Chrome');
    assert.equal(deviceLabel(''), 'Unknown device · browser');
    assert.equal(deviceLabel('', 'Phone'), 'Phone · browser');
  });
});

describe('when a sign-in is flagged', () => {
  const rules = { newDevice: true, newCountry: true, outsideClinic: false, outsideHours: true, failedAttempts: true, failedCount: 5, failedWindowMinutes: 15 };
  const hours = { 0: 'off', 1: ['07:00', '19:00'], 2: ['07:00', '19:00'], 3: ['07:00', '19:00'], 4: ['07:00', '19:00'], 5: ['07:00', '19:00'], 6: ['07:00', '14:00'] };
  // Friday 16 Oct 2026, 10:00 at the clinic (07:00 UTC)
  const inHours = '2026-10-16T07:00:00Z';
  // Friday 16 Oct 2026, 22:30 at the clinic
  const late = '2026-10-16T19:30:00Z';
  const history = { hasBaseline: true, devices: new Set(['Mac · Chrome']), countries: new Set(['KE']) };

  test('a known device, country and hour is not flagged', () => {
    assert.deepEqual(successReasons({ signin: { deviceLabel: 'Mac · Chrome', countryCode: 'KE', network: 'outside', loginAt: inHours }, history, rules, hours }), []);
  });
  test('new device, new country, outside hours', () => {
    assert.deepEqual(
      successReasons({ signin: { deviceLabel: 'Android · Chrome', countryCode: 'TZ', network: 'outside', loginAt: late }, history, rules, hours }),
      ['new_device', 'new_country', 'outside_hours'],
    );
  });
  test('the first device ever recorded is the baseline, not a new device', () => {
    const first = { hasBaseline: false, devices: new Set(), countries: new Set() };
    assert.deepEqual(successReasons({ signin: { deviceLabel: 'Android · Chrome', countryCode: 'KE', network: 'outside', loginAt: inHours }, history: first, rules, hours }), []);
  });
  test('outside the clinic only when that rule is on', () => {
    const on = { ...rules, outsideClinic: true };
    assert.deepEqual(successReasons({ signin: { deviceLabel: 'Mac · Chrome', countryCode: 'KE', network: 'outside', loginAt: inHours }, history, rules: on, hours }), ['outside_clinic']);
  });
  test('a 24/7 clinic switches hours off', () => {
    assert.deepEqual(successReasons({ signin: { deviceLabel: 'Mac · Chrome', countryCode: 'KE', network: 'clinic', loginAt: late }, history, rules: { ...rules, outsideHours: false }, hours }), []);
  });
  test('Sunday is outside hours when the day is off; boundaries', () => {
    assert.equal(isOutsideHours(hours, new Date('2026-10-18T07:00:00Z')), true);           // Sunday 10:00
    assert.equal(isOutsideHours(hours, new Date('2026-10-16T04:00:00Z')), false);          // Fri 07:00 exactly
    assert.equal(isOutsideHours(hours, new Date('2026-10-16T16:00:00Z')), true);           // Fri 19:00 exactly
  });
  test('one alert per burst of failures', () => {
    assert.equal(failedBurstReached({ rules, recentFailures: 4 }), false);
    assert.equal(failedBurstReached({ rules, recentFailures: 5 }), true);
    assert.equal(failedBurstReached({ rules, recentFailures: 6 }), false);
    assert.equal(failedBurstReached({ rules: { ...rules, failedAttempts: false }, recentFailures: 5 }), false);
  });
});

describe('lookup answers', () => {
  test('ipapi.co', () => {
    assert.deepEqual(PROVIDERS.ipapi.parse({ city: 'Mombasa', region: 'Mombasa', country_code: 'KE', country_name: 'Kenya', org: 'Safaricom Limited' }),
      { countryCode: 'KE', country: 'Kenya', region: 'Mombasa', city: 'Mombasa', isp: 'Safaricom Limited' });
    assert.equal(PROVIDERS.ipapi.parse({ error: true, reason: 'RateLimited' }), null);
  });
  test('ipinfo full and Lite', () => {
    assert.deepEqual(PROVIDERS.ipinfo.parse({ city: 'Nairobi', region: 'Nairobi County', country: 'KE', org: 'AS33771 Safaricom Limited' }),
      { countryCode: 'KE', country: null, region: 'Nairobi County', city: 'Nairobi', isp: 'Safaricom Limited' });
    assert.deepEqual(PROVIDERS.ipinfo.parse({ country_code: 'KE', country: 'Kenya', as_name: 'Safaricom Limited' }),
      { countryCode: 'KE', country: 'Kenya', region: null, city: null, isp: 'Safaricom Limited' });
    assert.equal(PROVIDERS.ipinfo.parse({ bogon: true }), null);
  });
});

describe('who may see and change it', () => {
  const { canViewSignins, canReceiveSigninAlerts, canEditSigninSecurity, PERMISSIONS, ADMIN_ACCESS_COVERS, PRESET_EXCLUDED } = perms;
  const doctor = (permissions = [], deniedPermissions = []) => ({ role: 'doctor', permissions, deniedPermissions });
  test('full administrator access does not carry it', () => {
    assert.equal(canViewSignins(doctor(['admin.access'])), false);
    assert.equal(canEditSigninSecurity(doctor(['admin.access'])), false);
    for (const p of [PERMISSIONS.SIGNINS_VIEW, PERMISSIONS.SIGNINS_ALERTS, PERMISSIONS.SIGNIN_SETTINGS]) {
      assert.equal(ADMIN_ACCESS_COVERS.includes(p), false, p);
      assert.equal(PRESET_EXCLUDED.includes(p), true, p);
    }
  });
  test('an explicit grant does; alerts and settings bring the view; a withdrawal wins', () => {
    assert.equal(canViewSignins(doctor(['it.signins.view'])), true);
    assert.equal(canViewSignins(doctor(['it.signins.alerts'])), true);
    assert.equal(canViewSignins(doctor(['it.security.settings'])), true);
    assert.equal(canReceiveSigninAlerts(doctor(['it.signins.view'])), false);
    assert.equal(canViewSignins(doctor(['it.signins.view'], ['it.signins.view'])), false);
  });
  test('the main admin account always', () => {
    assert.equal(canViewSignins({ role: 'admin' }), true);
    assert.equal(canReceiveSigninAlerts({ role: 'admin' }), true);
    assert.equal(canEditSigninSecurity({ role: 'admin' }), true);
  });
});
