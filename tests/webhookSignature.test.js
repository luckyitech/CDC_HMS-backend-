const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { verifySignature } = require('../utils/webhookSignature');

const SECRET = 'app-secret-123';
const body = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [] }));
const sign = (raw, secret) => `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;

describe('Meta webhook signature verification', () => {
  test('a correct signature over the raw body passes', () => {
    assert.equal(verifySignature(body, sign(body, SECRET), SECRET), true);
  });

  test('a signature made with the wrong secret fails', () => {
    assert.equal(verifySignature(body, sign(body, 'other'), SECRET), false);
  });

  test('a tampered body fails', () => {
    const good = sign(body, SECRET);
    const tampered = Buffer.concat([body, Buffer.from(' ')]);
    assert.equal(verifySignature(tampered, good, SECRET), false);
  });

  test('a missing or malformed header fails, never throws', () => {
    assert.equal(verifySignature(body, undefined, SECRET), false);
    assert.equal(verifySignature(body, 'deadbeef', SECRET), false);            // no sha256= prefix
    assert.equal(verifySignature(body, 'sha256=notHex!!', SECRET), false);
    assert.equal(verifySignature(body, 'sha256=abcd', SECRET), false);         // length mismatch
  });

  test('a missing secret or body fails closed', () => {
    assert.equal(verifySignature(body, sign(body, SECRET), ''), false);
    assert.equal(verifySignature(null, sign(body, SECRET), SECRET), false);
  });
});
