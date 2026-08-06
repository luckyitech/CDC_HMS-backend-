const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { parseAmount, formatAmount, toDecimal, lineAmounts } = require('../utils/money');
const {
  vatRateBpFor, etimsCodeFor, uniqueReferenceFor, signFor,
  DEFAULT_STANDARD_VAT_BP,
} = require('../constants/billing');

// =====================================================================
// Money arithmetic — the layer everything else in billing sits on.
//
// Pure functions, no database. What is asserted here is the stuff that is
// silently wrong rather than loudly broken: a cent lost to floating point, VAT
// rounded at the total instead of per line, an amount that parses when it
// should have been refused.
//
//   npm test
// =====================================================================

const KES = (shillings) => shillings * 100;

describe('parseAmount — client input to minor units', () => {
  test('whole and decimal amounts', () => {
    assert.equal(parseAmount('2500'), 250000);
    assert.equal(parseAmount('2500.5'), 250050);
    assert.equal(parseAmount('2500.50'), 250050);
    assert.equal(parseAmount('0'), 0);
    assert.equal(parseAmount('0.05'), 5);
  });

  test('thousands separators are tolerated — reception types what it sees', () => {
    assert.equal(parseAmount('2,500.50'), 250050);
    assert.equal(parseAmount('1,234,567'), 123456700);
  });

  test('numbers as well as strings', () => {
    assert.equal(parseAmount(2500), 250000);
    assert.equal(parseAmount(2500.5), 250050);
  });

  test('does NOT go through float multiplication', () => {
    // 2500.55 * 100 is 250054.99999999997 in binary floating point. A cent
    // lost here is a cent lost on every till reconciliation for the rest of
    // the clinic's life, so the parser is string-based and this proves it.
    assert.equal(parseAmount('2500.55'), 250055);
    assert.equal(parseAmount('1.15'), 115);
    assert.equal(parseAmount('8.29'), 829);
  });

  test('rejects anything that is not a clean non-negative amount', () => {
    // Three decimal places is a typo, not a price — rounding it silently would
    // bill an amount nobody typed.
    assert.equal(parseAmount('12.345'), null);
    assert.equal(parseAmount('-5'), null);
    assert.equal(parseAmount('1e5'), null);
    assert.equal(parseAmount('abc'), null);
    assert.equal(parseAmount('12.'), null);
    assert.equal(parseAmount('.50'), null);
    assert.equal(parseAmount(''), null);
    assert.equal(parseAmount(null), null);
    assert.equal(parseAmount(undefined), null);
  });

  test('rejects amounts large enough to threaten integer precision', () => {
    assert.equal(parseAmount('999999999999'), null); // 12 digits
    assert.notEqual(parseAmount('99999999999'), null); // 11 is still fine
  });
});

describe('formatAmount — minor units to a printed line', () => {
  test('always two decimal places', () => {
    assert.equal(formatAmount(250050), '2,500.50');
    assert.equal(formatAmount(250000), '2,500.00');
    assert.equal(formatAmount(0), '0.00');
    assert.equal(formatAmount(5), '0.05');
    assert.equal(formatAmount(50), '0.50');
  });

  test('negative amounts keep their sign — reversals show on the cash-up', () => {
    assert.equal(formatAmount(-250050), '-2,500.50');
  });

  test('round-trips with parseAmount', () => {
    ['0.00', '0.07', '1.15', '999.99', '2,500.50', '1,234,567.89'].forEach((printed) => {
      assert.equal(formatAmount(parseAmount(printed)), printed);
    });
  });
});

describe('toDecimal', () => {
  test('hands clients a plain number', () => {
    assert.equal(toDecimal(250050), 2500.5);
    assert.equal(toDecimal(0), 0);
  });
});

describe('lineAmounts — no VAT', () => {
  test('an exempt line is just quantity x price', () => {
    assert.deepEqual(
      lineAmounts({ quantity: 1, unitPriceMinor: KES(2000), vatRateBp: 0 }),
      { netMinor: KES(2000), vatMinor: 0, grossMinor: KES(2000) }
    );
  });

  test('quantity multiplies', () => {
    const line = lineAmounts({ quantity: 3, unitPriceMinor: KES(150), vatRateBp: 0 });
    assert.equal(line.grossMinor, KES(450));
  });

  test('discount comes off the line', () => {
    const line = lineAmounts({
      quantity: 2, unitPriceMinor: KES(1000), discountMinor: KES(500), vatRateBp: 0,
    });
    assert.equal(line.grossMinor, KES(1500));
  });

  test('a discount larger than the line is refused, not banked as negative', () => {
    assert.throws(
      () => lineAmounts({ quantity: 1, unitPriceMinor: KES(100), discountMinor: KES(200) }),
      RangeError
    );
  });
});

describe('lineAmounts — VAT-inclusive prices (the Kenyan default)', () => {
  test('tax is backed out of the quoted price', () => {
    // KES 116.00 inclusive of 16% is KES 100.00 + KES 16.00.
    const line = lineAmounts({
      quantity: 1, unitPriceMinor: KES(116), vatRateBp: 1600, pricesIncludeVat: true,
    });
    assert.deepEqual(line, { netMinor: KES(100), vatMinor: KES(16), grossMinor: KES(116) });
  });

  test('the patient pays exactly the quoted price', () => {
    const line = lineAmounts({
      quantity: 1, unitPriceMinor: KES(2000), vatRateBp: 1600, pricesIncludeVat: true,
    });
    assert.equal(line.grossMinor, KES(2000));
    assert.equal(line.netMinor + line.vatMinor, line.grossMinor);
  });

  test('rounds half-up to the cent', () => {
    // 100 cents inclusive of 16% → 100 * 1600 / 11600 = 13.79…
    const line = lineAmounts({
      quantity: 1, unitPriceMinor: 100, vatRateBp: 1600, pricesIncludeVat: true,
    });
    assert.equal(line.vatMinor, 14);
    assert.equal(line.netMinor, 86);
  });
});

describe('lineAmounts — VAT-exclusive prices', () => {
  test('tax is added on top', () => {
    const line = lineAmounts({
      quantity: 1, unitPriceMinor: KES(100), vatRateBp: 1600, pricesIncludeVat: false,
    });
    assert.deepEqual(line, { netMinor: KES(100), vatMinor: KES(16), grossMinor: KES(116) });
  });

  test('rounds half-up to the cent', () => {
    // 99 cents at 16% → 15.84 → 16
    const line = lineAmounts({
      quantity: 1, unitPriceMinor: 99, vatRateBp: 1600, pricesIncludeVat: false,
    });
    assert.equal(line.vatMinor, 16);
    assert.equal(line.grossMinor, 115);
  });
});

describe('VAT is computed per line, then summed', () => {
  // Three lines of KES 1.00 inclusive of 16%: each rounds to 14 cents of VAT,
  // so the invoice shows 42. Rounding the 300-cent total in one go gives 41.
  // The printed lines must add up to the printed total — an auditor re-adding
  // the invoice by hand is the check this is protecting against.
  test('per-line rounding is what the invoice must show', () => {
    const lines = [1, 2, 3].map(() =>
      lineAmounts({ quantity: 1, unitPriceMinor: 100, vatRateBp: 1600, pricesIncludeVat: true })
    );

    const vatTotal = lines.reduce((sum, l) => sum + l.vatMinor, 0);
    const netTotal = lines.reduce((sum, l) => sum + l.netMinor, 0);
    const grossTotal = lines.reduce((sum, l) => sum + l.grossMinor, 0);

    assert.equal(vatTotal, 42);
    assert.equal(netTotal + vatTotal, grossTotal);

    const roundedAtTheTotal = Math.round((300 * 1600) / 11600);
    assert.equal(roundedAtTheTotal, 41);
    assert.notEqual(vatTotal, roundedAtTheTotal);
  });

  test('net plus VAT always equals gross, whatever the rate', () => {
    [0, 800, 1600, 2000].forEach((rate) => {
      [1, 7, 99, 100, 12345, 250000].forEach((price) => {
        [true, false].forEach((inclusive) => {
          const l = lineAmounts({
            quantity: 3, unitPriceMinor: price, vatRateBp: rate, pricesIncludeVat: inclusive,
          });
          assert.equal(l.netMinor + l.vatMinor, l.grossMinor);
          assert.ok(Number.isInteger(l.vatMinor));
          assert.ok(l.vatMinor >= 0);
        });
      });
    });
  });
});

describe('VAT classes', () => {
  test('only standard-rated services attract the clinic rate', () => {
    assert.equal(vatRateBpFor('standard', DEFAULT_STANDARD_VAT_BP), 1600);
    assert.equal(vatRateBpFor('exempt', DEFAULT_STANDARD_VAT_BP), 0);
    assert.equal(vatRateBpFor('zero', DEFAULT_STANDARD_VAT_BP), 0);
  });

  test('an unknown class charges nothing rather than guessing', () => {
    assert.equal(vatRateBpFor('nonsense', DEFAULT_STANDARD_VAT_BP), 0);
  });

  test('exempt and zero-rated are distinct to KRA even though both charge 0', () => {
    assert.equal(etimsCodeFor('exempt'), 'A');
    assert.equal(etimsCodeFor('standard'), 'B');
    assert.equal(etimsCodeFor('zero'), 'C');
    assert.notEqual(etimsCodeFor('exempt'), etimsCodeFor('zero'));
  });
});

describe('payment reference uniqueness', () => {
  test('M-Pesa codes are guarded, and case/whitespace cannot smuggle a duplicate', () => {
    assert.equal(uniqueReferenceFor('mpesa', 'SGH4X2K9PQ'), 'mpesa:SGH4X2K9PQ');
    assert.equal(uniqueReferenceFor('mpesa', ' sgh4x2k9pq '), 'mpesa:SGH4X2K9PQ');
  });

  test('card auth codes are NOT guarded — they legitimately repeat', () => {
    assert.equal(uniqueReferenceFor('card', '123456'), null);
  });

  test('insurance and cash never claim a unique reference', () => {
    assert.equal(uniqueReferenceFor('insurance', 'CLM-001'), null);
    assert.equal(uniqueReferenceFor('cash', null), null);
  });

  test('methods cannot collide with each other', () => {
    assert.notEqual(uniqueReferenceFor('mpesa', 'ABC123'), uniqueReferenceFor('bank', 'ABC123'));
  });

  test('a missing reference is unguarded, not the string "null"', () => {
    assert.equal(uniqueReferenceFor('mpesa', ''), null);
    assert.equal(uniqueReferenceFor('mpesa', null), null);
  });
});

describe('payment direction', () => {
  test('amount is positive; the type carries the sign', () => {
    assert.equal(signFor('payment'), 1);
    assert.equal(signFor('refund'), -1);
    assert.equal(signFor('reversal'), -1);
  });

  test('an unknown type contributes nothing to a balance', () => {
    assert.equal(signFor('nonsense'), 0);
  });
});
