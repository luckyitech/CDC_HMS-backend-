const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const { ensureStockReceiptDir } = require('../utils/stockReceiptStorage');

// Scanned supplier invoices / receipts (12 Oct 2026). Photos from a phone or
// tablet camera, or a PDF from a scanner. Own folder (private/stock-receipts/),
// random stored names, extension AND MIME checked — same approach as the staff
// document uploader.
const uploadDir = ensureStockReceiptDir();

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + path.extname(file.originalname).toLowerCase()),
});

const ALLOWED = [
  { ext: /\.pdf$/i,           mimes: ['application/pdf'] },
  { ext: /\.jpe?g$/i,         mimes: ['image/jpeg', 'image/jpg'] },
  { ext: /\.png$/i,           mimes: ['image/png'] },
  { ext: /\.webp$/i,          mimes: ['image/webp'] },
  { ext: /\.hei[cf]$/i,       mimes: ['image/heic', 'image/heif'] },
];

const fileFilter = (req, file, cb) => {
  const match = ALLOWED.find((a) => a.ext.test(file.originalname));
  if (!match) return cb(new Error('Only a photo (.jpg, .png, .webp, .heic) or a PDF can be attached'));
  if (!match.mimes.includes(file.mimetype)) return cb(new Error('Invalid file type. File content does not match extension'));
  return cb(null, true);
};

module.exports = multer({ storage, fileFilter, limits: { fileSize: 15 * 1024 * 1024 } });
