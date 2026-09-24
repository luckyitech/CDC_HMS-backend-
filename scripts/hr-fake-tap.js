#!/usr/bin/env node
// HR Suite (B21) — print the URL an NTAG 424 DNA tag WOULD open, for a tag
// you registered in HR Suite → Settings, without owning the chip yet.
//
//   node scripts/hr-fake-tap.js <uid 14 hex> <key 32 hex> <counter> [base]
//
// Each counter is single-use (the server refuses a replay), so bump it for
// every tap. Default base is the local Vite dev server.
const { computeSunMac } = require('../utils/ntag424');

const [uid, key, ctrArg, base = 'http://localhost:5173'] = process.argv.slice(2);
if (!uid || !key || !ctrArg) {
  console.error('usage: node scripts/hr-fake-tap.js <uid 14 hex> <key 32 hex> <counter> [base url]');
  process.exit(1);
}
if (!/^[0-9A-Fa-f]{14}$/.test(uid)) { console.error(`The UID must be 14 hex characters (got "${uid}").`); process.exit(1); }
if (!/^[0-9A-Fa-f]{32}$/.test(key)) {
  console.error(`The key must be the 32-hex tag key shown once when you pressed Generate in HR Suite → Settings (got "${key}").`);
  console.error('If it was not copied, retire that tag and register a new one.');
  process.exit(1);
}
const counter = parseInt(ctrArg, 10);
if (!Number.isInteger(counter) || counter < 1 || counter > 0xFFFFFF) { console.error('The counter must be a whole number from 1 upward.'); process.exit(1); }
const ctrHex = counter.toString(16).toUpperCase().padStart(6, '0');
const cmac = computeSunMac({ keyHex: key.toUpperCase(), uidHex: uid.toUpperCase(), counter });
console.log(`${base.replace(/\/$/, '')}/hr/tap?uid=${uid.toUpperCase()}&ctr=${ctrHex}&cmac=${cmac}`);
