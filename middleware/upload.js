const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

// Create uploads directory if it doesn't exist
const uploadDir = path.join(__dirname, '..', 'uploads', 'documents');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Configure storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    // Generate unique filename: uuid + original extension
    const uniqueName = uuidv4() + path.extname(file.originalname);
    cb(null, uniqueName);
  }
});

// File filter - validate both extension AND MIME type for security
const fileFilter = (req, file, cb) => {
  // Allowed extensions
  const allowedExtensions = /\.(pdf|jpeg|jpg|png)$/i;

  // Allowed MIME types
  const allowedMimeTypes = [
    'application/pdf',
    'image/jpeg',
    'image/jpg',
    'image/png'
  ];

  // Check both extension and MIME type
  const hasValidExtension = allowedExtensions.test(file.originalname);
  const hasValidMimeType = allowedMimeTypes.includes(file.mimetype);

  if (hasValidExtension && hasValidMimeType) {
    cb(null, true);
  } else if (!hasValidExtension) {
    cb(new Error('Invalid file extension. Only .pdf, .jpeg, .jpg, .png files are allowed'));
  } else {
    cb(new Error('Invalid file type. File content does not match extension'));
  }
};

// Export multer instance with configuration
module.exports = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB max file size
  }
});
