const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeName, nameKey, normalizePhone, levenshtein, similarity, THRESHOLDS,
} = require('../utils/patientMatch');

// Pure matching helpers (no DB). findMatches itself is DB-backed and is
// exercised against a scratch DB, not here — these lock down the scoring
// primitives that decide whether the WARN fires.

describe('name normalisation', () => {
  test('strips case, diacritics and punctuation', () => {
    assert.equal(normalizeName('  Zoë-Marie  '), 'zoe marie');
    assert.equal(normalizeName("O'Brien"), 'o brien');
    assert.equal(normalizeName('José'), 'jose');
  });

  test('nameKey is token-sorted so first/last order does not matter', () => {
    assert.equal(nameKey('Jane', 'Doe'), nameKey('Doe', 'Jane'));
    assert.equal(nameKey('Jane Amina', 'Doe'), 'amina doe jane');
  });
});

describe('phone normalisation (Kenyan shapes → last 9 digits)', () => {
  test('all common forms collapse equal', () => {
    assert.equal(normalizePhone('0712345678'), '712345678');
    assert.equal(normalizePhone('+254712345678'), '712345678');
    assert.equal(normalizePhone('254 712 345 678'), '712345678');
    assert.equal(normalizePhone('0712-345-678'), '712345678');
  });
});

describe('levenshtein + similarity', () => {
  test('identical strings score 1', () => {
    assert.equal(similarity('mohamed', 'mohamed'), 1);
  });
  test('empty vs empty is 1; empty vs non-empty is 0', () => {
    assert.equal(similarity('', ''), 1);
    assert.equal(similarity('', 'x'), 0);
  });
  test('single-edit distance', () => {
    assert.equal(levenshtein('mohamed', 'mohammed'), 1);
  });
});

describe('the clinic scenario: a misspelled file must score above PROBABLE', () => {
  const key = nameKey;
  const above = (a, b) => similarity(a, b) >= THRESHOLDS.PROBABLE;

  test('Mohammed vs Mohamed', () => {
    assert.ok(above(key('Mohammed', 'Ali'), key('Mohamed', 'Ali')));
  });
  test('Wanjiru vs Wanjiku', () => {
    assert.ok(above(key('Grace', 'Wanjiru'), key('Grace', 'Wanjiku')));
  });
  test('transposed first/last is a certain match', () => {
    assert.ok(similarity(key('Jane', 'Doe'), key('Doe', 'Jane')) >= THRESHOLDS.CERTAIN);
  });
  test('two unrelated people stay well below PROBABLE', () => {
    assert.ok(similarity(key('John', 'Smith'), key('Mary', 'Okoth')) < THRESHOLDS.PROBABLE);
  });
});
