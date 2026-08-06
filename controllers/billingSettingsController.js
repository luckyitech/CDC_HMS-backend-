const { success, error } = require('../utils/response');
const { action } = require('../utils/billingHttp');
const { getBillingConfig, setBillingConfig } = require('../utils/billingConfig');
const {
  VAT_CLASSES, PAYMENT_METHODS, SERVICE_CATEGORIES, CURRENCY,
} = require('../constants/billing');

// =====================================================================
// Clinic billing configuration, and the vocabulary the frontend renders from.
//
// Kept in the billing module rather than bolted onto the general settings
// controller so the whole feature stays one removable unit — and so the VAT
// rate and the KRA PIN sit behind the billing permission rather than the
// general settings one.
// =====================================================================

/**
 * GET /api/billing/config
 *
 * The clinic's settings PLUS the option lists, so the frontend never hardcodes
 * a payment method or a VAT class. Adding one to constants/billing.js makes it
 * appear in the UI with no frontend change — the same reason the backend keeps
 * them in a lookup table.
 */
const get = action('Billing.config.get', async (req, res) => {
  const config = await getBillingConfig();

  return success(res, {
    ...config,
    currency: CURRENCY,
    options: {
      vatClasses: Object.entries(VAT_CLASSES).map(([value, spec]) => ({
        value, label: spec.label, etimsCode: spec.etimsCode,
      })),
      // The reference rules travel with each method so the payment form knows
      // which box to show and which to require, without repeating the rules.
      paymentMethods: Object.entries(PAYMENT_METHODS).map(([value, spec]) => ({
        value,
        label: spec.label,
        reference: spec.reference,
        referenceLabel: spec.referenceLabel || null,
        capturesCardLast4: !!spec.capturesCardLast4,
        capturesInsurer: !!spec.capturesInsurer,
      })),
      serviceCategories: Object.entries(SERVICE_CATEGORIES).map(([value, spec]) => ({
        value, label: spec.label,
      })),
    },
  });
});

/**
 * PUT /api/billing/config — admin only (see routes/billing.js).
 *
 * Nothing is written unless every supplied value validates, so a bad KRA PIN
 * cannot leave the VAT rate half-applied.
 */
const update = action('Billing.config.update', async (req, res) => {
  const { errors, config } = await setBillingConfig(req.body);
  if (errors) return error(res, errors.join(', '), 400);
  return success(res, config);
});

module.exports = { get, update };
