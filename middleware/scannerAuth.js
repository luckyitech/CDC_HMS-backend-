const crypto = require('crypto');
const db = require('../models');
const { error } = require('../utils/response');

// Machine auth for the fingerprint-scanner relay on a clinic PC (17 Oct 2026).
//
// Like the DICOM bridge's ingestAuth, but the key is per scanner and lives in
// the database: HR Settings generates it, shows it once, and stores only its
// SHA-256. The relay sends `x-scanner-key` and the scanner's serial
// (`x-scanner-serial`); both must match an active scanner. Replacing the key in
// HR Settings stops the old one at once — no server restart.
//
// Sets req.scanner (the HrScanner row) for the relay controller.
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

const scannerAuth = async (req, res, next) => {
  try {
    const key = req.headers['x-scanner-key'];
    const serial = String(req.headers['x-scanner-serial'] || '').trim();
    if (!key || !serial) return error(res, 'Missing scanner key or serial.', 401);
    const scanner = await db.HrScanner.findOne({ where: { serial } });
    if (!scanner) return error(res, 'Invalid scanner key.', 401);
    const a = Buffer.from(sha256(key), 'hex');
    const b = Buffer.from(String(scanner.keyHash), 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return error(res, 'Invalid scanner key.', 401);
    if (scanner.status !== 'active') return error(res, 'This scanner has been stopped in HR Settings.', 403);
    req.scanner = scanner;
    return next();
  } catch (err) {
    console.error('HrScanner.auth error:', err);
    return error(res, 'Scanner authentication failed', 500);
  }
};

module.exports = { scannerAuth, sha256 };
