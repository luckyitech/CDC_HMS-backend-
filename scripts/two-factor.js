/**
 * Two-factor sign-in — read or change the policy from the server.
 *
 *   node scripts/two-factor.js status
 *   node scripts/two-factor.js on
 *   node scripts/two-factor.js off
 *   node scripts/two-factor.js on --ttl 10 --attempts 5
 *
 * THIS IS THE BREAK-GLASS TOOL, and it is the reason the feature can be
 * switched on with a straight face.
 *
 * The same policy can be changed from System Settings → Security, but that is a
 * screen you have to sign in to reach — and the one emergency that matters here
 * is "nobody can sign in". If the mail relay dies at 8am on a Monday, or an
 * administrator's own mailbox is unreachable, the way back in must not require
 * the very thing that is broken. Whoever has server access runs:
 *
 *   node scripts/two-factor.js off
 *
 * and the clinic is back on password-only sign-in within seconds, with no
 * redeploy and no database surgery.
 *
 * `status` also lists in-scope accounts with NO email address, because those
 * are precisely the people who cannot receive a code — check it before
 * switching the policy on, not after the phone starts ringing.
 */

require('dotenv').config();
const db = require('../models');
const {
  TWO_FACTOR_ROLES, TTL_BOUNDS, ATTEMPT_BOUNDS, UNDELIVERABLE,
  getTwoFactorConfig, setTwoFactorConfig, clearTwoFactorCache,
} = require('../utils/loginOtp');
const { readiness } = require('../services/loginOtp');

// Same wording the Security settings panel uses, so the terminal and the
// screen describe the same account the same way.
const REASON_TEXT = {
  [UNDELIVERABLE.NO_EMAIL]: 'no email address',
  [UNDELIVERABLE.RESERVED_DOMAIN]: 'address at a domain that cannot receive mail',
};

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};

const intArg = (name, bounds) => {
  const raw = arg(name);
  if (raw === undefined) return undefined;
  const n = parseInt(raw, 10);
  if (!Number.isInteger(n) || n < bounds.min || n > bounds.max) {
    console.error(`--${name} must be a whole number between ${bounds.min} and ${bounds.max}`);
    process.exit(1);
  }
  return n;
};

const report = async () => {
  clearTwoFactorCache();
  const config = await getTwoFactorConfig();
  // The same readiness check the settings page runs — see services/loginOtp.js.
  const { accountsInScope, unreachable, emailDomains } = await readiness();

  console.log('');
  console.log(`  Two-factor sign-in : ${config.enabled ? 'ON' : 'OFF'}`);
  console.log(`  Code lifetime      : ${config.ttlMinutes} minutes`);
  console.log(`  Allowed attempts   : ${config.maxAttempts}`);
  console.log(`  Applies to         : ${TWO_FACTOR_ROLES.join(', ')} (${accountsInScope} active accounts)`);

  if (unreachable.length) {
    console.log('');
    console.log(`  ⚠  ${unreachable.length} in-scope account(s) CANNOT receive a code:`);
    for (const a of unreachable) {
      console.log(`       #${a.id}  ${a.name} (${a.role})  ${a.email || '—'}  — ${REASON_TEXT[a.reason] || a.reason}`);
    }
    console.log('       Fix these before switching the policy on, or they are locked out.');
  }

  // Printed every time, because the automatic check can only catch provable
  // placeholders. It cannot know which real domain is actually the clinic's
  // mailbox — but whoever runs this does, and a single admin sitting on a
  // domain nobody else uses is the shape of the problem worth seeing.
  console.log('');
  console.log('  Email domains in scope (check every one of these can actually receive mail):');
  for (const { domain, count } of emailDomains) {
    console.log(`       ${String(count).padStart(3)}  ${domain}`);
  }
  console.log('');
};

(async () => {
  const command = (process.argv[2] || 'status').toLowerCase();

  if (!['status', 'on', 'off'].includes(command)) {
    console.error('Usage: node scripts/two-factor.js status|on|off [--ttl <minutes>] [--attempts <n>]');
    process.exit(1);
  }

  if (command === 'status') {
    await report();
    await db.sequelize.close();
    return;
  }

  const ttlMinutes = intArg('ttl', TTL_BOUNDS);
  const maxAttempts = intArg('attempts', ATTEMPT_BOUNDS);

  const before = await getTwoFactorConfig();
  await setTwoFactorConfig({ enabled: command === 'on', ttlMinutes, maxAttempts });

  console.log(`\n  Two-factor sign-in: ${before.enabled ? 'ON' : 'OFF'} → ${command === 'on' ? 'ON' : 'OFF'}`);
  // The running API caches the config for 30 seconds (utils/loginOtp.js), so a
  // change made here is live within half a minute without a restart. Said out
  // loud because somebody will otherwise restart the server to "make it apply".
  console.log('  The running API picks this up within 30 seconds — no restart needed.');
  await report();
  await db.sequelize.close();
})().catch(async (err) => {
  console.error('two-factor:', err.message);
  try { await db.sequelize.close(); } catch { /* already closed */ }
  process.exit(1);
});
