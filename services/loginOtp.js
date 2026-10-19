// =====================================================================
// Two-factor sign-in — the row work and the sending.
//
// utils/loginOtp.js holds the rules; this file applies them to the database and
// the mail relay. controllers/authController.js calls only this, and only
// through the three verbs below.
//
// EVERY OUTCOME IS A TAGGED RESULT, NEVER A THROWN STRING. The controller has
// to turn each one into a different HTTP answer — some refuse, some are safe to
// explain, one is a 500 — and a function that threw for "wrong code" would put
// that decision in a catch block where the next person cannot see the full set.
// The `outcome` values are the whole contract:
//
//   issue:   'sent' | 'no-email' | 'reserved-domain' | 'send-failed'
//   verify:  'ok' | 'not-found' | 'expired' | 'consumed' | 'attempts-exhausted'
//            | 'bad-code' | 'account-unusable'
//   resend:  'sent' | 'not-found' | 'expired' | 'consumed' | 'resend-limit'
//            | 'send-failed'
// =====================================================================

const { Op, fn, col, literal } = require('sequelize');
const db = require('../models');
const { sendLoginOtpEmail } = require('../utils/emailService');
const otp = require('../utils/loginOtp');

const { LoginOtp, User } = db;

// How many fresh codes one sign-in attempt may ask for before starting again.
// Resend sends mail, so an uncapped one turns the clinic's own relay into a way
// to flood somebody's inbox; three is enough for a code that genuinely did not
// arrive, and the person can always start the sign-in over.
const MAX_RESENDS = 3;

// Challenges this old are rubbish whatever their state: an hour is far longer
// than any TTL the admin can set (30 minutes, see TTL_BOUNDS), so nothing live
// is ever caught by the sweep.
const SWEEP_AFTER_MS = 60 * 60 * 1000;

// How often this process bothers to sweep. The sweep used to run on EVERY
// sign-in, which is a DELETE per login that matches nothing almost every time
// — harmless at this clinic's volume and exactly the sort of per-request write
// that becomes a problem quietly. Once every ten minutes per process is ample
// for rows that are already dead and only occupy space.
const SWEEP_EVERY_MS = 10 * 60 * 1000;
let lastSweptAt = 0;

// How long to wait for the mail relay before giving up on a code.
//
// The send is awaited — the whole point is that the user is not told "check
// your email" when nothing was sent — so the login request lasts as long as
// the SMTP round trip. Unbounded, a relay that accepts the connection and then
// stops talking holds the request, and the express worker behind it, until the
// socket eventually dies. 15 seconds is far longer than a healthy send and
// short enough that a hung relay degrades into a clear 503 instead of a
// hanging login page.
//
// A send that times out may still arrive later. That is why the challenge row
// is destroyed on failure: the user is told it did not work, so the code they
// may yet receive must not be usable. They retry and get a fresh one.
const SEND_TIMEOUT_MS = 15_000;

const withTimeout = (promise, ms, label) => {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]);
};

/** Send a code, bounded. Throws on failure or timeout — never silently. */
const deliverCode = (to, name, code, expiresMinutes) => withTimeout(
  sendLoginOtpEmail({ to, name, code, expiresMinutes }),
  SEND_TIMEOUT_MS,
  'sending the sign-in code',
);

/**
 * Clears out an account's dead challenges, and supersedes any live one.
 *
 * Called before issuing, which is what makes "one live challenge per account"
 * true — see utils/loginOtp.js on why that matters. Deleting rather than
 * marking consumed: this table is a queue, and a superseded challenge has no
 * audit value (UserLoginLogs is the record of who got in).
 *
 * Fire-and-forget on failure is NOT acceptable here — if the old row survives,
 * two codes are live at once — so it is awaited and allowed to throw.
 */
const supersedePrevious = async (userId) => {
  // TWO STATEMENTS, NOT ONE `OR`. They were one query with
  // `[Op.or]: [{ UserId }, { expiresAt: { [Op.lt]: cutoff } }]`, which reads
  // more neatly and runs worse: an OR across two different indexed columns
  // leaves MySQL choosing between an index merge and a full scan, and on the
  // sign-in path a table scan is exactly what must not grow with the number of
  // sign-ins the clinic has ever done. Split, each statement uses its own
  // index (login_otps_user, login_otps_expires_at).
  //
  // The supersede is awaited and allowed to throw: if the old row survives,
  // two codes are live at once. The sweep is not — it is housekeeping, and a
  // failed tidy-up must never stop somebody signing in.
  await LoginOtp.destroy({ where: { UserId: userId } });

  if (Date.now() - lastSweptAt < SWEEP_EVERY_MS) return;
  lastSweptAt = Date.now();
  LoginOtp.destroy({
    where: { expiresAt: { [Op.lt]: new Date(Date.now() - SWEEP_AFTER_MS) } },
  }).catch((err) => console.warn('[LoginOtp] sweep failed:', err.message));
};

/**
 * Issue a challenge and email the code.
 *
 * Called ONLY after the password has been checked. That ordering is the whole
 * point: an attacker with a wrong password never causes an email, so this
 * cannot be used to spam somebody or to probe which addresses have accounts.
 *
 * @param {object} user          the authenticated User instance
 * @param {object} opts
 * @param {string} [opts.ip]
 * @param {boolean} [opts.rememberDevice]  carried through to the verify step
 * @param {string} [opts.context]          'hr-tap' from the entrance page
 * @returns {Promise<{outcome: string, challengeId?: string, maskedEmail?: string,
 *                    expiresAt?: Date, expiresMinutes?: number, error?: Error}>}
 */
const issueChallenge = async (user, { ip = null, rememberDevice = false, context = null } = {}) => {
  // An in-scope account that cannot be sent a code is NOT let through on its
  // password alone — see appliesTo in utils/loginOtp.js on why that would turn
  // a missing email into a way to opt out of two-factor. 'reserved-domain' is
  // reported separately from 'no-email' because the fix is different: one
  // account needs an address, the other has a fictional one that needs
  // replacing, and an administrator told "no email on file" about an account
  // showing admin@somewhere.example.com will go looking in the wrong place.
  const undeliverable = otp.undeliverableReason(user);
  if (undeliverable) return { outcome: undeliverable };

  const config = await otp.getTwoFactorConfig();
  const challengeId = otp.generateChallengeId();
  const code = otp.generateCode();
  const now = new Date();
  const expiresAt = otp.expiryFrom(now, config.ttlMinutes);

  await supersedePrevious(user.id);

  const challenge = await LoginOtp.create({
    UserId: user.id,
    challengeId,
    codeHash: otp.hashCode(challengeId, code),
    expiresAt,
    sentTo: user.email,
    lastIp: ip,
    rememberDevice: !!rememberDevice,
    context,
  });

  try {
    await deliverCode(user.email, `${user.firstName} ${user.lastName}`, code, config.ttlMinutes);
  } catch (err) {
    // The code never left the building, so the row must not stay behind: left
    // in place it would be a live challenge nobody can answer, and it would
    // supersede the next attempt's own code.
    await challenge.destroy().catch(() => {});
    return { outcome: 'send-failed', error: err };
  }

  return {
    outcome: 'sent',
    challengeId,
    maskedEmail: otp.maskEmail(user.email),
    expiresAt,
    expiresMinutes: config.ttlMinutes,
  };
};

/** The live challenge for an id, or null. */
const findChallenge = (challengeId) =>
  LoginOtp.findOne({ where: { challengeId: String(challengeId || '') } });

/**
 * Check a submitted code.
 *
 * On success the challenge is consumed and the User is returned, so the caller
 * never has to look the account up from client-supplied data — the row is the
 * only thing that says who this sign-in is for.
 *
 * A WRONG CODE COSTS AN ATTEMPT, AND THE INCREMENT HAPPENS FIRST. Written that
 * way round deliberately: if the count were only saved after deciding what to
 * return, an attacker who cut the connection mid-request would get unlimited
 * free guesses.
 */
const verifyChallenge = async (challengeId, submittedCode, { ip = null } = {}) => {
  const config = await otp.getTwoFactorConfig();
  const challenge = await findChallenge(challengeId);

  const state = otp.challengeState(challenge, { maxAttempts: config.maxAttempts });
  if (state !== 'ok') return { outcome: state === 'not-found' ? 'not-found' : state };

  if (!otp.codeMatches(challenge.challengeId, submittedCode, challenge.codeHash)) {
    await challenge.increment('attempts');
    await challenge.reload();
    const left = Math.max(config.maxAttempts - challenge.attempts, 0);
    // Out of attempts is already fatal — challengeState() refuses any row whose
    // attempts have reached the cap, so nothing more is needed to kill it.
    //
    // consumedAt is deliberately NOT set here. It used to be, as a way of
    // saying "this row is finished", and it made the next request report
    // 'consumed' — so a challenge burned by five wrong guesses told the user
    // their code had "already been used", which says somebody else got in with
    // it. That is a different and much more alarming thing than "you typed it
    // wrong five times". consumedAt now means exactly one thing: a code that
    // was accepted.
    return { outcome: left === 0 ? 'attempts-exhausted' : 'bad-code', attemptsLeft: left };
  }

  // Re-read the account at the moment the code is accepted, not the moment it
  // was sent. A sign-in deactivated while the code was in flight must not
  // complete — the same reasoning middleware/auth.js uses for reading role and
  // isActive from the row on every request instead of trusting the token.
  const user = await User.findByPk(challenge.UserId);
  if (!user || !user.isActive) return { outcome: 'account-unusable' };

  await challenge.update({ consumedAt: new Date(), lastIp: ip ?? challenge.lastIp });

  return {
    outcome: 'ok',
    user,
    rememberDevice: challenge.rememberDevice,
    context: challenge.context,
  };
};

/**
 * Send a fresh code for a sign-in already in progress.
 *
 * A new code, not the old one again: the stored hash is one-way, so the old
 * code cannot be recovered to re-send it — and re-sending it would be worse
 * anyway, since the first email may be sitting in someone else's inbox.
 *
 * The challenge id and the attempt count are KEPT, so resending is not a way
 * to reset a nearly-exhausted challenge and keep guessing.
 */
const resendChallenge = async (challengeId, { ip = null } = {}) => {
  const config = await otp.getTwoFactorConfig();
  const challenge = await findChallenge(challengeId);

  const state = otp.challengeState(challenge, { maxAttempts: config.maxAttempts });
  if (state !== 'ok') return { outcome: state === 'not-found' ? 'not-found' : state };
  if (challenge.resendCount >= MAX_RESENDS) return { outcome: 'resend-limit' };

  const user = await User.findByPk(challenge.UserId);
  if (!user || !user.isActive) return { outcome: 'not-found' };

  const code = otp.generateCode();
  const now = new Date();
  const expiresAt = otp.expiryFrom(now, config.ttlMinutes);

  await challenge.update({
    codeHash: otp.hashCode(challenge.challengeId, code),
    expiresAt,
    resendCount: challenge.resendCount + 1,
    lastIp: ip ?? challenge.lastIp,
  });

  try {
    await deliverCode(challenge.sentTo, `${user.firstName} ${user.lastName}`, code, config.ttlMinutes);
  } catch (err) {
    return { outcome: 'send-failed', error: err };
  }

  return {
    outcome: 'sent',
    challengeId: challenge.challengeId,
    maskedEmail: otp.maskEmail(challenge.sentTo),
    expiresAt,
    expiresMinutes: config.ttlMinutes,
    // resendCount has already been incremented above, so this is simply the
    // remainder — and clamped, because a negative "sends left" is nonsense to
    // show a user and the cap is enforced by resendCount, not by this number.
    resendsLeft: Math.max(MAX_RESENDS - challenge.resendCount, 0),
  };
};


// =====================================================================
// READINESS — who could not receive a code if this were switched on?
//
// ONE implementation, two callers: the System Settings → Security panel
// (controllers/settingsController.js) and scripts/two-factor.js. It was
// written twice, once in each, and that is the shape of bug worth avoiding
// here rather than anywhere else: the two copies would drift, and the one an
// administrator happens to read would say everybody is fine while the other
// knew better. A lockout is not something to discover from whichever screen
// you opened.
//
// COUNTED IN SQL, NOT IN NODE. The first version read every in-scope staff row
// into memory and reduced over it to get a count and a domain breakdown. That
// is fine for fourteen accounts and wrong as a habit: it grows with the staff
// list on a page an administrator reloads, and it transfers every address to
// get a GROUP BY that MySQL can do in place. So the count and the breakdown
// are aggregates, and the only rows fetched are the ones that are actually a
// problem — of which there should be none.
// =====================================================================

/** Active accounts the policy applies to. */
const inScopeWhere = { role: otp.TWO_FACTOR_ROLES, isActive: true };

/**
 * @returns {Promise<{accountsInScope: number,
 *                    unreachable: Array<{id,name,role,email,reason}>,
 *                    emailDomains: Array<{domain,count}>}>}
 */
const readiness = async () => {
  const [accountsInScope, domainRows, candidates] = await Promise.all([
    User.count({ where: inScopeWhere }),

    // GROUP BY on the domain part, done in the database. SUBSTRING_INDEX is
    // MySQL's own; this file is MySQL-only already (the whole project is).
    User.findAll({
      where: inScopeWhere,
      attributes: [
        [fn('LOWER', fn('SUBSTRING_INDEX', col('email'), literal("'@', -1")), ), 'domain'],
        [fn('COUNT', col('id')), 'count'],
      ],
      group: [literal("LOWER(SUBSTRING_INDEX(email, '@', -1))")],
      order: [[literal('count'), 'DESC']],
      raw: true,
    }),

    // Only the accounts that might be a problem: no address at all, or one at
    // a domain that cannot receive mail. The LIKE patterns come from the same
    // list as the regex (utils/loginOtp.js), so the database and the
    // application cannot disagree about what counts as undeliverable.
    User.findAll({
      where: {
        ...inScopeWhere,
        [Op.or]: [
          { email: null },
          { email: '' },
          ...otp.reservedDomainLikePatterns().map((pattern) => ({ email: { [Op.like]: pattern } })),
        ],
      },
      attributes: ['id', 'firstName', 'lastName', 'role', 'email'],
      order: [['role', 'ASC'], ['firstName', 'ASC']],
    }),
  ]);

  // The SQL above is a filter, not the authority. undeliverableReason() is,
  // and it runs over the handful of rows the filter returned — so the reason
  // shown to an administrator is produced by exactly the same function that
  // will refuse the sign-in.
  const unreachable = candidates
    .map((u) => ({ u, reason: otp.undeliverableReason(u) }))
    .filter(({ reason }) => reason)
    .map(({ u, reason }) => ({
      id: u.id,
      name: `${u.firstName} ${u.lastName}`,
      role: u.role,
      email: u.email || null,
      reason,
      // 'new-lockout' | 'cannot-sign-in-today-either' — see
      // UNDELIVERABLE_IMPACT in utils/loginOtp.js. The admin screen leads with
      // the new lockouts, because those are the ones this switch causes.
      impact: otp.UNDELIVERABLE_IMPACT[reason],
    }));

  return {
    accountsInScope,
    unreachable,
    // How many of those this switch would actually break, as opposed to
    // accounts that were already unreachable. The dialog counts these.
    newLockouts: unreachable.filter((a) => a.impact === 'new-lockout').length,
    emailDomains: domainRows.map((r) => ({
      domain: r.domain ? `@${r.domain}` : '(no email)',
      count: Number(r.count),
    })),
  };
};

module.exports = {
  MAX_RESENDS,
  readiness,
  issueChallenge,
  verifyChallenge,
  resendChallenge,
};
