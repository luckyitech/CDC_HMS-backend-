const { DataTypes } = require('sequelize');

// =====================================================================
// Money — integer minor units, everywhere.
//
// Every amount in the billing module is a whole number of CENTS (KES 1.00 =
// 100). Nothing here is ever a float. 0.1 + 0.2 is not 0.3 in binary floating
// point, and a till that is a cent out a hundred times a day is a till nobody
// trusts.
//
// DECIMAL columns would be exact in the database, but mysql2 hands them back to
// Node as STRINGS. Every read would then need parsing, and the one place that
// forgot would concatenate instead of add — '100' + '50' = '10050', a hundred-
// fold overcharge that no test asserting "a number came back" would catch.
// Integers sum, compare, index and JSON-serialise natively, so the whole class
// of bug is designed out rather than guarded against.
//
// Minor units are converted at the EDGES ONLY: parseAmount() on the way in from
// a client, formatAmount() on the way out to a receipt. In between — models,
// ledger, reports — an amount is always an integer named `...Minor`.
// =====================================================================

// Cents per shilling. KES has no circulating subunit any more, but invoices,
// insurer remittances and VAT arithmetic are all still quoted to two places.
const MINOR_UNITS = 100;

// Basis points: 10000 bp = 100%. Rates are stored in bp so that a rate like
// 16% is the integer 1600 and never 0.16 — see the note on floats above.
const BASIS_POINTS = 10000;

// Longest whole part parseAmount will accept, keeping every intermediate
// product (amount x rate) inside Number.MAX_SAFE_INTEGER with room to spare.
const MAX_WHOLE_DIGITS = 11;

/**
 * Client input → minor units. Returns null for anything that is not a clean
 * non-negative amount with at most two decimal places, so callers can reject
 * with a message rather than silently bank a NaN.
 *
 * Deliberately string-based: Number('2500.55') * 100 is 250054.99999999997,
 * and Math.round would paper over that here while a larger amount elsewhere
 * still slipped through.
 */
const parseAmount = (input) => {
  if (input === null || input === undefined || input === '') return null;
  const raw = String(input).trim().replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return null;

  const [whole, frac = ''] = raw.split('.');
  if (whole.length > MAX_WHOLE_DIGITS) return null;

  return Number(whole) * MINOR_UNITS + Number(frac.padEnd(2, '0'));
};

/** Minor units → '2,500.00'. Display only — never feed this back into maths. */
const formatAmount = (minor) => {
  const n = Number(minor || 0);
  const negative = n < 0;
  const abs = Math.abs(n);
  const whole = Math.trunc(abs / MINOR_UNITS);
  const frac = String(abs % MINOR_UNITS).padStart(2, '0');
  return `${negative ? '-' : ''}${whole.toLocaleString('en-KE')}.${frac}`;
};

/** Minor units → 2500.5, for clients that want to do their own formatting. */
const toDecimal = (minor) => Number(minor || 0) / MINOR_UNITS;

/**
 * A money column. BIGINT so a year of turnover cannot overflow the column the
 * reports sum, with a getter that coerces to Number — mysql2 returns BIGINT as
 * a string once it grows, and a column that is sometimes a number and
 * sometimes a string is the DECIMAL trap wearing a different hat.
 */
const moneyField = (fieldName, { allowNull = false, defaultValue = 0 } = {}) => ({
  type: DataTypes.BIGINT,
  allowNull,
  defaultValue,
  get() {
    const value = this.getDataValue(fieldName);
    return value === null || value === undefined ? value : Number(value);
  },
});

/**
 * VAT and totals for one invoice line.
 *
 * `pricesIncludeVat` is snapshotted per invoice rather than read live, because
 * the answer changes the meaning of every stored unit price. Kenyan clinics
 * quote patients a VAT-inclusive price, so that is the default — but a clinic
 * that lists prices net can flip it, and invoices already issued keep the
 * basis they were raised under.
 *
 * Rounding is HALF-UP, applied PER LINE and then summed — not applied once to
 * the invoice total. Line-level is what eTIMS reports and what an auditor
 * re-adds by hand from the printed invoice; rounding at the total instead can
 * leave the printed lines failing to add up to the printed total by a cent.
 */
const lineAmounts = ({
  quantity,
  unitPriceMinor,
  discountMinor = 0,
  vatRateBp = 0,
  pricesIncludeVat = true,
}) => {
  const base = quantity * unitPriceMinor - discountMinor;
  if (base < 0) throw new RangeError('Line discount exceeds the line amount');

  if (!vatRateBp) return { netMinor: base, vatMinor: 0, grossMinor: base };

  if (pricesIncludeVat) {
    // The price already contains the tax: back it out of the gross.
    const vatMinor = Math.round((base * vatRateBp) / (BASIS_POINTS + vatRateBp));
    return { netMinor: base - vatMinor, vatMinor, grossMinor: base };
  }

  const vatMinor = Math.round((base * vatRateBp) / BASIS_POINTS);
  return { netMinor: base, vatMinor, grossMinor: base + vatMinor };
};

module.exports = {
  MINOR_UNITS,
  BASIS_POINTS,
  parseAmount,
  formatAmount,
  toDecimal,
  moneyField,
  lineAmounts,
};
