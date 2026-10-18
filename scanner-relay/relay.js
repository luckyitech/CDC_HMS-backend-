'use strict';
// =====================================================================
// CDC HMS — fingerprint-scanner relay (attendance PC).
//
// Reads punches from the clinic's ZKTeco K40 over the LAN (k40.js) and
// sends them to the HMS (POST /api/hr/scanner-relay/punches). Every minute
// it asks the scanner how many records it holds and downloads only when
// that number changes, so the scanner is busy for a second or two after a
// punch and otherwise left alone. After each look it sends a heartbeat —
// that is what HR sees as "Scanner online".
//
// The scanner is the queue: nothing is deleted from it, and the relay only
// moves its bookmark (state.json: how many of the scanner's records have
// been sent) once the HMS has accepted them. The HMS ignores repeats.
//
// Fingerprints never leave the scanner: punches (user number, time, method)
// and the user list (number and name) are all that is read.
//
// Usage:  node relay.js            run forever (the installer registers this
//                                  as a task that starts with Windows)
//         node relay.js --check    connect once, print what it sees, send
//                                  one heartbeat and the first batch
// Config: config.json beside this file, or in the folder CDC_RELAY_HOME.
// Node built-ins only — no packages.
// =====================================================================
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { K40 } = require('./k40');

const VERSION = '1.1.0';
// Where config.json, state.json and the log live: CDC_RELAY_HOME if set;
// on Windows, ProgramData\CDC Scanner Relay (the installer writes config.json
// there, and Program Files is read-only); otherwise beside this file.
const defaultHome = () => {
  if (process.platform === 'win32' && process.env.ProgramData) {
    const dir = path.join(process.env.ProgramData, 'CDC Scanner Relay');
    try { fs.mkdirSync(dir, { recursive: true }); return dir; } catch { /* fall through */ }
  }
  return __dirname;
};
const HOME = process.env.CDC_RELAY_HOME || defaultHome();
const CONFIG_FILE = path.join(HOME, 'config.json');
const STATE_FILE = path.join(HOME, 'state.json');
const LOG_FILE = path.join(HOME, 'scanner-relay.log');
const BATCH = 1000;

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const cfg = {
  HMIS_API_URL: 'https://api.cdiabetescentre.com/api',
  SCANNER_KEY: '', SCANNER_SERIAL: '', SCANNER_IP: '192.168.0.132', SCANNER_PORT: 4370, SCANNER_PASSWORD: 0,
  POLL_SECONDS: 60, USERS_EVERY_MINUTES: 30,
  ...readJson(CONFIG_FILE, {}),
};
for (const k of Object.keys(cfg)) if (process.env[k] !== undefined) cfg[k] = process.env[k];
const apiUrl = String(cfg.HMIS_API_URL).replace(/\/+$/, '');

const pad = (n) => String(n).padStart(2, '0');
const localStamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

// --- logging (file + console, rotated at 2 MB) --------------------------
const log = (level, msg) => {
  const line = `${localStamp(new Date())} ${level} ${msg}`;
  // A background task has no console; the file is the log that matters.
  try { process.stdout.write(`${line}\n`); } catch { /* no console */ }
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 2_000_000) {
      for (let i = 2; i >= 1; i -= 1) if (fs.existsSync(`${LOG_FILE}.${i}`)) fs.renameSync(`${LOG_FILE}.${i}`, `${LOG_FILE}.${i + 1}`);
      fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
    }
    fs.appendFileSync(LOG_FILE, `${line}\n`);
  } catch { /* a log that cannot be written must not stop the relay */ }
};

// --- state -------------------------------------------------------------
const loadState = () => readJson(STATE_FILE, { sentCount: null, recordCount: null, usersSentAt: 0, sinceLocal: null });
const saveState = (state) => { fs.writeFileSync(`${STATE_FILE}.tmp`, JSON.stringify(state)); fs.renameSync(`${STATE_FILE}.tmp`, STATE_FILE); };

// --- HMS ---------------------------------------------------------------
const post = (route, body) => new Promise((resolve, reject) => {
  const url = new URL(`${apiUrl}/hr/scanner-relay/${route}`);
  const payload = JSON.stringify(body);
  const req = (url.protocol === 'https:' ? https : http).request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'x-scanner-key': cfg.SCANNER_KEY, 'x-scanner-serial': cfg.SCANNER_SERIAL },
    timeout: 120000,   // a first sync after linking can take a while on the server
  }, (res) => {
    let text = '';
    res.on('data', (d) => { text += d; });
    res.on('end', () => {
      let json = null;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      if (res.statusCode >= 400) return reject(new Error(`HMS ${route} refused (${res.statusCode}): ${json?.message || text.slice(0, 200)}`));
      return resolve(json?.data || {});
    });
  });
  req.on('timeout', () => req.destroy(new Error('HMS did not answer in time')));
  req.on('error', reject);
  req.end(payload);
});

// --- one look at the scanner --------------------------------------------
const cycle = async (state, check = false) => {
  const zk = new K40({ ip: cfg.SCANNER_IP, port: Number(cfg.SCANNER_PORT), password: cfg.SCANNER_PASSWORD });
  try {
    await zk.connect();
  } catch (e) {
    log('WARN', `Scanner ${cfg.SCANNER_IP}:${cfg.SCANNER_PORT} not reachable: ${e.message}`);
    return false;
  }
  try {
    const sizes = await zk.sizes();
    if (check) {
      const serial = await zk.serialNumber();
      log('INFO', `Connected. Serial ${serial}, firmware ${await zk.firmware()}, ${sizes.records} records, ${sizes.users} users`);
      if (serial !== cfg.SCANNER_SERIAL) log('ERROR', `SCANNER_SERIAL in config (${cfg.SCANNER_SERIAL}) does not match the scanner (${serial})`);
    }

    let userList = null;
    if (check || Date.now() - (state.usersSentAt || 0) > Number(cfg.USERS_EVERY_MINUTES) * 60000) {
      userList = (await zk.users()).map((u) => ({ userNo: String(u.userId), name: u.name }));
    }

    // Sending punches and reporting in are separate: a slow or failed batch
    // must not make the scanner look offline (it is resent next minute).
    try {
      if (sizes.records !== state.recordCount && state.sinceLocal) {
        await zk.disableDevice();
        let atts;
        try { atts = await zk.attendance(); } finally { await zk.enableDevice(); }
        // The scanner's log only grows, so the bookmark is a POSITION in it,
        // not a time: a punch is sent once whatever its clock said (this
        // scanner has punches dated 2035 and 2018). If the log was cleared
        // on the scanner, start again from go-live.
        const sent = state.sentCount;
        const fresh = (sent === null || sent === undefined || sent > atts.length)
          ? atts.filter((a) => localStamp(a.at) >= state.sinceLocal)
          : atts.slice(sent);
        for (let i = 0; i < fresh.length; i += BATCH) {
          const chunk = fresh.slice(i, i + BATCH);
          const res = await post('punches', { punches: chunk.map((a) => ({ userNo: String(a.userId), time: localStamp(a.at), verify: a.verify, state: a.state })) });
          log('INFO', `Sent ${chunk.length} punches: ${res.stored} new, ${JSON.stringify(res.counts || {})}`);
          if (res.rejected) log('WARN', `The HMS rejected ${res.rejected} punch(es) in that batch (bad user number or time)`);
        }
        state.sentCount = atts.length;
        state.recordCount = sizes.records;
        saveState(state);
      }
    } catch (e) {
      log('ERROR', `Sending punches failed (will retry): ${e.message}`);
    }

    const hb = { recordCount: sizes.records, userCount: sizes.users, relayVersion: VERSION, relayHost: os.hostname().slice(0, 64) };
    try { hb.scannerTime = localStamp(await zk.time()); } catch { /* optional */ }
    if (userList) hb.users = userList;
    const res = await post('heartbeat', hb);
    if (userList) state.usersSentAt = Date.now();
    if (res.sinceLocal) state.sinceLocal = res.sinceLocal;
    saveState(state);
    if (check) log('INFO', `Heartbeat accepted. The HMS counts punches from ${res.sinceLocal} onwards (scanner local time).`);
    return true;
  } catch (e) {
    log('ERROR', `Cycle failed: ${e.message}`);
    return false;
  } finally {
    await zk.disconnect();
  }
};

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

const main = async () => {
  const missing = ['HMIS_API_URL', 'SCANNER_KEY', 'SCANNER_SERIAL'].filter((k) => !cfg[k]);
  if (missing.length) { log('ERROR', `Missing in config.json: ${missing.join(', ')}`); process.exit(2); }
  const state = loadState();
  if (process.argv.includes('--check')) {
    let ok = await cycle(state, true);
    if (ok && (state.sentCount === null || state.sentCount === undefined)) ok = await cycle(state);  // first run: now we know go-live
    process.exit(ok ? 0 : 1);
  }
  log('INFO', `Scanner relay ${VERSION}: ${cfg.SCANNER_IP}:${cfg.SCANNER_PORT} -> ${apiUrl} (every ${cfg.POLL_SECONDS}s)`);
  for (;;) {
    const started = Date.now();
    try { await cycle(state); } catch (e) { log('ERROR', `Unexpected: ${e.message}`); }
    await sleep(Math.max(5000, Number(cfg.POLL_SECONDS) * 1000 - (Date.now() - started)));
  }
};

process.on('unhandledRejection', (e) => log('ERROR', `Unhandled: ${e && e.message}`));
main();
