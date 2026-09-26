// Messenger / Instagram sender-name lookup (services/metaMessagingApi
// fetchProfileName + services/metaMessagingInbound fillProfileName).
// Pure + a local fake Graph server; no database.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');

// A fake Graph API. `mode` decides how it answers the next profile lookup.
let mode = 'ok';
let lastUrl = null;
const server = http.createServer((req, res) => {
  lastUrl = req.url;
  if (mode === 'hang') return;   // never answers → exercises the timeout
  res.setHeader('Content-Type', 'application/json');
  if (mode === 'error') { res.statusCode = 400; return res.end(JSON.stringify({ error: { code: 100, message: 'Unsupported get request' } })); }
  if (mode === 'ig') return res.end(JSON.stringify({ name: '', username: 'amina.k', id: '1' }));
  return res.end(JSON.stringify({ first_name: 'Ebrahim', last_name: 'Yusuf', id: '1' }));
});

// Stub the settings reader BEFORE the api module is required, so no DB is touched.
let token = 'PAGE_TOKEN';
const cfgPath = path.join(__dirname, '..', 'utils', 'commsConfig.js');
require.cache[cfgPath] = {
  id: cfgPath, filename: cfgPath, loaded: true,
  exports: { getCommsConfig: async () => ({ pageAccessToken: token, graphVersion: 'v26.0', mediaMaxMb: 25 }), recordWebhookSeen: async () => {} },
};

let api;
test.before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.META_GRAPH_BASE = `http://127.0.0.1:${server.address().port}`;
  api = require('../services/metaMessagingApi');
});
test.after(() => { server.closeAllConnections?.(); server.close(); });

test('profileNameFrom: Messenger first + last name', () => {
  assert.strictEqual(api.profileNameFrom({ first_name: 'Amina', last_name: 'Kariuki' }), 'Amina Kariuki');
  assert.strictEqual(api.profileNameFrom({ first_name: 'Amina' }), 'Amina');
});

test('profileNameFrom: Instagram name, else @username, else null', () => {
  assert.strictEqual(api.profileNameFrom({ name: 'Amina K', username: 'amina.k' }), 'Amina K');
  assert.strictEqual(api.profileNameFrom({ name: '', username: 'amina.k' }), '@amina.k');
  assert.strictEqual(api.profileNameFrom({ id: '1' }), null);
  assert.strictEqual(api.profileNameFrom(null), null);
});

test('profileNameFrom: capped at the column width', () => {
  assert.strictEqual(api.profileNameFrom({ first_name: 'x'.repeat(300) }).length, 255);
});

test('fetchProfileName: Messenger asks for first/last name with the Page token', async () => {
  mode = 'ok';
  assert.strictEqual(await api.fetchProfileName('PSID123', 'messenger'), 'Ebrahim Yusuf');
  assert.match(lastUrl, /^\/v26\.0\/PSID123\?fields=first_name,last_name&access_token=PAGE_TOKEN$/);
});

test('fetchProfileName: Instagram asks for name,username', async () => {
  mode = 'ig';
  assert.strictEqual(await api.fetchProfileName('IGSID9', 'instagram'), '@amina.k');
  assert.match(lastUrl, /fields=name,username/);
});

test('fetchProfileName: Meta error → null, never throws', async () => {
  mode = 'error';
  assert.strictEqual(await api.fetchProfileName('PSID123', 'messenger'), null);
});

test('fetchProfileName: no answer → null after the timeout', { timeout: 10000 }, async () => {
  mode = 'hang';
  const t0 = Date.now();
  assert.strictEqual(await api.fetchProfileName('PSID123', 'messenger'), null);
  assert.ok(Date.now() - t0 < 8000);
});

test('fetchProfileName: not connected / unknown channel / no id → null', async () => {
  mode = 'ok';
  assert.strictEqual(await api.fetchProfileName('PSID123', 'whatsapp'), null);
  assert.strictEqual(await api.fetchProfileName('', 'messenger'), null);
  token = '';
  assert.strictEqual(await api.fetchProfileName('PSID123', 'messenger'), null);
  token = 'PAGE_TOKEN';
});

test('fillProfileName: names an unnamed thread, never overwrites a name', async () => {
  const { fillProfileName } = require('../services/metaMessagingInbound');
  mode = 'ok';
  const updates = [];
  const blank = { profileName: null, externalUserId: 'PSID123', update: async (v) => { updates.push(v); } };
  await fillProfileName(blank, 'messenger');
  assert.deepStrictEqual(updates, [{ profileName: 'Ebrahim Yusuf' }]);

  const named = { profileName: 'Already Set', externalUserId: 'PSID123', update: async (v) => { updates.push(v); } };
  await fillProfileName(named, 'messenger');
  assert.strictEqual(updates.length, 1);

  mode = 'error';
  const stillBlank = { profileName: null, externalUserId: 'PSID123', update: async (v) => { updates.push(v); } };
  await fillProfileName(stillBlank, 'messenger');
  assert.strictEqual(updates.length, 1);   // a failed lookup writes nothing
});
