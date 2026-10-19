const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  CODE_LENGTH, TTL_BOUNDS, ATTEMPT_BOUNDS, TWO_FACTOR_ROLES, DEFAULTS,
  generateCode, generateChallengeId, hashCode, codeMatches, looksLikeCode,
  isExpired, isConsumed, attemptsExhausted, challengeState, expiryFrom,
  appliesTo, hasDeliverableEmail, isReservedDomain, undeliverableReason,
  domainOf, maskEmail,
  UNDELIVERABLE, UNDELIVERABLE_IMPACT, RESERVED_DOMAINS, reservedDomainLikePatterns,
} = require('../utils/loginOtp');

// =====================================================================
// Two-factor sign-in — the rules, with no database.
//
// Pure functions only, like tests/passwordRotation.test.js: what a code looks
// like, how it is hashed, when a challenge is dead, and who the policy applies
// to. The row work and the mail are in services/loginOtp.js and are exercised
// against a real database by the smoke script, not here.
//
// The cases that matter are the ones where getting it wrong is silent: a code
// that compares equal when it should not, a challenge that survives its own
// expiry, and an account that escapes the policy because a field is empty.
// =====================================================================

const future = (mins = 10) => new Date(Date.now() + mins * 60_000);
const past = (mins = 10) => new Date(Date.now() - mins * 60_000);
const challenge = (over = {}) => ({
  challengeId: 'c'.repeat(43), expiresAt: future(), attempts: 0, consumedAt: null, ...over,
});

describe('the code itself', () => {
  test('always exactly six digits', () => {
    for (let i = 0; i < 500; i += 1) {
      const code = generateCode();
      assert.equal(code.length, CODE_LENGTH);
      assert.match(code, /^\d{6}$/);
    }
  });

  test('low numbers keep their leading zeros', () => {
    // The bug this guards: String(4321).padStart(6,'0') is '004321', but
    // dropping the pad makes it '4321' — a 4-character code that will never
    // match the 6 characters the user was emailed.
    assert.equal(looksLikeCode('004321'), true);
    assert.equal(looksLikeCode('4321'), false);
  });

  test('only a bare six-digit string is a code', () => {
    assert.equal(looksLikeCode('123456'), true);
    assert.equal(looksLikeCode(' 123456 '), true);     // people paste
    assert.equal(looksLikeCode('12345'), false);
    assert.equal(looksLikeCode('1234567'), false);
    assert.equal(looksLikeCode('12345a'), false);
    assert.equal(looksLikeCode('123 456'), false);
    assert.equal(looksLikeCode(''), false);
    assert.equal(looksLikeCode(undefined), false);
    assert.equal(looksLikeCode(null), false);
  });

  test('codes are not obviously predictable', () => {
    // Not a randomness proof — just that it is not a constant or a counter,
    // which is what a careless rewrite would produce.
    const seen = new Set(Array.from({ length: 200 }, generateCode));
    assert.ok(seen.size > 150, `only ${seen.size} distinct codes in 200 draws`);
  });

  test('challenge ids are long, unique and URL-safe', () => {
    const ids = Array.from({ length: 100 }, generateChallengeId);
    assert.equal(new Set(ids).size, 100);
    for (const id of ids) {
      assert.ok(id.length >= 42, `id too short: ${id}`);
      assert.match(id, /^[A-Za-z0-9_-]+$/);   // base64url: safe in a JSON body and a URL
    }
  });
});

describe('hashing', () => {
  test('the stored hash is a hex SHA-256', () => {
    assert.match(hashCode('abc', '123456'), /^[0-9a-f]{64}$/);
  });

  test('the same code under a different challenge hashes differently', () => {
    // This is the whole reason the challenge id is in the hash: without it, a
    // table of a million precomputed digests reverses every row in the system.
    assert.notEqual(hashCode('challenge-one', '123456'), hashCode('challenge-two', '123456'));
  });

  test('a code matches its own hash and nothing else', () => {
    const id = generateChallengeId();
    const stored = hashCode(id, '123456');
    assert.equal(codeMatches(id, '123456', stored), true);
    assert.equal(codeMatches(id, '123457', stored), false);
    assert.equal(codeMatches(id, '12345', stored), false);
  });

  test('a code does not match under a different challenge id', () => {
    const stored = hashCode(generateChallengeId(), '123456');
    assert.equal(codeMatches(generateChallengeId(), '123456', stored), false);
  });

  test('empty and malformed stored hashes never match', () => {
    const id = generateChallengeId();
    // timingSafeEqual throws on a length mismatch, so these must be refused
    // before it is reached — a 500 on the verify route would be a denial of
    // service on a row an attacker can influence.
    assert.equal(codeMatches(id, '123456', ''), false);
    assert.equal(codeMatches(id, '123456', null), false);
    assert.equal(codeMatches(id, '123456', 'not-hex'), false);
    assert.equal(codeMatches(id, '123456', 'ab'), false);
    assert.equal(codeMatches(id, '', hashCode(id, '123456')), false);
  });
});

describe('when a challenge is dead', () => {
  test('expiry is exclusive at the boundary', () => {
    const now = new Date('2026-10-19T09:00:00Z');
    assert.equal(isExpired({ expiresAt: new Date('2026-10-19T09:00:01Z') }, now), false);
    // Exactly now counts as expired: a code whose lifetime has run out to the
    // second is out of time, and "<=" is the reading that cannot be argued with.
    assert.equal(isExpired({ expiresAt: now }, now), true);
    assert.equal(isExpired({ expiresAt: new Date('2026-10-19T08:59:59Z') }, now), true);
  });

  test('a missing challenge is treated as expired, not as usable', () => {
    assert.equal(isExpired(null), true);
    assert.equal(attemptsExhausted(null, 5), true);
  });

  test('consumed is single-use, not a counter', () => {
    assert.equal(isConsumed(challenge()), false);
    assert.equal(isConsumed(challenge({ consumedAt: new Date() })), true);
  });

  test('attempts are exhausted at the cap, not past it', () => {
    assert.equal(attemptsExhausted(challenge({ attempts: 4 }), 5), false);
    assert.equal(attemptsExhausted(challenge({ attempts: 5 }), 5), true);
    assert.equal(attemptsExhausted(challenge({ attempts: 9 }), 5), true);
  });

  test('challengeState names exactly why', () => {
    const maxAttempts = 5;
    assert.equal(challengeState(challenge(), { maxAttempts }), 'ok');
    assert.equal(challengeState(null, { maxAttempts }), 'not-found');
    assert.equal(challengeState(challenge({ consumedAt: new Date() }), { maxAttempts }), 'consumed');
    assert.equal(challengeState(challenge({ expiresAt: past() }), { maxAttempts }), 'expired');
    assert.equal(challengeState(challenge({ attempts: 5 }), { maxAttempts }), 'attempts-exhausted');
  });

  test('a consumed AND expired challenge reports consumed first', () => {
    // Order matters for the message the user sees: "already used" tells them
    // somebody got in, which is worth knowing. "expired" would hide that.
    const dead = challenge({ consumedAt: new Date(), expiresAt: past() });
    assert.equal(challengeState(dead, { maxAttempts: 5 }), 'consumed');
  });

  test('expiry is ttlMinutes from the given instant', () => {
    const now = new Date('2026-10-19T09:00:00Z');
    assert.equal(expiryFrom(now, 10).toISOString(), '2026-10-19T09:10:00.000Z');
    assert.equal(expiryFrom(now, 2).toISOString(), '2026-10-19T09:02:00.000Z');
  });
});

describe('who the policy applies to', () => {
  const on = { ...DEFAULTS, enabled: true };

  test('nobody at all while it is switched off', () => {
    for (const role of TWO_FACTOR_ROLES) {
      assert.equal(appliesTo({ role, email: 'a@b.com' }, { ...DEFAULTS, enabled: false }), false);
    }
  });

  test('every internal role is in scope', () => {
    assert.deepEqual([...TWO_FACTOR_ROLES].sort(), ['admin', 'doctor', 'lab', 'nurse', 'staff']);
    for (const role of TWO_FACTOR_ROLES) {
      assert.equal(appliesTo({ role, email: 'a@b.com' }, on), true, `${role} should be in scope`);
    }
  });

  test('patients are out of scope', () => {
    assert.equal(appliesTo({ role: 'patient', email: 'a@b.com' }, on), false);
  });

  test('a missing email does NOT exempt an account', () => {
    // The dangerous reading, written down as a test: if appliesTo returned
    // false for an account with no address, then clearing the email field
    // would be a way to switch two-factor off for that account — and the
    // accounts with no address are the stale ones most worth protecting.
    // In scope, undeliverable, and refused at sign-in. Never waved through.
    assert.equal(appliesTo({ role: 'doctor', email: null }, on), true);
    assert.equal(undeliverableReason({ role: 'doctor', email: null }), 'no-email');
  });

  test('no user at all is never in scope', () => {
    assert.equal(appliesTo(null, on), false);
    assert.equal(appliesTo(undefined, on), false);
  });
});

describe('deliverability', () => {
  test('an address has to look like one', () => {
    assert.equal(hasDeliverableEmail({ email: 'asha@cdiabetescentre.com' }), true);
    assert.equal(hasDeliverableEmail({ email: 'not-an-address' }), false);
    assert.equal(hasDeliverableEmail({ email: 'missing@domain' }), false);
    assert.equal(hasDeliverableEmail({ email: '' }), false);
    assert.equal(hasDeliverableEmail({}), false);
  });

  test('RFC-reserved domains are refused', () => {
    // These are the real shapes found on this system's own accounts.
    assert.equal(isReservedDomain('asha@westlands.example.com'), true);
    assert.equal(isReservedDomain('a@example.com'), true);
    assert.equal(isReservedDomain('a@example.org'), true);
    assert.equal(isReservedDomain('a@anything.test'), true);
    assert.equal(isReservedDomain('a@host.invalid'), true);
    assert.equal(isReservedDomain('a@localhost'), true);
    assert.equal(isReservedDomain('a@server.local'), true);
  });

  test('real domains are left alone, including ones that merely look odd', () => {
    // cdc.com is a REAL registered domain. This check cannot tell that it is
    // not the clinic's mailbox — only a human reading the domain breakdown can.
    // Asserted so nobody later "fixes" this by blocklisting it here.
    assert.equal(isReservedDomain('admin@cdc.com'), false);
    assert.equal(isReservedDomain('a@cdiabetescentre.com'), false);
    assert.equal(isReservedDomain('a@gmail.com'), false);
    assert.equal(isReservedDomain('a@exampleclinic.com'), false);
    assert.equal(isReservedDomain('a@testing.co.ke'), false);
  });

  test('undeliverableReason separates the two different fixes', () => {
    assert.equal(undeliverableReason({ email: 'a@cdiabetescentre.com' }), null);
    assert.equal(undeliverableReason({ email: null }), 'no-email');
    assert.equal(undeliverableReason({ email: 'a@westlands.example.com' }), 'reserved-domain');
  });

  test('domainOf groups accounts for the admin breakdown', () => {
    assert.equal(domainOf('Asha@CDiabetesCentre.com'), '@cdiabetescentre.com');
    assert.equal(domainOf(null), '(no email)');
    assert.equal(domainOf('broken'), '(no email)');
  });
});

describe('masking the address on the code screen', () => {
  test('shows enough to recognise, not enough to learn', () => {
    assert.equal(maskEmail('ligovilucky@gmail.com'), 'l••••••y@gmail.com');
    assert.equal(maskEmail('asha@cdiabetescentre.com'), 'a••a@cdiabetescentre.com');
  });

  test('very short local parts are not spelled out', () => {
    assert.equal(maskEmail('ab@cdc.com'), 'a•••@cdc.com');
    assert.equal(maskEmail('a@cdc.com'), 'a•••@cdc.com');
  });

  test('the mask never leaks the whole local part', () => {
    for (const address of ['abc@x.com', 'abcd@x.com', 'averylonglocalpart@x.com']) {
      const masked = maskEmail(address);
      const local = address.slice(0, address.indexOf('@'));
      if (local.length > 2) assert.ok(!masked.includes(local), `${masked} leaks ${local}`);
      assert.ok(masked.includes('@'), masked);
    }
  });

  test('nonsense in, empty string out — never a crash', () => {
    assert.equal(maskEmail(''), '');
    assert.equal(maskEmail(null), '');
    assert.equal(maskEmail('no-at-sign'), '');
    assert.equal(maskEmail('@leading'), '');
  });
});

describe('configuration bounds', () => {
  test('the defaults sit inside the bounds the admin is held to', () => {
    assert.ok(DEFAULTS.ttlMinutes >= TTL_BOUNDS.min && DEFAULTS.ttlMinutes <= TTL_BOUNDS.max);
    assert.ok(DEFAULTS.maxAttempts >= ATTEMPT_BOUNDS.min && DEFAULTS.maxAttempts <= ATTEMPT_BOUNDS.max);
  });

  test('the feature ships OFF', () => {
    // Deliberate: the switch is what makes this deployable to a live clinic.
    // See the note on DEFAULTS in utils/loginOtp.js. If this assertion is ever
    // changed, the deploy becomes the test.
    assert.equal(DEFAULTS.enabled, false);
  });

  test('an attempt cap can never be loosened past the bound', () => {
    assert.ok(ATTEMPT_BOUNDS.max <= 10, 'more than 10 guesses at a 6-digit code is too many');
    assert.ok(TTL_BOUNDS.max <= 30, 'a code living longer than 30 minutes is a stored credential');
  });
});

describe('the reserved-domain list is one source for two consumers', () => {
  // services/loginOtp.js readiness() finds these accounts with SQL LIKE
  // patterns, because a WHERE clause cannot run the regex. These tests exist
  // to catch the two drifting apart — which would fail silently and in the
  // worst direction: the settings page would report everybody reachable while
  // the login route refused them.
  test('every listed domain is matched by the regex', () => {
    for (const domain of RESERVED_DOMAINS) {
      assert.equal(isReservedDomain(`someone@${domain}`), true, `@${domain} not matched`);
      assert.equal(isReservedDomain(`someone@sub.${domain}`), true, `@sub.${domain} not matched`);
    }
  });

  test('every listed domain has both LIKE patterns', () => {
    const patterns = reservedDomainLikePatterns();
    for (const domain of RESERVED_DOMAINS) {
      assert.ok(patterns.includes(`%@${domain}`), `missing %@${domain}`);
      assert.ok(patterns.includes(`%.${domain}`), `missing %.${domain}`);
    }
    assert.equal(patterns.length, RESERVED_DOMAINS.length * 2);
  });

  test('the LIKE patterns and the regex agree on real addresses', () => {
    // A local stand-in for MySQL LIKE, so the two rules can be compared
    // without a database: % matches anything, everything else is literal.
    const likeMatches = (value, pattern) => {
      const re = new RegExp(`^${pattern.split('%').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
      return re.test(value);
    };
    const patterns = reservedDomainLikePatterns();
    const sqlWouldFlag = (email) => patterns.some((p) => likeMatches(email, p));

    const cases = [
      'asha@westlands.example.com', 'a@example.com', 'a@example.net', 'a@example.org',
      'a@thing.test', 'a@host.invalid', 'a@box.local', 'a@deep.sub.example.com',
      'admin@cdc.com', 'a@cdiabetescentre.com', 'a@gmail.com', 'a@exampleclinic.com',
      'a@testing.co.ke', 'a@localhost.com',
    ];
    for (const email of cases) {
      assert.equal(
        sqlWouldFlag(email), isReservedDomain(email),
        `SQL and regex disagree about ${email}: SQL=${sqlWouldFlag(email)} regex=${isReservedDomain(email)}`,
      );
    }
  });
});

describe('the two undeliverable reasons are not equivalent', () => {
  test('both reasons have a documented impact', () => {
    for (const reason of Object.values(UNDELIVERABLE)) {
      assert.ok(UNDELIVERABLE_IMPACT[reason], `${reason} has no impact`);
    }
  });

  test('a reserved domain is a NEW lockout; no email was never able to sign in', () => {
    // The distinction the admin screen leads with. An account with no address
    // cannot reach POST /auth/login at all (the lookup is BY email), so
    // switching two-factor on takes nothing from it.
    assert.equal(UNDELIVERABLE_IMPACT[UNDELIVERABLE.RESERVED_DOMAIN], 'new-lockout');
    assert.equal(UNDELIVERABLE_IMPACT[UNDELIVERABLE.NO_EMAIL], 'cannot-sign-in-today-either');
  });

  test('undeliverableReason returns the named constants, not loose strings', () => {
    assert.equal(undeliverableReason({ email: null }), UNDELIVERABLE.NO_EMAIL);
    assert.equal(undeliverableReason({ email: 'a@example.com' }), UNDELIVERABLE.RESERVED_DOMAIN);
  });
});
