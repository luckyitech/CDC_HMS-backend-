const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { normalisePhone, toWaId, display } = require('../utils/phone');

// Pure phone helpers (no DB). findPatientsByPhone is exercised in the DB
// harness (tests/_comms) since it queries patients.

describe('phone normalisation', () => {
  test('normalisePhone reduces every Kenyan shape to the last 9 digits', () => {
    assert.equal(normalisePhone('0712345678'), '712345678');
    assert.equal(normalisePhone('+254 712 345 678'), '712345678');
    assert.equal(normalisePhone('254712345678'), '712345678');
    assert.equal(normalisePhone('0712-345-678'), '712345678');
    assert.equal(normalisePhone('712345678'), '712345678');
  });

  test('normalisePhone rejects anything shorter than 9 digits', () => {
    assert.equal(normalisePhone('12345'), null);
    assert.equal(normalisePhone(''), null);
    assert.equal(normalisePhone(null), null);
    assert.equal(normalisePhone(undefined), null);
  });

  test('toWaId prefixes the Kenyan country code', () => {
    assert.equal(toWaId('0712345678'), '254712345678');
    assert.equal(toWaId('+254 712 345 678'), '254712345678');
    assert.equal(toWaId('nonsense'), null);
  });

  test('display renders a readable local number', () => {
    assert.equal(display('254712345678'), '0712 345 678');
    assert.equal(display('0712345678'), '0712 345 678');
  });
});
