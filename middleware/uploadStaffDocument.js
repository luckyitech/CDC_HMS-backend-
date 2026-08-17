const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Staff HR documents. A separate multer instance and a separate directory from
// middleware/upload.js, which handles patient medical documents — mixing staff
// contracts into the patient document store would put them in patient listings
// and under patient access rules.
const uploadDir = path.join(__dirname, '..', 'uploads', 'staff-documents');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    // Random name, original extension. Keeping the uploaded name on disk would
    // let a crafted filename escape the directory or overwrite another file.
    const uniqueName = crypto.randomBytes(16).toString('hex') + path.extname(file.originalname);
    cb(null, uniqueName);
  },
});

// Extension AND MIME type are both checked, so renaming an executable to .pdf
// is rejected. Same approach as the patient uploader, plus Word formats —
// employment contracts routinely arrive as .doc/.docx.
const ALLOWED = [
  { ext: /\.pdf$/i,  mimes: ['application/pdf'] },
  { ext: /\.jpe?g$/i, mimes: ['image/jpeg', 'image/jpg'] },
  { ext: /\.png$/i,  mimes: ['image/png'] },
  { ext: /\.docx$/i, mimes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'] },
  { ext: /\.doc$/i,  mimes: ['application/msword'] },
];

const fileFilter = (req, file, cb) => {
  const match = ALLOWED.find((a) => a.ext.test(file.originalname));

  if (!match) {
    return cb(new Error('Invalid file extension. Only .pdf, .jpg, .jpeg, .png, .doc and .docx files are allowed'));
  }
  if (!match.mimes.includes(file.mimetype)) {
    return cb(new Error('Invalid file type. File content does not match extension'));
  }
  return cb(null, true);
};

module.exports = multer({
  storage,
  fileFilter,
  limits: { fileSize: 25 * 1024 * 1024 },   // 25MB, matching the patient uploader
});
