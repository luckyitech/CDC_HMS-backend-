// =====================================================================
// Two-factor sign-in: a one-time code emailed at every password login.
//
// The password alone was the whole boundary around the clinical record. This
// adds a second factor that an attacker with a leaked or guessed password does
// not have — control of the account's mailbox.
//
// This file is the POLICY and the ARITHMETIC, with no database work beyond
// reading the Setting rows: how a code is made, how it is hashed, when a
// challenge is dead, and who the feature applies to. services/loginOtp.js does
// the row work and the sending; controllers/authController.js does the HTTP.
// Split that way for the same reason utils/passwordRotation.js is — the rules
// are then testable as pure functions with no database (tests/loginOtp.test.js),
// and the parts that can only be checked against MySQL are kept small.
//
// ---------------------------------------------------------------------
// WHY THE CODE IS HASHED WITH THE CHALLENGE ID
//
// Six digits is a million possibilities, so a bare SHA-256 of the code is
// reversible by anyone with the table and a laptop — a rainbow table of a
// million entries is nothing. The hash therefore covers `${challengeId}:${code}`,
// and challengeId is 32 random bytes. That makes a stored hash useless without
// the row it belongs to, and useless across rows. It is not a substitute for
// the attempt cap below (which is what actually stops online guessing); it is
// so that a copy of this table, in a backup or a log, is not a list of codes.
//
// ---------------------------------------------------------------------
// WHAT STOPS GUESSING
//
// Three things, because the code space is small on purpose (people type it):
//   - ATTEMPTS. maxAttempts wrong answers kills the challenge, so an attacker
//     gets 5 of a million, not a million.
//   - TTL. A code is dead after ttlMinutes whatever happens.
//   - ONE LIVE CHALLENGE PER ACCOUNT. Issuing supersedes the previous one, so
//     an attacker cannot farm a thousand live codes and look for a collision.
// =====================================================================

const crypto = require('crypto');
const db = require('../models');
const { INTERNAL_ROLES } = require('../constants/permissions');

const { Setting } = db;

const ENABLED_KEY      = 'twoFactorEnabled';
const TTL_KEY          = 'twoFactorTtlMinutes';
const MAX_ATTEMPTS_KEY = 'twoFactorMaxAttempts';

// Who is asked for a code. Staff only — INTERNAL_ROLES, which is the same list
// every other internal gate uses rather than a second copy that can drift.
//
// PATIENTS ARE DELIBERATELY OUT OF SCOPE, for now. Their portal is a different
// trust boundary (it reaches one person's own record, not the clinic's), many
// patient accounts share a family email or have none at all — User.email is
// nullable — and locking a diabetic out of their own glucose history at 6am
// because an SMTP relay is down is a different kind of harm from making a
// clerk wait for a code. If patients are brought in later, the only change
// needed here is this list.
const TWO_FACTOR_ROLES = INTERNAL_ROLES;

const DEFAULTS = {
  // Default OFF, and this is deliberate rather than timid.
  //
  // The switch is what makes this deployable to a live clinic in one step: the
  // code ships dark, an administrator turns it on from System Settings (or
  // scripts/two-factor.js) once one real sign-in has been seen to work, and if
  // the mail path turns out to be broken at 8am on a Monday it goes off again
  // in five seconds without a redeploy. A default of ON would mean the deploy
  // itself is the test, with the whole clinic as the control group.
  enabled: false,
  // Long enough to find the mail on a phone, short enough that a code left on
  // a screen is not a credential by lunchtime.
  ttlMinutes: 10,
  // 5 wrong codes and the challenge is dead. Generous for fat fingers on a
  // 6-digit field, nowhere near enough to search 1,000,000.
  maxAttempts: 5,
};

const CODE_LENGTH = 6;
const TTL_BOUNDS = { min: 2, max: 30 };
const ATTEMPT_BOUNDS = { min: 3, max: 10 };

// ---------------------------------------------------------------------
// The code and its hash
// ---------------------------------------------------------------------

// crypto.randomInt, not Math.random: this is a credential. Zero-padded so every
// code is exactly six characters — '004321' is a valid code and must not be
// shown, or compared, as '4321'.
const generateCode = () => String(crypto.randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0');

/** The stored form of a code. See the note at the top on why the id is in it. */
const hashCode = (challengeId, code) =>
  crypto.createHash('sha256').update(`${challengeId}:${code}`).digest('hex');

/** A new challenge id: unique platform-wide, and the salt for the hash above. */
const generateChallengeId = () => crypto.randomBytes(32).toString('base64url');

/**
 * Does this submitted code match the stored hash?
 *
 * timingSafeEqual over the two hex digests. The digests are the same length by
 * construction, so this is only about not leaking how MUCH of a wrong code was
 * right through how long the comparison took.
 */
const codeMatches = (challengeId, submitted, storedHash) => {
  const candidate = hashCode(challengeId, String(submitted || ''));
  const a = Buffer.from(candidate, 'hex');
  const b = Buffer.from(String(storedHash || ''), 'hex');
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
};

/** A 6-digit string, and nothing else. Whitespace is forgiven — people paste. */
const looksLikeCode = (value) => /^\d{6}$/.test(String(value ?? '').trim());

// ---------------------------------------------------------------------
// When is a challenge usable?
// ---------------------------------------------------------------------

const isExpired = (challenge, now = new Date()) =>
  !challenge || new Date(challenge.expiresAt).getTime() <= now.getTime();

const isConsumed = (challenge) => !!challenge?.consumedAt;

const attemptsExhausted = (challenge, maxAttempts) =>
  !challenge || (challenge.attempts ?? 0) >= maxAttempts;

/**
 * 'ok' when the challenge may be tried, otherwise WHY not.
 *
 * One function rather than three checks at the call site, so the verify route
 * and any later caller cannot disagree about what "still usable" means.
 * Returns: 'ok' | 'not-found' | 'consumed' | 'expired' | 'attempts-exhausted'
 */
const challengeState = (challenge, { maxAttempts, now = new Date() } = {}) => {
  if (!challenge) return 'not-found';
  if (isConsumed(challenge)) return 'consumed';
  if (isExpired(challenge, now)) return 'expired';
  if (attemptsExhausted(challenge, maxAttempts ?? DEFAULTS.maxAttempts)) return 'attempts-exhausted';
  return 'ok';
};

/** When a challenge issued now should die. */
const expiryFrom = (now, ttlMinutes) => new Date(now.getTime() + ttlMinutes * 60 * 1000);

// ---------------------------------------------------------------------
// Who does this apply to?
// ---------------------------------------------------------------------

/**
 * Should this account be asked for a code?
 *
 * An account with no email address cannot be sent one. It is NOT quietly let
 * through on a password alone — see services/loginOtp.js, which refuses the
 * sign-in and says why. Returning false here would be the dangerous reading:
 * "no email on file" would become a way to opt out of two-factor, and the
 * accounts without an email are exactly the stale ones worth protecting.
 */
const appliesTo = (user, config = DEFAULTS) => {
  if (!config.enabled) return false;
  if (!user) return false;
  return TWO_FACTOR_ROLES.includes(user.role);
};

// Why an account cannot be sent a code. Named rather than left as loose
// strings because these cross three boundaries — this file, the HTTP response,
// and the admin screen's wording — and a mistyped literal fails silently: the
// account simply stops appearing in the readiness report.
const UNDELIVERABLE = Object.freeze({
  NO_EMAIL: 'no-email',
  RESERVED_DOMAIN: 'reserved-domain',
});

// What each reason MEANS for the person, which is not the same thing for the
// two of them and matters to an administrator deciding whether to switch the
// policy on:
//
//   NO_EMAIL         they cannot sign in today either — POST /auth/login finds
//                    the account BY the email address it was given, so an
//                    account with none has never been reachable through the
//                    login form, and cannot use "Forgot password?" either.
//                    Two-factor takes nothing away from them; the row is worth
//                    showing because it is a dead account somebody should look
//                    at, not because this feature breaks it.
//
//   RESERVED_DOMAIN  they CAN sign in today and will NOT be able to afterwards.
//                    This is the real lockout, and the only one the
//                    confirmation dialog needs to be emphatic about.
const UNDELIVERABLE_IMPACT = Object.freeze({
  [UNDELIVERABLE.NO_EMAIL]: 'cannot-sign-in-today-either',
  [UNDELIVERABLE.RESERVED_DOMAIN]: 'new-lockout',
});

/** Does this account have something that is at least shaped like an address? */
const hasDeliverableEmail = (user) => /\S+@\S+\.\S+/.test(String(user?.email || '').trim());

// Domains that provably cannot receive mail: the names RFC 2606 and RFC 6761
// reserve for documentation and testing. An address at one of these is a
// placeholder somebody typed to get past a required field.
//
// WHY THIS IS HERE AT ALL. On this system the administrator accounts were set
// up on addresses like 'admin@westlands.example.com' — scripts/set-password.js
// exists precisely because "the admin has no real mailbox, so the
// forgot-password flow has nothing to send to". Switching two-factor on
// without noticing that locks those accounts out of their own clinic, and the
// account that can switch it back off is one of them. A NULL-email check alone
// would have sailed straight past it, because the field is filled in — with a
// fiction.
//
// ONE LIST, TWO CONSUMERS. The readiness report has to find these accounts in
// the database, and a WHERE clause cannot run a JavaScript regex — so the list
// is kept as DATA and both the regex and the SQL LIKE patterns are derived
// from it below. Written as a literal regex plus a hand-kept list of LIKE
// strings, the two would answer differently the first time somebody added a
// domain to one of them, and the one that silently stopped matching would be
// the database side: the settings page would report "everybody can receive a
// code" and the lockout would land at sign-in.
//
// This catches the provable cases only. It CANNOT tell that a real registered
// domain is not the clinic's mail domain, so the readiness report also breaks
// the accounts down by domain: a human recognising "our mail is
// @cdiabetescentre.com, why is the admin on @cdc.com?" is the check that
// actually works.
const RESERVED_DOMAINS = [
  'example.com', 'example.net', 'example.org',   // RFC 2606 §3
  'test', 'example', 'invalid', 'localhost',     // RFC 2606 §2 reserved TLDs
  'local',                                       // RFC 6762 multicast DNS
];

// Matches the domain itself or any subdomain of it, so 'westlands.example.com'
// and 'anything.test' are both caught.
const RESERVED_DOMAIN_RE = new RegExp(
  `(^|\\.)(${RESERVED_DOMAINS.map((d) => d.replace(/\./g, '\\.')).join('|')})$`,
  'i',
);

/**
 * The same rule as RESERVED_DOMAIN_RE, as SQL LIKE patterns for an email
 * column. Two per domain: the address AT it, and at any subdomain of it.
 *
 * Derived rather than written out, so there is one list to maintain. Used by
 * services/loginOtp.js readiness() to find these accounts without reading
 * every staff row into Node.
 */
const reservedDomainLikePatterns = () =>
  RESERVED_DOMAINS.flatMap((d) => [`%@${d}`, `%.${d}`]);

/** True when the address is at a domain that cannot receive mail, by definition. */
const isReservedDomain = (email) => {
  const value = String(email || '').trim();
  const at = value.lastIndexOf('@');
  if (at < 1) return false;
  return RESERVED_DOMAIN_RE.test(value.slice(at + 1));
};

/**
 * Why a code could not reach this account, or null when it looks fine.
 * One of UNDELIVERABLE.NO_EMAIL / UNDELIVERABLE.RESERVED_DOMAIN, or null.
 */
const undeliverableReason = (user) => {
  if (!hasDeliverableEmail(user)) return UNDELIVERABLE.NO_EMAIL;
  if (isReservedDomain(user.email)) return UNDELIVERABLE.RESERVED_DOMAIN;
  return null;
};

/** The domain part of an address, lowercased — for the admin-facing breakdown. */
const domainOf = (email) => {
  const value = String(email || '').trim().toLowerCase();
  const at = value.lastIndexOf('@');
  return at < 1 ? '(no email)' : value.slice(at);
};

/**
 * 'a••••@gmail.com' — enough for someone to recognise their own mailbox,
 * not enough to hand an attacker an address they did not already have. Shown
 * on the code screen because "we sent a code" is useless if you cannot tell
 * WHERE, and staff here have more than one address.
 */
const maskEmail = (email) => {
  const value = String(email || '').trim();
  const at = value.lastIndexOf('@');
  if (at < 1) return '';
  const local = value.slice(0, at);
  const domain = value.slice(at);
  if (local.length <= 2) return `${local[0]}${'•'.repeat(3)}${domain}`;
  return `${local[0]}${'•'.repeat(Math.min(local.length - 2, 6))}${local[local.length - 1]}${domain}`;
};

// ---------------------------------------------------------------------
// Configuration, from the Setting table
//
// Same shape as utils/passwordRotation.js getRotationConfig: a short TTL cache,
// because this is read on the login path, plus clearTwoFactorCache for the
// write path and for tests.
// ---------------------------------------------------------------------

const CACHE_TTL_MS = 30_000;
let cached = { config: null, at: 0 };

const clampInt = (value, fallback, { min, max }) => {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
};

const getTwoFactorConfig = async () => {
  if (cached.config && Date.now() - cached.at < CACHE_TTL_MS) return cached.config;

  let config;
  try {
    const rows = await Setting.findAll({ where: { key: [ENABLED_KEY, TTL_KEY, MAX_ATTEMPTS_KEY] } });
    const byKey = new Map(rows.map((r) => [r.key, r.value]));
    config = {
      enabled:     byKey.get(ENABLED_KEY) === 'true',
      ttlMinutes:  clampInt(byKey.get(TTL_KEY), DEFAULTS.ttlMinutes, TTL_BOUNDS),
      maxAttempts: clampInt(byKey.get(MAX_ATTEMPTS_KEY), DEFAULTS.maxAttempts, ATTEMPT_BOUNDS),
    };
  } catch {
    // Settings unreadable (a DB blip). Fail OPEN — password-only — exactly as
    // utils/passwordRotation.js does, and for the same reason: the alternative
    // is that a hiccup in one table locks every clinician out of a live clinic.
    // The password is still checked, so this degrades the second factor rather
    // than removing authentication. Stated here so the choice is deliberate and
    // can be argued with, not discovered.
    config = { ...DEFAULTS };
  }

  cached = { config, at: Date.now() };
  return config;
};

/** Drops the cached config. For the settings write path and for tests. */
const clearTwoFactorCache = () => { cached = { config: null, at: 0 }; };

/** Write the admin's choices, then return the config as it now reads. */
const setTwoFactorConfig = async ({ enabled, ttlMinutes, maxAttempts } = {}) => {
  const write = async (key, value) => {
    const [row, created] = await Setting.findOrCreate({ where: { key }, defaults: { key, value } });
    if (!created && row.value !== value) await row.update({ value });
  };

  if (enabled !== undefined)     await write(ENABLED_KEY, enabled ? 'true' : 'false');
  if (ttlMinutes !== undefined)  await write(TTL_KEY, String(clampInt(ttlMinutes, DEFAULTS.ttlMinutes, TTL_BOUNDS)));
  if (maxAttempts !== undefined) await write(MAX_ATTEMPTS_KEY, String(clampInt(maxAttempts, DEFAULTS.maxAttempts, ATTEMPT_BOUNDS)));

  clearTwoFactorCache();
  return getTwoFactorConfig();
};

module.exports = {
  ENABLED_KEY, TTL_KEY, MAX_ATTEMPTS_KEY,
  DEFAULTS, CODE_LENGTH, TTL_BOUNDS, ATTEMPT_BOUNDS, TWO_FACTOR_ROLES,
  generateCode, generateChallengeId, hashCode, codeMatches, looksLikeCode,
  isExpired, isConsumed, attemptsExhausted, challengeState, expiryFrom,
  appliesTo, hasDeliverableEmail, isReservedDomain, undeliverableReason, domainOf, maskEmail,
  UNDELIVERABLE, UNDELIVERABLE_IMPACT, RESERVED_DOMAINS, reservedDomainLikePatterns,
  getTwoFactorConfig, setTwoFactorConfig, clearTwoFactorCache,
};
