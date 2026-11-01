// Rate limiters (1 Nov 2026): IIS forwards the client as "IP:port". The key
// must be the bare address (so a new port is not a new allowance) and the
// library must not log ERR_ERL_INVALID_IP_ADDRESS. The clinic-traffic limiters
// run in watch mode (log, never refuse); the login limiter refuses.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { generalLimiter, authLimiter, keyGenerator, clientIp, watch } = require('../middleware/rateLimiter');

const serve = (app) => new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const hit = (s, path, xff, method = 'GET') => fetch(`http://127.0.0.1:${s.address().port}${path}`, { method, headers: { 'X-Forwarded-For': xff } });

test('the client address loses IIS\'s port and the IPv4-mapped prefix', () => {
  assert.equal(clientIp({ ip: '197.248.95.205:58192' }), '197.248.95.205');
  assert.equal(clientIp({ ip: '::ffff:10.0.0.1' }), '10.0.0.1');
  assert.equal(clientIp({ ip: '[2001:db8::1]:443' }), '2001:db8::1');
  assert.equal(clientIp({ ip: '41.90.1.2' }), '41.90.1.2');
  assert.equal(typeof keyGenerator({ ip: '41.90.1.2:1' }), 'string');
  assert.equal(keyGenerator({ ip: '2001:db8::1' }), '2001:db8::/56');
});

test('one address on two ports shares one count, and nothing is logged as invalid', async (t) => {
  const errs = []; const orig = console.error;
  console.error = (...a) => errs.push(a.join(' '));
  t.after(() => { console.error = orig; });
  const app = express(); app.set('trust proxy', 1);
  app.get('/x', generalLimiter, (req, res) => res.json({ key: req.rateLimit.key, used: req.rateLimit.used }));
  const s = await serve(app); t.after(() => s.close());
  const a = await (await hit(s, '/x', '197.248.95.205:58192')).json();
  const b = await (await hit(s, '/x', '197.248.95.205:60000')).json();
  assert.equal(a.key, '197.248.95.205');
  assert.equal(b.used, a.used + 1);
  assert.ok(!errs.some((e) => e.includes('ERR_ERL')), errs.join('\n'));
});

test('watch mode lets an over-limit request through and logs once per window', async (t) => {
  const warns = []; const orig = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  t.after(() => { console.warn = orig; });
  const lim = rateLimit({ windowMs: 60000, max: 2, keyGenerator, handler: watch('demo'), standardHeaders: true, legacyHeaders: false });
  const app = express(); app.set('trust proxy', 1);
  app.get('/x', lim, (req, res) => res.json({ ok: true }));
  const s = await serve(app); t.after(() => s.close());
  for (let i = 0; i < 5; i++) assert.equal((await hit(s, '/x', '41.90.1.2:' + (5000 + i))).status, 200);
  const mine = warns.filter((w) => w.includes('[rate-limit] demo'));
  assert.equal(mine.length, 1, warns.join('\n'));
  assert.match(mine[0], /41\.90\.1\.2/);
});

test('the login limiter refuses after 50 failed logins from one address, whatever the port', async (t) => {
  const app = express(); app.set('trust proxy', 1);
  app.post('/login', authLimiter, (req, res) => res.status(401).json({ ok: false }));
  const s = await serve(app); t.after(() => s.close());
  for (let i = 0; i < 50; i++) assert.equal((await hit(s, '/login', `41.90.9.9:${6000 + i}`, 'POST')).status, 401);
  assert.equal((await hit(s, '/login', '41.90.9.9:7999', 'POST')).status, 429);
  assert.equal((await hit(s, '/login', '41.90.9.10:7999', 'POST')).status, 401);
});
