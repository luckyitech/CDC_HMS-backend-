const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// HMIS V4 — multer config for ultrasound PNG ingest (DICOM bridge only).
// Mirrors middleware/upload.js but with its own directory and PNG-only filter.

const uploadDir = path.join(__dirname, '..', 'uploads', 'ultrasound');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueName = crypto.randomBytes(16).toString('hex') + '.png';
    cb(null, uniqueName);
  },
});

// PNG only — the bridge always converts DICOM pixel data to PNG before upload
const fileFilter = (req, file, cb) => {
  const hasValidExtension = /\.png$/i.test(file.originalname);
  const hasValidMimeType = file.mimetype === 'image/png';

  if (hasValidExtension && hasValidMimeType) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file. Ultrasound ingest accepts PNG only.'));
  }
};

module.exports = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 30 * 1024 * 1024, // 30MB — high-res stills are well under this
  },
});
