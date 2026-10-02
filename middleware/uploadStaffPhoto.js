const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const { ensureStaffPhotoDir } = require('../utils/staffDocumentStorage');
const { error } = require('../utils/response');

// Staff photos (2 Oct 2026, B27 debt — decision D11: the person sets their own
// photo directly; HR may too). private/staff-photos/ — never served
// statically; read through the authenticated photo routes only.
const uploadDir = ensureStaffPhotoDir();

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  // Random name, original extension — a crafted filename never reaches the disk.
  filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + path.extname(file.originalname).toLowerCase()),
});

// Extension AND MIME type both checked, as the document uploader does.
const ALLOWED = [
  { ext: /\.jpe?g$/i, mimes: ['image/jpeg', 'image/jpg'] },
  { ext: /\.png$/i,  mimes: ['image/png'] },
  { ext: /\.webp$/i, mimes: ['image/webp'] },
];

const fileFilter = (req, file, cb) => {
  const match = ALLOWED.find((a) => a.ext.test(file.originalname));
  if (!match) return cb(new Error('A photo must be a .jpg, .png or .webp image'));
  if (!match.mimes.includes(file.mimetype)) return cb(new Error('Invalid file type. File content does not match extension'));
  return cb(null, true);
};

const upload = multer({ storage, fileFilter, limits: { fileSize: 5 * 1024 * 1024 } });

/**
 * The route middleware: one 'photo' field, with multer's errors turned into the
 * message the person needs (multer otherwise surfaces as a generic 500).
 * Used by the staff file and My profile — one place.
 */
const handlePhotoUpload = (req, res, next) =>
  upload.single('photo')(req, res, (err) => {
    if (!err) return next();
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'Photo is too large. Maximum size is 5MB.' : err.message || 'Upload failed';
    return error(res, message, 400);
  });

module.exports = { handlePhotoUpload };
