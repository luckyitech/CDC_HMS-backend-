const { error } = require('./response');
const { parseAmount } = require('./money');
const { BillingError } = require('./billingLedger');
const { PERMISSIONS, hasPermission } = require('../constants/permissions');

// =====================================================================
// The HTTP edge of the billing module.
//
// Three jobs that every billing controller would otherwise repeat: turning
// money typed by a human into minor units, turning a BillingError into the
// right status code, and deciding whether this user may see prices at all.
//
// Amounts cross this boundary as DECIMAL STRINGS ('2500.50') because that is
// what a person types. Everything past here is integer cents. Converting in one
// place is what stops a decimal leaking into the ledger.
// =====================================================================

/**
 * Read a money field from a request body and return minor units.
 *
 * Returns null when absent and `required` is false. Throws BillingError with a
 * message naming the field, so the desk is told which box is wrong rather than
 * "invalid request".
 */
const readAmount = (body, field, { required = true, label } = {}) => {
  const name = label || field;
  const raw = body?.[field];

  if (raw === undefined || raw === null || raw === '') {
    if (required) throw new BillingError(`${name} is required`);
    return null;
  }

  const minor = parseAmount(raw);
  if (minor === null) {
    throw new BillingError(`${name} must be an amount like 2500 or 2500.50`);
  }
  return minor;
};

/**
 * Map an error to a response.
 *
 * A BillingError is a rule the user broke and carries its own status; anything
 * else is a bug and becomes a 500 with the detail in the server log and NOT in
 * the response. Billing errors quote amounts and patient context, so leaking an
 * unexpected one to the client would be leaking whatever the stack trace
 * happened to touch.
 */
const fail = (res, err, context) => {
  if (err instanceof BillingError) return error(res, err.message, err.statusCode);
  console.error(`${context} error:`, err);
  return error(res, 'Internal server error', 500);
};

/**
 * Wrap a controller action so a thrown BillingError becomes a clean 4xx.
 *
 * Every action is the same three lines of try/catch otherwise, and the one that
 * gets it wrong returns a 500 for a message the user could have acted on.
 */
const action = (context, handler) => async (req, res) => {
  try {
    return await handler(req, res);
  } catch (err) {
    return fail(res, err, context);
  }
};

// ---------------------------------------------------------------------
// Price visibility
//
// Clinical staff are money-blind unless granted. Enforced HERE, on the way out
// of the server, not by hiding a column in the UI: the doctor's browser can
// call the same endpoint directly, so anything the response contains is
// something they can read.
// ---------------------------------------------------------------------
const canSeePrices = (user) => hasPermission(user, PERMISSIONS.BILLING_VIEW_PRICES);

// Fields that only exist for someone allowed to see money.
const PRICED_FIELDS = ['unitPriceMinor', 'vatClass'];

/**
 * A service item as this user is allowed to see it.
 *
 * Without the permission the name, category and description still come through
 * — the doctor's charge list needs them — but nothing that reveals a price,
 * including whether one has been set.
 */
const serviceItemFor = (user, item) => {
  const plain = typeof item.toJSON === 'function' ? item.toJSON() : { ...item };
  if (canSeePrices(user)) return plain;

  PRICED_FIELDS.forEach((field) => { delete plain[field]; });
  return plain;
};

module.exports = {
  readAmount,
  fail,
  action,
  canSeePrices,
  serviceItemFor,
};
