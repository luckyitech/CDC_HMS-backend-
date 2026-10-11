const multer = require('multer');
const { error } = require('../utils/response');
const { MAX_BYTES } = require('../utils/dermPhotoStorage');

// Skin photos (Dermatology Phase 2). Held in memory, not written by multer:
// the controller checks it really is a JPEG, strips its metadata
// (utils/dermPhotoStorage.stripJpeg) and only then writes the cleaned bytes to
// private/derm-photos/ under a random name. One 'photo' field.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!['image/jpeg', 'image/jpg'].includes(file.mimetype)) return cb(new Error('A skin photo is sent as a JPEG image'));
    return cb(null, true);
  },
});

const handleDermPhotoUpload = (req, res, next) =>
  upload.single('photo')(req, res, (err) => {
    if (!err) return next();
    const message = err.code === 'LIMIT_FILE_SIZE' ? `Photo is too large. Maximum size is ${Math.round(MAX_BYTES / 1048576)} MB.` : err.message || 'Upload failed';
    return error(res, message, 400);
  });

module.exports = { handleDermPhotoUpload };
