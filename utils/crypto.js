const crypto = require('crypto');

const ALGORITHM = 'aes-256-cbc';
const KEY       = Buffer.from(process.env.CARELINK_ENCRYPTION_KEY, 'hex');
const IV_LENGTH = 16;

const encrypt = (plainText) => {
  if (!plainText) return null;
  const iv         = crypto.randomBytes(IV_LENGTH);
  const cipher     = crypto.createCipheriv(ALGORITHM, KEY, iv);
  const encrypted  = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
};

const decrypt = (cipherText) => {
  if (!cipherText) return null;
  const [ivHex, encryptedHex] = cipherText.split(':');
  const iv        = Buffer.from(ivHex, 'hex');
  const encrypted = Buffer.from(encryptedHex, 'hex');
  const decipher  = crypto.createDecipheriv(ALGORITHM, KEY, iv);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
};

module.exports = { encrypt, decrypt };
