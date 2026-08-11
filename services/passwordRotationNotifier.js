/**
 * Tells affected staff that scheduled password rotation has been switched on.
 *
 * Runs when an administrator enables the policy from System Settings. Everyone
 * subject to rotation is emailed, not only those already overdue: someone whose
 * password is fine today still needs to know the rule exists and when theirs
 * lapses, otherwise the first they hear of it is being locked out mid-shift.
 *
 * Deliberately fire-and-forget. The admin's request must not wait on an SMTP
 * round trip per member of staff, and a mail server having a bad afternoon must
 * never stop the policy being enabled — the policy is enforced by the login
 * gate, not by these emails.
 */

const db = require('../models');
const { sendPasswordRotationNoticeEmail } = require('../utils/emailService');
const { formatUserName } = require('../utils/formatters');
const {
  ROTATING_ROLES,
  INTERVALS,
  DEFAULT_INTERVAL,
  isPasswordExpired,
  passwordExpiresAt,
} = require('../utils/passwordRotation');

const { User } = db;

/**
 * Emails every active doctor / staff / lab account about the policy.
 *
 * @param {string} interval  'weekly' | 'fortnightly' | 'monthly'
 * @returns {Promise<{ sent: number, failed: number, dueNow: number }>}
 *          Resolved for logging and tests; callers in the request path ignore it.
 */
const notifyStaffOfRotationPolicy = async (interval = DEFAULT_INTERVAL) => {
  const spec = INTERVALS[interval] || INTERVALS[DEFAULT_INTERVAL];

  const users = await User.findAll({
    where: { role: ROTATING_ROLES, isActive: true },
    attributes: ['id', 'email', 'firstName', 'lastName', 'role', 'passwordChangedAt'],
  });

  let sent = 0;
  let failed = 0;
  let dueNow = 0;

  // Sequential rather than Promise.all: a clinic-sized blast through one SMTP
  // connection is far likelier to be throttled or greylisted if it arrives all
  // at once, and nothing is waiting on the result.
  for (const user of users) {
    if (!user.email) continue;

    const mustChangeNow = isPasswordExpired(user, interval);
    if (mustChangeNow) dueNow += 1;

    const expiry = passwordExpiresAt(user, interval);

    try {
      await sendPasswordRotationNoticeEmail({
        to: user.email,
        name: formatUserName(user),
        role: user.role,
        policyLabel: spec.label,
        duration: spec.duration,
        mustChangeNow,
        // Handed over as a Date. Presentation belongs to emailService, which
        // formats every date in every email the same way.
        expiresOn: expiry,
      });
      sent += 1;
    } catch (err) {
      // sendEmail already swallows its own failures; this is belt and braces so
      // one bad address cannot abandon the rest of the list.
      failed += 1;
      console.warn(`[RotationNotifier] ${user.email}:`, err.message);
    }
  }

  console.log(
    `[RotationNotifier] policy '${interval}' — notified ${sent}, failed ${failed}, ${dueNow} already due`
  );
  return { sent, failed, dueNow };
};

module.exports = { notifyStaffOfRotationPolicy };
