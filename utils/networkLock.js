// =====================================================================
// The network lock (16 Oct 2026, Emu): when it is on, only people with
// remote access (it.remote.signin) — and the main admin account — may sign in
// or keep working from outside the clinic's networks. Pure: the caller passes
// the config and the address.
//
// Checked twice:
//   - at sign-in (controllers/authController.js login / deviceSession): the
//     attempt is refused with 423 and recorded as failReason 'outside_blocked';
//   - on every request (middleware/auth.js authenticate): a session that leaves
//     the clinic network (a laptop taken home, a phone dropping to mobile data)
//     stops working — 401 code OUTSIDE_CLINIC, the browser signs out and the
//     sign-in page says why.
//
// Never locked: patients (their portal is meant for home), the main admin
// account (no one can lock the clinic out of its own system), and — only if
// the clinic chooses — remembered phones at the entrance tag.
// =====================================================================

const { matchNetwork } = require('./ip');
const { canWorkOutsideClinic } = require('../constants/permissions');

const LOCK_MESSAGE = 'Signing in from outside the clinic is not open to your account. '
  + 'Connect to the clinic network, or ask an administrator for remote access.';

/** Is this person ever held by the lock? */
const isExempt = (user, { viaDevice = false, cfg } = {}) => {
  if (!user) return false;
  if (user.role === 'patient') return true;
  if (canWorkOutsideClinic(user)) return true;          // explicit grant, or the main admin account
  if (viaDevice && cfg?.lockTapExempt) return true;
  return false;
};

/**
 * Should this sign-in / request be refused?
 * @returns {boolean}
 */
const blockedByLock = ({ user, ip, cfg, viaDevice = false }) => {
  if (!cfg?.lockOutside) return false;
  if (!cfg.networks?.length) return false;              // never lock with no clinic network
  if (isExempt(user, { viaDevice, cfg })) return false;
  return !matchNetwork(ip, cfg.networks);
};

module.exports = { blockedByLock, isExempt, LOCK_MESSAGE };
