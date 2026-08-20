const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { generalLimiter } = require('./middleware/rateLimiter');
const errorHandler = require('./middleware/errorHandler');

const app = express();

// Trust reverse proxy (IIS/Nginx) — required for express-rate-limit to correctly
// identify client IPs from the X-Forwarded-For header
app.set('trust proxy', 1);

// CORS — MUST be first to handle preflight OPTIONS requests
app.use(cors({
  origin: [
    'http://localhost:5173', 'http://localhost:5174',
    'http://localhost:5175', // HMIS V4 local dev (run-V4-frontend.sh)
    // Local Thyroid site preview (python http.server, port 8080+). Local testing only.
    'http://localhost:8080', 'http://localhost:8081', 'http://localhost:8082',
    'https://cdiabetescentre.com', 'https://www.cdiabetescentre.com',
    // Public booking websites (read-only slots fetch runs from the browser;
    // the booking POST goes via each site's same-origin server proxy).
    'https://thyroidkenya.com', 'https://www.thyroidkenya.com',
  ],
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
// Applied to ALL endpoints: 1000 requests per 15 minutes per IP
// (matches generalLimiter in middleware/rateLimiter.js and the README)
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
app.use('/api/nursing-notes',      require('./routes/nursingNotes'));
app.use('/api/glp1-medications',   require('./routes/glp1Medications'));
app.use('/api/glp1-therapies',     require('./routes/glp1Therapies'));
app.use('/api/glp1-reviews',       require('./routes/glp1Reviews'));
app.use('/api/glp1-administrations', require('./routes/glp1Administrations'));
app.use('/api/glp1-week-notes',    require('./routes/glp1WeekNotes'));
app.use('/api/glp1-symptoms',      require('./routes/glp1Symptoms'));
app.use('/api/appointments',       require('./routes/appointments'));
app.use('/api/public/booking',     require('./routes/publicBooking'));
app.use('/api/doctor-blocks',      require('./routes/doctorBlocks'));
app.use('/api/users',              require('./routes/users'));
app.use('/api/staff',              require('./routes/staff'));
app.use('/api/documents',          require('./routes/documents'));
app.use('/api/reports',            require('./routes/reports'));
app.use('/api/analytics',          require('./routes/analytics'));
app.use('/api/dashboard',          require('./routes/dashboard'));
app.use('/api/activity',           require('./routes/activity'));
app.use('/api/notifications',      require('./routes/notifications'));
app.use('/api/catalog',            require('./routes/catalog'));
app.use('/api/stock',              require('./routes/stock'));
app.use('/api/settings',           require('./routes/settings'));

// --- HMIS V3 inpatient ---
app.use('/api/wards',                    require('./routes/wards'));
app.use('/api/rooms',                    require('./routes/rooms'));
app.use('/api/beds',                     require('./routes/beds'));
app.use('/api/admissions',               require('./routes/admissions'));
app.use('/api/inpatient/observations',   require('./routes/inpatientObservations'));
app.use('/api/inpatient/mar',            require('./routes/mar'));
app.use('/api/ward-round-notes',         require('./routes/wardRoundNotes'));
app.use('/api/discharge-summaries',      require('./routes/dischargeSummaries'));
app.use('/api/radiology',                require('./routes/radiology'));
app.use('/api/inpatient/fluid-balance',  require('./routes/fluidBalance'));
app.use('/api/inpatient/billing',        require('./routes/inpatientBilling'));

// --- HMIS V4 ultrasound (HS70A DICOM bridge ingest + gallery) ---
app.use('/api/ultrasound',               require('./routes/ultrasound'));

// Global error handler — must be last
app.use(errorHandler);

module.exports = app;
