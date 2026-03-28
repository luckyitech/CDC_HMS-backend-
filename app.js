const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { generalLimiter } = require('./middleware/rateLimiter');
const errorHandler = require('./middleware/errorHandler');

const app = express();

// Trust nginx reverse proxy — required for express-rate-limit to correctly
// identify client IPs from the X-Forwarded-For header
app.set('trust proxy', 1);

// CORS — MUST be first to handle preflight OPTIONS requests
app.use(cors({
  origin: ['http://localhost:5173', 'http://localhost:5174', 'https://cdiabetescentre.com', 'https://www.cdiabetescentre.com'],
  credentials: true,
}));

// Security headers
app.use(helmet({
  contentSecurityPolicy: false,        // Disabled for API-only apps
  crossOriginEmbedderPolicy: false,    // Not needed for API
}));

// SSE — registered before rate limiter (long-lived connection, counts as 1 request)
app.use('/api/sse', require('./routes/sse'));

// Rate limiting — Prevent brute force and DoS attacks
// Applied to ALL endpoints: 100 requests per 15 minutes per IP
app.use('/api/', generalLimiter);

// Parse JSON bodies (increased limit for physical exam base64 images)
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ success: true, message: 'CDC HMS API is running' });
});

// Serve uploaded documents (static files)
app.use('/uploads', express.static('uploads'));

// Routes (added as each phase is built)
app.use('/api/auth',               require('./routes/auth'));
app.use('/api/patients',           require('./routes/patients'));
app.use('/api/queue',              require('./routes/queue'));
app.use('/api/prescriptions',      require('./routes/prescriptions'));
app.use('/api/lab-tests',          require('./routes/labTests'));
app.use('/api/treatment-plans',    require('./routes/treatmentPlans'));
app.use('/api/physical-exams',     require('./routes/physicalExams'));
app.use('/api/assessments',        require('./routes/assessments'));
app.use('/api/consultation-notes', require('./routes/consultationNotes'));
app.use('/api/appointments',       require('./routes/appointments'));
app.use('/api/users',              require('./routes/users'));
app.use('/api/documents',          require('./routes/documents'));
app.use('/api/reports',            require('./routes/reports'));
app.use('/api/dashboard',          require('./routes/dashboard'));
app.use('/api/activity',           require('./routes/activity'));

// Global error handler — must be last
app.use(errorHandler);

module.exports = app;
