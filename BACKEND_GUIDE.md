# CDC HMS — Backend Development Guide

> Build phase by phase. Each section has the model, all endpoints, exact field names, and business logic. The field names and status values here are pulled directly from your frontend — keep them exactly as written.

---

## Quick Reference

| Item | Format | Example |
|------|--------|---------|
| Success response | `{ success: true, data: <payload> }` | |
| Error response | `{ success: false, message: "<text>" }` | |
| Auth header | `Authorization: Bearer <token>` | |
| Patient ID | `CDC` + zero-padded number | CDC001 |
| Prescription # | `RX-YYYY-NNN` | RX-2025-001 |
| Lab Test # | `LAB-YYYY-NNN` | LAB-2025-001 |
| Appointment # | `APT-YYYY-NNN` | APT-2025-001 |
| Document ID | `DOC-<timestamp>` | DOC-1736987654321 |

---

## Implementation Status

| Phase | Status | Description |
|-------|--------|-------------|
| **Phase 1** | ✅ **COMPLETE** | All 18 database models created and synced |
| **Phase 2** | ✅ **COMPLETE** | Authentication (login, password reset, GET /me) |
| **Phase 3** | ✅ **COMPLETE** | Patient Management (CRUD, search, stats, vitals) |
| **Phase 4** | ✅ **COMPLETE** | Queue Management (add, list, update, stats, call-next) |
| **Phase 5** | ✅ **COMPLETE** | Blood Sugar Readings (single/bulk POST, GET with filters) |
| **Phase 6** | ✅ **COMPLETE** | Prescriptions (CRUD, stats) |
| **Phase 7** | ⏭️ **SKIPPED** | Lab Tests (skipped per stakeholder decision) |
| **Phase 8a** | ✅ **COMPLETE** | Treatment Plans (CRUD, stats, auto-complete logic) |
| **Phase 8b** | ✅ **COMPLETE** | Initial Assessments (CRUD) |
| **Phase 8c** | ✅ **COMPLETE** | Physical Examinations (CRUD, search) |
| **Phase 8d** | ✅ **COMPLETE** | Consultation Notes (create, list, search) |
| **Phase 9** | ✅ **COMPLETE** | Medical Documents (upload, list, review) |
| **Phase 10** | ✅ **COMPLETE** | Appointments (book, list, check-in, stats) |
| **Phase 11** | ✅ **COMPLETE** | Medical Equipment (pump/transmitter tracking, replace logic, history) |
| **Phase 12** | ✅ **COMPLETE** | Admin / User Management |
| **Phase 13** | ✅ **COMPLETE** | Dashboard Statistics (role-specific) |

### Security Enhancements
| Feature | Status | Description |
|---------|--------|-------------|
| **Helmet** | ✅ **ACTIVE** | Security headers (HTTPS enforcement, clickjacking prevention) |
| **Rate Limiting** | ✅ **ACTIVE** | Brute force protection (general + auth-specific limits) |

---

## Table of Contents

1. [What Is Already Done](#1-what-is-already-done)
2. [Target File Structure](#2-target-file-structure)
3. [Conventions](#3-conventions)
4. [Phase 1 — All Database Models](#4-phase-1--all-database-models) ✅
5. [Phase 2 — Authentication](#5-phase-2--authentication) ✅
6. [Phase 3 — Patient Management](#6-phase-3--patient-management) ✅
7. [Phase 4 — Queue Management](#7-phase-4--queue-management) ✅
8. [Phase 5 — Blood Sugar Readings](#8-phase-5--blood-sugar-readings) ✅
9. [Phase 6 — Prescriptions](#9-phase-6--prescriptions) ✅
10. [Phase 7 — Lab Tests](#10-phase-7--lab-tests) ⏭️ SKIPPED
11. [Phase 8 — Doctor Workflow](#11-phase-8--doctor-workflow) ✅
12. [Phase 9 — Medical Documents](#12-phase-9--medical-documents) ✅
13. [Phase 10 — Appointments](#13-phase-10--appointments) ✅
14. [Phase 11 — Medical Equipment](#14-phase-11--medical-equipment) ✅
15. [Phase 12 — Admin / User Management](#15-phase-12--admin--user-management) ✅
16. [Phase 13 — Dashboard Statistics](#16-phase-13--dashboard-statistics) ✅
17. [app.js Final Route Registration](#17-appjs--final-route-registration)
18. [Context to Endpoint Mapping](#18-context--endpoint-mapping)
19. [Status Values Reference](#19-status-values-reference)
20. [Final Checklist](#20-final-checklist)
21. [Future Enhancements](#21-future-enhancements-post-integration) ⏳ TODO
22. [Test Users Reference](#22-test-users-reference)

---

## 1. What Is Already Done

### Core Infrastructure
- `server.js` — starts Express, connects MySQL via Sequelize, syncs models
- `app.js` — Express setup, CORS for `localhost:5173`, health check at `GET /api/health`
- `config/database.js` — Sequelize connection to MySQL database `cdc_hms`
- `middleware/errorHandler.js` — global error handler
- `middleware/auth.js` — JWT authentication & role-based authorization
- `middleware/validate.js` — express-validator integration
- `middleware/rateLimiter.js` — rate limiting for brute force protection ✅ NEW
- `utils/response.js` — `success(res, data, statusCode)` and `error(res, message, statusCode)`
- `utils/generateId.js` — auto-generate UHID, prescription numbers, lab test numbers
- `.env` — DB creds, JWT secret (change before production), SMTP placeholders (fill in), reset token 1hr

### Security Features ✅ NEW
- **Helmet** — Security HTTP headers (Strict-Transport-Security, X-Frame-Options, etc.)
- **Rate Limiting** — 3-tier protection:
  - General API: 100 requests per 15 minutes (all endpoints)
  - Auth Login: 5 attempts per 15 minutes (prevents brute force)
  - Password Reset: 3 attempts per hour (prevents abuse)

### Packages Installed
- Core: express, sequelize, mysql2, bcryptjs, jsonwebtoken, cors, dotenv
- Security: helmet, express-rate-limit ✅ NEW
- Utilities: multer, nodemailer, express-validator, uuid

---

## 2. Target File Structure

```
cdc-hms-api/
├── config/
│   └── database.js                  ✅ done
├── models/
│   ├── index.js                     (rewrite — import all models + define associations)
│   ├── User.js
│   ├── DoctorProfile.js
│   ├── StaffProfile.js
│   ├── LabTechProfile.js
│   ├── Patient.js
│   ├── PatientVital.js
│   ├── BloodSugarReading.js
│   ├── Queue.js
│   ├── Prescription.js
│   ├── LabTest.js
│   ├── TreatmentPlan.js
│   ├── PhysicalExamination.js
│   ├── InitialAssessment.js
│   ├── ConsultationNote.js
│   ├── MedicalDocument.js
│   ├── Appointment.js
│   ├── MedicalEquipment.js
│   └── EquipmentHistory.js
├── routes/
│   ├── auth.js
│   ├── patients.js          (includes /vitals, /blood-sugar, /equipment sub-routes)
│   ├── queue.js
│   ├── prescriptions.js
│   ├── labTests.js
│   ├── treatmentPlans.js
│   ├── assessments.js
│   ├── physicalExams.js
│   ├── consultationNotes.js
│   ├── documents.js
│   ├── appointments.js
│   └── users.js
├── controllers/
│   ├── authController.js
│   ├── patientController.js
│   ├── bloodSugarController.js
│   ├── queueController.js
│   ├── prescriptionController.js
│   ├── labTestController.js
│   ├── treatmentPlanController.js
│   ├── assessmentController.js
│   ├── physicalExamController.js
│   ├── consultationNoteController.js
│   ├── documentController.js
│   ├── appointmentController.js
│   ├── equipmentController.js
│   └── userController.js
├── middleware/
│   ├── auth.js              (NEW — authenticate + authorize)
│   ├── validate.js          (NEW — express-validator runner)
│   ├── upload.js            (NEW — multer config)
│   └── errorHandler.js      ✅ done
├── utils/
│   ├── response.js          ✅ done
│   ├── generateId.js        (NEW — UHID, RX#, LAB#, APT# generators)
│   └── labRanges.js         (NEW — critical value reference ranges)
├── uploads/
│   └── documents/
└── .env                     ✅ done
```

---

## 3. Conventions

### Response Format

Always use the helpers already in `utils/response.js`:

```javascript
const { success, error } = require('../utils/response');

success(res, data);            // 200 by default
success(res, data, 201);       // for newly created resources
error(res, 'Not found', 404);
error(res, 'Validation failed', 400);
```

### Auth Middleware (`middleware/auth.js`)

```javascript
const jwt = require('jsonwebtoken');
const { error } = require('../utils/response');

const authenticate = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return error(res, 'No token provided', 401);
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return error(res, 'Invalid or expired token', 401);
  }
};

const authorize = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user.role)) return error(res, 'Access denied', 403);
  next();
};

module.exports = { authenticate, authorize };
```

Usage in routes:
```javascript
const { authenticate, authorize } = require('../middleware/auth');
router.get('/', authenticate, authorize('doctor', 'staff'), controller.list);
```

### Validation (`middleware/validate.js`)

```javascript
const { validationResult } = require('express-validator');
const { error } = require('../utils/response');

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return error(res, errors.array().map(e => e.msg).join(', '), 400);
  }
  next();
};

module.exports = validate;
```

Usage: place `validate` as the last item in the route's middleware array, before the controller.

### ID Generation (`utils/generateId.js`)

```javascript
const { v4: uuidv4 } = require('uuid');

// UHID: CDC001, CDC002, ...
const generateUHID = async (Patient) => {
  const last = await Patient.findOne({ order: [['id', 'DESC']] });
  const num = last ? parseInt(last.uhid.replace('CDC', '')) + 1 : 1;
  return 'CDC' + String(num).padStart(3, '0');
};

// Generic number generator: prefix-YYYY-NNN
const generateNumber = async (Model, field, prefix) => {
  const year = new Date().getFullYear();
  const yearPrefix = `${prefix}-${year}-`;
  const last = await Model.findOne({
    where: { [field]: { [require('sequelize').Op.like]: `${yearPrefix}%` } },
    order: [[field, 'DESC']]
  });
  const num = last ? parseInt(last[field].split('-').pop()) + 1 : 1;
  return yearPrefix + String(num).padStart(3, '0');
};

module.exports = { generateUHID, generateNumber };
```

---

## 4. Phase 1 — All Database Models

Create all 18 model files first. Define every association in `models/index.js`. Run the server once to let Sequelize sync and verify all tables are created in MySQL.

---

### User

| Field | Type | Notes |
|-------|------|-------|
| id | INTEGER PK AUTO | |
| email | STRING UNIQUE NOT NULL | |
| password | STRING NOT NULL | bcrypt hashed |
| role | ENUM('doctor','staff','lab','patient','admin') NOT NULL | |
| firstName | STRING NOT NULL | |
| lastName | STRING NOT NULL | |
| phone | STRING | |
| isActive | BOOLEAN DEFAULT true | |
| resetToken | STRING NULL | UUID — for forgot password |
| resetTokenExpires | DATE NULL | |

---

### DoctorProfile

| Field | Type | Notes |
|-------|------|-------|
| id | INTEGER PK AUTO | |
| userId | INTEGER FK → User | 1-to-1 |
| licenseNumber | STRING | |
| specialty | STRING | e.g. Endocrinology |
| subSpecialty | STRING | |
| department | STRING | |
| qualification | STRING | e.g. MD |
| medicalSchool | STRING | |
| yearsExperience | INTEGER | |
| employmentType | STRING | Full-time / Part-time / Contract |
| startDate | DATE | |
| address | STRING | |
| city | STRING | |

---

### StaffProfile

| Field | Type | Notes |
|-------|------|-------|
| id | INTEGER PK AUTO | |
| userId | INTEGER FK → User | 1-to-1 |
| position | STRING | e.g. Receptionist |
| department | STRING | |
| shift | STRING | Morning / Afternoon / Rotating |
| startDate | DATE | |

---

### LabTechProfile

| Field | Type | Notes |
|-------|------|-------|
| id | INTEGER PK AUTO | |
| userId | INTEGER FK → User | 1-to-1 |
| specialization | STRING | |
| certificationNumber | STRING | |
| qualification | STRING | |
| institution | STRING | |
| yearsExperience | INTEGER | |
| shift | STRING | |
| startDate | DATE | |

---

### Patient

| Field | Type | Notes |
|-------|------|-------|
| id | INTEGER PK AUTO | |
| userId | INTEGER FK → User NULL | Links if patient has a login account |
| uhid | STRING UNIQUE NOT NULL | CDC### — auto-generated |
| firstName | STRING NOT NULL | |
| lastName | STRING NOT NULL | |
| age | INTEGER | |
| gender | ENUM('Male','Female') | |
| phone | STRING | |
| email | STRING | |
| address | STRING | |
| dateOfBirth | DATE | |
| idNumber | STRING | National ID |
| diabetesType | ENUM('Type 1','Type 2','Pre-diabetes','Gestational') | |
| diagnosisDate | DATE | |
| hba1c | STRING | e.g. "7.2%" |
| primaryDoctorId | INTEGER FK → User NULL | |
| referredBy | STRING | |
| status | ENUM('Active','Inactive') DEFAULT 'Active' | |
| riskLevel | ENUM('Low','Medium','High') | |
| comorbidities | JSON | Array: ["Hypertension", "Dyslipidemia"] |
| allergies | STRING | "None" or allergy text |
| currentMedications | JSON | Array of strings: ["Metformin 500mg - Twice daily"] |
| emergencyContact | JSON | { name, relationship, phone } |
| insurance | JSON | { provider, policyNumber, type } |
| lastVisit | DATE | |
| nextVisit | DATE | |

> API responses must return `name` as `firstName + ' ' + lastName` and `primaryDoctor` as the doctor's full name (from a join on primaryDoctorId). Do NOT include medicalDocuments or medicalEquipment on the patient object — those come from their own endpoints.

---

### PatientVital

| Field | Type | Notes |
|-------|------|-------|
| id | INTEGER PK AUTO | |
| patientId | INTEGER FK → Patient | |
| bp | STRING | "120/80" — no units, stored raw |
| heartRate | INTEGER | |
| temperature | DECIMAL(3,1) | |
| weight | DECIMAL(5,1) | kg |
| height | DECIMAL(4,1) | cm |
| bmi | DECIMAL(4,1) | Auto-calculated |
| oxygenSaturation | INTEGER | % |
| waistCircumference | DECIMAL(4,1) | cm |
| waistHeightRatio | DECIMAL(4,2) | Auto-calculated |
| rbs | DECIMAL(5,1) NULL | Random Blood Sugar |
| hba1c | DECIMAL(3,1) NULL | |
| ketones | DECIMAL(4,2) NULL | |
| chiefComplaint | TEXT NULL | |
| recordedAt | DATE | defaults to now() |

> API response formats these with units: bp → "120/80 mmHg", heartRate → "72 bpm", weight → "75 kg", height → "175 cm", bmi → "24.5", temperature → "36.6°C", oxygenSaturation → "98%", waistCircumference → "85 cm", waistHeightRatio → "0.49"

---

### BloodSugarReading

| Field | Type | Notes |
|-------|------|-------|
| id | INTEGER PK AUTO | |
| patientId | INTEGER FK → Patient | |
| date | DATE NOT NULL | |
| timeSlot | ENUM('fasting','breakfast','beforeLunch','afterLunch','beforeDinner','afterDinner','bedtime') NOT NULL | |
| value | DECIMAL(5,1) NOT NULL | mg/dL |
| time | STRING | Display time e.g. "7:00 AM" |

> UNIQUE constraint on (patientId, date, timeSlot) — use upsert on save to prevent duplicates.

---

### Queue

| Field | Type | Notes |
|-------|------|-------|
| id | INTEGER PK AUTO | |
| patientId | INTEGER FK → Patient | |
| status | ENUM('Waiting','In Triage','With Doctor','Completed') DEFAULT 'Waiting' | Exact casing matters |
| priority | ENUM('Normal','Urgent') DEFAULT 'Normal' | |
| reason | TEXT | |
| assignedDoctorId | INTEGER FK → User NULL | |
| consultationStartTime | DATE NULL | |
| consultationEndTime | DATE NULL | |

> Response includes uhid, name, age, gender from Patient join. Compute arrivalTime from createdAt. Compute estimatedWait = position × 15 min.

---

### Prescription

| Field | Type | Notes |
|-------|------|-------|
| id | INTEGER PK AUTO | |
| prescriptionNumber | STRING UNIQUE | RX-YYYY-NNN |
| patientId | INTEGER FK → Patient | |
| doctorId | INTEGER FK → User | |
| date | DATE | |
| diagnosis | STRING | |
| status | ENUM('Active','Completed','Cancelled') DEFAULT 'Active' | |
| medications | JSON NOT NULL | See structure below |
| notes | TEXT | |

Medications array item structure:
```json
{
  "name": "Metformin",
  "genericName": "Metformin HCl",
  "dosage": "500mg",
  "frequency": "Twice daily",
  "duration": "30 days",
  "quantity": "60 tablets",
  "instructions": "Take with meals",
  "refills": 2
}
```

> Response includes uhid, patientName, doctorName, doctorSpecialty from joins.

---

### LabTest

| Field | Type | Notes |
|-------|------|-------|
| id | INTEGER PK AUTO | |
| testNumber | STRING UNIQUE | LAB-YYYY-NNN |
| patientId | INTEGER FK → Patient | |
| orderedById | INTEGER FK → User | Doctor who ordered |
| testType | STRING NOT NULL | HbA1c, Lipid Profile, Fasting Blood Sugar, Kidney Function Test, Complete Blood Count |
| sampleType | STRING | Blood, Urine, etc. |
| priority | ENUM('Routine','Urgent') DEFAULT 'Routine' | |
| status | ENUM('Pending','Sample Collected','In Progress','Completed') DEFAULT 'Pending' | |
| orderedDate | DATE | Auto createdAt |
| orderedTime | STRING | "HH:MM AM/PM" |
| sampleCollected | BOOLEAN DEFAULT false | |
| collectionDate | STRING NULL | "YYYY-MM-DD HH:MM AM/PM" |
| results | JSON NULL | Flexible object — see below |
| normalRange | STRING NULL | Text description |
| interpretation | STRING NULL | Normal / Abnormal / Critical |
| isCritical | BOOLEAN DEFAULT false | |
| technicianNotes | TEXT NULL | |
| completedBy | STRING NULL | Technician name |
| completedDate | DATE NULL | |
| reportGenerated | BOOLEAN DEFAULT false | |

Results object — fields vary by test type:
```json
{
  "hba1c": "7.2%",
  "fastingGlucose": "95 mg/dL",
  "totalCholesterol": "180 mg/dL",
  "ldl": "110 mg/dL",
  "hdl": "55 mg/dL",
  "triglycerides": "150 mg/dL",
  "creatinine": "0.9 mg/dL",
  "bun": "18 mg/dL",
  "egfr": "85 mL/min",
  "uricAcid": "5.5 mg/dL"
}
```

---

### TreatmentPlan

| Field | Type | Notes |
|-------|------|-------|
| id | INTEGER PK AUTO | |
| patientId | INTEGER FK → Patient | |
| doctorId | INTEGER FK → User | |
| date | DATE | |
| time | STRING | "HH:MM AM/PM" |
| diagnosis | STRING | |
| plan | TEXT | Multi-line detailed plan |
| status | ENUM('Active','Completed') DEFAULT 'Active' | |
| consultationId | INTEGER NULL | |

> Business logic: when a new plan is created, auto-set all previous Active plans for the same patient to Completed.

---

### PhysicalExamination

| Field | Type | Notes |
|-------|------|-------|
| id | INTEGER PK AUTO | |
| patientId | INTEGER FK → Patient | |
| doctorId | INTEGER FK → User | |
| date | DATE | |
| time | STRING | "HH:MM:SS" |
| generalAppearance | TEXT NULL | |
| cardiovascular | TEXT NULL | |
| respiratory | TEXT NULL | |
| gastrointestinal | TEXT NULL | |
| neurological | TEXT NULL | |
| musculoskeletal | TEXT NULL | |
| skin | TEXT NULL | |
| examFindings | TEXT NULL | Overall findings summary |
| lastModified | DATE NULL | Set on update |

> API response must nest body system fields under a `data` key to match frontend: `{ id, date, uhid, doctorName, examFindings, data: { generalAppearance, cardiovascular, ... }, lastModified }`

---

### InitialAssessment

| Field | Type | Notes |
|-------|------|-------|
| id | INTEGER PK AUTO | |
| patientId | INTEGER FK → Patient | |
| doctorId | INTEGER FK → User | |
| date | DATE | |
| time | STRING | |
| hpi | TEXT NULL | History of Present Illness |
| ros | TEXT NULL | Review of Systems |
| pastMedicalHistory | TEXT NULL | |
| familyHistory | TEXT NULL | |
| socialHistory | TEXT NULL | |

---

### ConsultationNote

| Field | Type | Notes |
|-------|------|-------|
| id | INTEGER PK AUTO | |
| patientId | INTEGER FK → Patient | |
| doctorId | INTEGER FK → User | |
| date | DATE | |
| time | STRING | "HH:MM AM/PM" |
| notes | TEXT NOT NULL | Full consultation text |
| vitals | JSON NULL | Snapshot: { bp, heartRate, weight, temperature, oxygenSaturation, waistCircumference, waistHeightRatio } |
| assessment | TEXT NULL | |
| plan | TEXT NULL | |
| prescriptionIds | JSON NULL | Array of prescription IDs |

---

### MedicalDocument

| Field | Type | Notes |
|-------|------|-------|
| id | INTEGER PK AUTO | |
| documentId | STRING UNIQUE | DOC-<timestamp> |
| patientId | INTEGER FK → Patient | |
| uploadedById | INTEGER FK → User | |
| uploadedByRole | STRING | 'Doctor' or 'Patient' |
| documentCategory | STRING | See categories list below |
| testType | STRING NULL | |
| labName | STRING NULL | |
| fileName | STRING NOT NULL | Original file name |
| filePath | STRING NOT NULL | Server path |
| fileSize | STRING | e.g. "320 KB" |
| fileUrl | STRING | Public path: /uploads/documents/<uuid.ext> |
| testDate | DATE NULL | |
| status | ENUM('Pending Review','Reviewed','Archived') | Auto: Patient upload → Pending Review; Doctor/Staff → Reviewed |
| reviewedBy | STRING NULL | |
| reviewDate | DATE NULL | |
| notes | TEXT NULL | |

Document categories (use exactly these strings):
```
Lab Report - External
Imaging Report
Cardiology Report
Endocrinology Report
Nephrology Report
Ophthalmology Report
Neuropathy Screening Test
Specialist Consultation Report
Other Medical Document
```

---

### Appointment

| Field | Type | Notes |
|-------|------|-------|
| id | INTEGER PK AUTO | |
| appointmentNumber | STRING UNIQUE | APT-YYYY-NNN |
| patientId | INTEGER FK → Patient | |
| doctorId | INTEGER FK → User | |
| date | DATE NOT NULL | |
| timeSlot | STRING NOT NULL | "HH:MM AM/PM" |
| appointmentType | STRING | follow-up, routine check-up, urgent |
| reason | TEXT | |
| notes | TEXT NULL | |
| duration | STRING NULL | e.g. "30 minutes" |
| specialty | STRING NULL | |
| status | ENUM('scheduled','checked-in','completed','cancelled') DEFAULT 'scheduled' | All lowercase |
| bookedAt | DATE | Auto createdAt |

---

### MedicalEquipment

| Field | Type | Notes |
|-------|------|-------|
| id | INTEGER PK AUTO | |
| patientId | INTEGER FK → Patient | |
| deviceType | ENUM('pump','transmitter') NOT NULL | |
| isActive | BOOLEAN DEFAULT true | |
| type | STRING | e.g. "new" |
| serialNo | STRING | |
| model | STRING NULL | pump only |
| manufacturer | STRING NULL | pump only |
| startDate | DATE | |
| warrantyStartDate | DATE NULL | |
| warrantyEndDate | DATE NULL | |
| addedBy | STRING | Name of user who added |
| addedDate | DATE | |
| lastUpdatedBy | STRING NULL | |
| lastUpdatedDate | DATE NULL | |

---

### EquipmentHistory

| Field | Type | Notes |
|-------|------|-------|
| id | INTEGER PK AUTO | |
| patientId | INTEGER FK → Patient | |
| equipmentId | INTEGER FK → MedicalEquipment | The original record |
| deviceType | ENUM('pump','transmitter') | |
| serialNo | STRING | |
| model | STRING NULL | |
| manufacturer | STRING NULL | |
| startDate | DATE | |
| warrantyStartDate | DATE NULL | |
| warrantyEndDate | DATE NULL | |
| endDate | DATE | When it was replaced |
| reason | TEXT | Why it was replaced |
| addedBy | STRING | |
| archivedBy | STRING | User who archived |
| archivedDate | DATE | |

---

### Associations (models/index.js)

```
User 1:1 DoctorProfile   (User hasOne DoctorProfile)
User 1:1 StaffProfile    (User hasOne StaffProfile)
User 1:1 LabTechProfile  (User hasOne LabTechProfile)
User 1:1 Patient         (User hasOne Patient, via userId)

Patient belongs to User  (as primaryDoctor, foreignKey: primaryDoctorId)

Patient 1:M PatientVital
Patient 1:M BloodSugarReading
Patient 1:M Queue
Patient 1:M Prescription
Patient 1:M LabTest
Patient 1:M TreatmentPlan
Patient 1:M PhysicalExamination
Patient 1:M InitialAssessment
Patient 1:M ConsultationNote
Patient 1:M MedicalDocument
Patient 1:M Appointment
Patient 1:M MedicalEquipment

Prescription belongsTo Patient, belongsTo User (as doctor)
LabTest belongsTo Patient, belongsTo User (as orderedBy)
TreatmentPlan belongsTo Patient, belongsTo User (as doctor)
PhysicalExamination belongsTo Patient, belongsTo User (as doctor)
InitialAssessment belongsTo Patient, belongsTo User (as doctor)
ConsultationNote belongsTo Patient, belongsTo User (as doctor)
MedicalDocument belongsTo Patient, belongsTo User (as uploader)
Appointment belongsTo Patient, belongsTo User (as doctor)
Queue belongsTo Patient, belongsTo User (as assignedDoctor)

MedicalEquipment belongsTo Patient
MedicalEquipment 1:M EquipmentHistory
```

---

## 5. Phase 2 — Authentication

**Files:** `routes/auth.js`, `controllers/authController.js`, `middleware/auth.js`

### Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /api/auth/login | No | Login — returns JWT |
| POST | /api/auth/forgot-password | No | Sends reset email |
| POST | /api/auth/reset-password | No | Resets password using token |
| GET | /api/auth/me | Yes | Returns current user + role profile |

---

### Login

**Body:** `{ email, password, role }`

**Logic:**
1. Find User where email AND role match
2. `bcrypt.compare(password, user.password)`
3. On success: `jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' })`
4. Return token + user object shaped per role (see below)

**Error cases:** user not found → 401, wrong password → 401

**Response shape — base (all roles):**
```json
{
  "token": "<jwt>",
  "user": {
    "id": 1,
    "name": "Dr. Ahmed Hassan",
    "email": "ahmed.hassan@cdc.com",
    "phone": "+254 712 345 678",
    "role": "doctor",
    "status": "Active"
  }
}
```

**Extra fields by role:**
- **doctor** → include all DoctorProfile fields (specialty, department, licenseNumber, etc.)
- **staff** → include all StaffProfile fields (position, department, shift)
- **lab** → include all LabTechProfile fields (specialization, certificationNumber, etc.)
- **patient** → include the Patient record fields (uhid, diabetesType, etc.)
- **admin** → base fields only

---

### Forgot Password

**Body:** `{ email }`

**Logic:**
1. Find User by email (any role)
2. Generate token: `uuid.v4()`
3. Set `resetToken` and `resetTokenExpires` (now + value from `.env` RESET_TOKEN_EXPIRES_IN)
4. Send email via Nodemailer containing the token
5. Return `{ success: true, message: "Reset link sent" }`

---

### Reset Password

**Body:** `{ token, password }`

**Logic:**
1. Find User where `resetToken === token` AND `resetTokenExpires > Date.now()`
2. Hash new password with bcrypt
3. Update password, set `resetToken = null`, `resetTokenExpires = null`
4. Return success

---

### GET /api/auth/me

Protected. Decode `req.user` from JWT. Return the same user shape as login response (minus token). Fetch the profile based on `req.user.role`.

---

## 6. Phase 3 — Patient Management

**Files:** `routes/patients.js`, `controllers/patientController.js`

### Endpoints

| Method | Path | Auth | Roles | Description |
|--------|------|------|-------|-------------|
| POST | /api/patients | Yes | staff, admin | Create patient |
| GET | /api/patients | Yes | doctor, staff, admin | List patients |
| GET | /api/patients/:uhid | Yes | All roles | Get one patient |
| PUT | /api/patients/:uhid | Yes | staff, admin | Update patient |
| DELETE | /api/patients/:uhid | Yes | admin | Delete patient |
| GET | /api/patients/stats | Yes | doctor, staff, admin | Statistics |
| POST | /api/patients/:uhid/vitals | Yes | staff | Record triage vitals |
| GET | /api/patients/:uhid/vitals | Yes | doctor, staff | Latest vitals |

---

### POST /api/patients — Body

```json
{
  "firstName": "John",
  "lastName": "Doe",
  "age": 45,
  "gender": "Male",
  "phone": "+254 712 345 678",
  "email": "john.doe@email.com",
  "address": "123 Moi Avenue, Nairobi",
  "dateOfBirth": "1980-03-15",
  "idNumber": "12345678901234",
  "diabetesType": "Type 2",
  "diagnosisDate": "2020-06-15",
  "hba1c": "7.2%",
  "primaryDoctorId": 1,
  "referredBy": "Dr. Sarah Kamau",
  "riskLevel": "High",
  "comorbidities": ["Hypertension", "Dyslipidemia"],
  "allergies": "Penicillin",
  "currentMedications": ["Metformin 500mg - Twice daily"],
  "emergencyContact": { "name": "Jane Doe", "relationship": "Wife", "phone": "+254 712 345 679" },
  "insurance": { "provider": "Sani Care", "policyNumber": "INS-2024-1234", "type": "Insurance" }
}
```

Controller auto-generates `uhid` using `generateUHID()`.

---

### GET /api/patients — Query Filters

| Param | Description |
|-------|-------------|
| search | Matches name, uhid, phone, email (case-insensitive, OR logic) |
| doctor | Primary doctor name |
| riskLevel | Low, Medium, High |
| status | Active, Inactive |
| page | Page number (default 1) |
| limit | Items per page (default 20) |

---

### Patient API Response Shape

```json
{
  "id": 1,
  "uhid": "CDC001",
  "name": "John Doe",
  "age": 45,
  "gender": "Male",
  "phone": "+254 712 345 678",
  "email": "john.doe@email.com",
  "address": "123 Moi Avenue, Nairobi",
  "dateOfBirth": "1980-03-15",
  "idNumber": "12345678901234",
  "diabetesType": "Type 2",
  "diagnosisDate": "2020-06-15",
  "hba1c": "7.2%",
  "primaryDoctor": "Dr. Ahmed Hassan",
  "referredBy": "Dr. Sarah Kamau",
  "status": "Active",
  "riskLevel": "High",
  "lastVisit": "2025-01-10",
  "nextVisit": "2025-02-10",
  "emergencyContact": { "name": "Jane Doe", "relationship": "Wife", "phone": "+254 712 345 679" },
  "insurance": { "provider": "Sani Care", "policyNumber": "INS-2024-1234", "type": "Insurance" },
  "vitals": {
    "bp": "120/80 mmHg",
    "heartRate": "72 bpm",
    "weight": "75 kg",
    "height": "175 cm",
    "bmi": "24.5",
    "temperature": "36.6°C",
    "oxygenSaturation": "98%",
    "waistCircumference": "85 cm",
    "waistHeightRatio": "0.49"
  },
  "medications": ["Metformin 500mg - Twice daily", "Atorvastatin 20mg - Once daily"],
  "allergies": "Penicillin",
  "comorbidities": ["Hypertension", "Dyslipidemia"]
}
```

Vitals come from the latest PatientVital record, formatted with units. If none recorded yet, set vitals to null.

---

### GET /api/patients/stats — Response

```json
{
  "total": 5,
  "active": 4,
  "inactive": 1,
  "highRisk": 2,
  "mediumRisk": 2,
  "lowRisk": 1,
  "type1": 1,
  "type2": 3
}
```

---

### POST /api/patients/:uhid/vitals — Body (from triage form)

```json
{
  "bp": "120/80",
  "heartRate": 72,
  "temperature": 36.6,
  "weight": 75,
  "height": 175,
  "oxygenSaturation": 98,
  "waistCircumference": 85,
  "rbs": 110,
  "hba1c": 7.2,
  "ketones": 0.5,
  "chiefComplaint": "Feeling dizzy"
}
```

Controller auto-calculates:
- `bmi` = weight / (height/100)²
- `waistHeightRatio` = waistCircumference / height

---

## 7. Phase 4 — Queue Management

**Files:** `routes/queue.js`, `controllers/queueController.js`

### Endpoints

| Method | Path | Auth | Roles | Description |
|--------|------|------|-------|-------------|
| GET | /api/queue | Yes | staff, doctor | List queue |
| POST | /api/queue | Yes | staff | Add patient |
| PUT | /api/queue/:id | Yes | staff, doctor | Update status / assign doctor |
| DELETE | /api/queue/:id | Yes | staff | Remove from queue |
| GET | /api/queue/stats | Yes | staff, doctor | Statistics |
| POST | /api/queue/call-next | Yes | doctor | Call next waiting patient |

### Status Flow

```
Waiting  →  In Triage  →  With Doctor  →  Completed
```

---

### POST /api/queue — Body

```json
{ "uhid": "CDC001", "priority": "Normal", "reason": "Follow-up check" }
```

**Logic:**
- Check if patient already in queue with status NOT 'Completed'. If yes, reject with error.
- Urgent items insert after the last existing Urgent item. Normal items go at the end.

---

### Queue Item Response

```json
{
  "id": 1,
  "uhid": "CDC001",
  "name": "John Doe",
  "age": 45,
  "gender": "Male",
  "arrivalTime": "9:30 AM",
  "priority": "Normal",
  "status": "Waiting",
  "reason": "Follow-up check",
  "estimatedWait": "15 min",
  "assignedDoctorId": null,
  "assignedDoctorName": null
}
```

- `arrivalTime` = createdAt formatted as "H:MM AM/PM"
- `estimatedWait` = (1-based position among Waiting items) × 15 min

---

### PUT /api/queue/:id — Body

```json
{ "status": "In Triage" }
```

Or to assign a doctor:
```json
{ "assignedDoctorId": 1, "assignedDoctorName": "Dr. Ahmed Hassan" }
```

When status becomes `Completed`, auto-set `consultationEndTime` to now.

---

### POST /api/queue/call-next

No body. Finds the first queue item with status `Waiting`, sets it to `With Doctor`. Returns the patient item.

---

### GET /api/queue/stats — Response

```json
{
  "total": 8,
  "waiting": 3,
  "inTriage": 2,
  "withDoctor": 2,
  "completed": 1,
  "urgent": 2
}
```

---

## 8. Phase 5 — Blood Sugar Readings

**Files:** Sub-routes on `routes/patients.js` (use `{ mergeParams: true }` if separate router), `controllers/bloodSugarController.js`

### Endpoints

| Method | Path | Auth | Roles | Description |
|--------|------|------|-------|-------------|
| GET | /api/patients/:uhid/blood-sugar | Yes | patient (own only), doctor | Get readings |
| POST | /api/patients/:uhid/blood-sugar | Yes | patient | Add reading(s) |

---

### POST — Single Reading

```json
{
  "date": "2025-01-15",
  "timeSlot": "fasting",
  "value": 95,
  "time": "7:00 AM"
}
```

### POST — Bulk (multiple slots for one day)

```json
{
  "date": "2025-01-15",
  "readings": [
    { "timeSlot": "fasting", "value": 95, "time": "7:00 AM" },
    { "timeSlot": "breakfast", "value": 140, "time": "8:30 AM" },
    { "timeSlot": "afterDinner", "value": 150, "time": "7:45 PM" }
  ]
}
```

Use **upsert**: if a row for (patientId, date, timeSlot) already exists, update the value.

---

### GET Query Filters

| Param | Description |
|-------|-------------|
| days | Last N days (7, 14, 30). Default: 30 |
| date | Specific date YYYY-MM-DD |
| from + to | Date range |

### GET Response

```json
[
  { "date": "2025-01-15", "timeSlot": "fasting", "value": 95, "time": "7:00 AM" },
  { "date": "2025-01-15", "timeSlot": "breakfast", "value": 140, "time": "8:30 AM" },
  { "date": "2025-01-14", "timeSlot": "fasting", "value": 102, "time": "7:00 AM" }
]
```

### Security

Patient role can only GET/POST their own readings (match uhid to their Patient record). Doctors can GET any patient.

---

## 9. Phase 6 — Prescriptions

**Files:** `routes/prescriptions.js`, `controllers/prescriptionController.js`

### Endpoints

| Method | Path | Auth | Roles | Description |
|--------|------|------|-------|-------------|
| POST | /api/prescriptions | Yes | doctor | Create |
| GET | /api/prescriptions | Yes | doctor, patient, staff | List |
| GET | /api/prescriptions/:id | Yes | doctor, patient | Get one |
| PUT | /api/prescriptions/:id | Yes | doctor | Update |
| PUT | /api/prescriptions/:id/status | Yes | doctor | Update status only |
| DELETE | /api/prescriptions/:id | Yes | doctor | Delete |
| GET | /api/prescriptions/stats | Yes | doctor | Statistics |
| GET | /api/prescriptions/today | Yes | doctor | Today's prescriptions |

---

### POST Body

```json
{
  "uhid": "CDC001",
  "diagnosis": "Type 2 Diabetes Mellitus",
  "medications": [
    {
      "name": "Metformin",
      "genericName": "Metformin HCl",
      "dosage": "500mg",
      "frequency": "Twice daily",
      "duration": "30 days",
      "quantity": "60 tablets",
      "instructions": "Take with meals",
      "refills": 2
    }
  ],
  "notes": "Follow up in 2 weeks"
}
```

Controller auto-sets: `prescriptionNumber` (RX-YYYY-NNN), `date` = today, `doctorId` from req.user, `status: 'Active'`.

---

### GET Filters

| Param | Description |
|-------|-------------|
| uhid | Patient filter |
| doctor | Doctor ID or name |
| status | Active, Completed, Cancelled |
| from + to | Date range |

**Patient role:** auto-filter to only their own prescriptions.

---

### Response Item

```json
{
  "id": 1,
  "prescriptionNumber": "RX-2025-001",
  "uhid": "CDC001",
  "patientName": "John Doe",
  "doctorName": "Dr. Ahmed Hassan",
  "doctorSpecialty": "Endocrinology",
  "date": "2025-01-15",
  "diagnosis": "Type 2 Diabetes Mellitus",
  "status": "Active",
  "medications": [...],
  "notes": "Follow up in 2 weeks"
}
```

### Stats Response

```json
{ "total": 10, "active": 6, "completed": 3, "cancelled": 1 }
```

---

## 10. Phase 7 — Lab Tests

**Files:** `routes/labTests.js`, `controllers/labTestController.js`

### Endpoints

| Method | Path | Auth | Roles | Description |
|--------|------|------|-------|-------------|
| POST | /api/lab-tests | Yes | doctor | Order a test |
| GET | /api/lab-tests | Yes | lab, doctor, staff | List all |
| GET | /api/lab-tests/pending | Yes | lab | Pending / in-progress |
| GET | /api/lab-tests/critical | Yes | lab, doctor | Critical results |
| PUT | /api/lab-tests/:id | Yes | lab | Enter results / update status |
| GET | /api/lab-tests/stats | Yes | lab | Statistics |

---

### POST Body (Order)

```json
{
  "uhid": "CDC001",
  "testType": "HbA1c",
  "sampleType": "Blood",
  "priority": "Routine",
  "notes": "Fasting required"
}
```

Controller auto-sets: `testNumber`, `orderedById`, `orderedDate`, `orderedTime`, `status: 'Pending'`.

---

### PUT Body (Enter Results)

```json
{
  "status": "Completed",
  "sampleCollected": true,
  "collectionDate": "2025-01-10 11:00 AM",
  "results": { "hba1c": "7.2%" },
  "normalRange": "< 6.5% is normal, 6.5-8% is controlled",
  "interpretation": "Controlled",
  "isCritical": false,
  "technicianNotes": "Sample processed normally",
  "completedBy": "Sarah Mwangi",
  "reportGenerated": true
}
```

---

### Lab Test Response Item

```json
{
  "id": 1,
  "testNumber": "LAB-2025-001",
  "uhid": "CDC001",
  "patientName": "John Doe",
  "testType": "HbA1c",
  "orderedBy": "Dr. Ahmed Hassan",
  "orderedDate": "2025-01-10",
  "orderedTime": "10:30 AM",
  "sampleType": "Blood",
  "priority": "Routine",
  "status": "Completed",
  "sampleCollected": true,
  "collectionDate": "2025-01-10 11:00 AM",
  "results": { "hba1c": "7.2%" },
  "normalRange": "< 6.5% is normal",
  "interpretation": "Controlled",
  "isCritical": false,
  "technicianNotes": "Sample processed normally",
  "completedBy": "Sarah Mwangi",
  "completedDate": "2025-01-10",
  "reportGenerated": true
}
```

### Pending Tests Response

Same shape as above but includes patient `age` and `gender`. Returns tests where status IN ('Pending', 'Sample Collected', 'In Progress'). Also includes any `notes` from the order.

### Critical Value Reference Ranges (`utils/labRanges.js`)

```javascript
module.exports = {
  'HbA1c':              { normalMax: 6.5,  criticalMin: null, criticalMax: 10 },
  'Fasting Blood Sugar': { normalMin: 70, normalMax: 100, criticalMin: 50, criticalMax: 300 },
  'Lipid Profile':       { totalCholesterol: { criticalMax: 240 }, ldl: { criticalMax: 160 } },
  'Kidney Function Test':{ creatinine: { criticalMax: 2.0 }, egfr: { criticalMin: 30 } }
};
```

Use this to optionally auto-detect critical values when results are entered.

### Stats Response

```json
{ "totalTests": 15, "completed": 10, "pending": 3, "critical": 2, "normal": 8, "abnormal": 4 }
```

---

## 11. Phase 8 — Doctor Workflow

### 8a. Treatment Plans

**Files:** `routes/treatmentPlans.js`, `controllers/treatmentPlanController.js`

| Method | Path | Auth | Roles | Description |
|--------|------|------|-------|-------------|
| POST | /api/treatment-plans | Yes | doctor | Create |
| GET | /api/treatment-plans | Yes | doctor, staff | List by patient |
| PUT | /api/treatment-plans/:id/status | Yes | doctor | Update status |
| GET | /api/treatment-plans/stats | Yes | doctor | Stats |

**POST Body:**
```json
{
  "uhid": "CDC001",
  "diagnosis": "Type 2 DM - Uncontrolled",
  "plan": "1. Increase Metformin to 1000mg twice daily\n2. Add dietary counseling\n3. Follow up in 2 weeks",
  "consultationId": null
}
```

Auto-set: `date`, `time`, `doctorId`, `status: 'Active'`.
**Auto-complete:** Set all other Active treatment plans for this patient to `Completed`.

**GET filter:** `uhid` (required)

**Response Item:**
```json
{
  "id": 1,
  "uhid": "CDC001",
  "patientName": "John Doe",
  "doctorName": "Dr. Ahmed Hassan",
  "date": "2025-01-15",
  "time": "10:30 AM",
  "diagnosis": "Type 2 DM - Uncontrolled",
  "plan": "...",
  "status": "Active",
  "consultationId": null
}
```

**Stats:** `{ total: 7, active: 3, completed: 4 }`

---

### 8b. Initial Assessments

**Files:** `routes/assessments.js`, `controllers/assessmentController.js`

| Method | Path | Auth | Roles | Description |
|--------|------|------|-------|-------------|
| POST | /api/assessments | Yes | doctor | Save |
| GET | /api/assessments | Yes | doctor | List by patient |
| PUT | /api/assessments/:id | Yes | doctor | Update |
| DELETE | /api/assessments/:id | Yes | doctor | Delete |

**POST Body:**
```json
{
  "uhid": "CDC001",
  "hpi": "Patient reports increased thirst and polyuria over the last 2 weeks...",
  "ros": "Positive for fatigue and weight loss...",
  "pastMedicalHistory": "Type 2 DM diagnosed 2020...",
  "familyHistory": "Father had Type 2 DM...",
  "socialHistory": "Non-smoker, moderate alcohol..."
}
```

Auto-set: `date`, `time`, `doctorId`.

**GET filter:** `uhid`

---

### 8c. Physical Examinations

**Files:** `routes/physicalExams.js`, `controllers/physicalExamController.js`

| Method | Path | Auth | Roles | Description |
|--------|------|------|-------|-------------|
| POST | /api/physical-exams | Yes | doctor | Save |
| GET | /api/physical-exams | Yes | doctor | List by patient |
| PUT | /api/physical-exams/:id | Yes | doctor | Update |
| GET | /api/physical-exams/:id | Yes | doctor | Get one |

**POST Body:**
```json
{
  "uhid": "CDC001",
  "generalAppearance": "Alert and oriented x3...",
  "cardiovascular": "Regular rate and rhythm...",
  "respiratory": "Clear to auscultation bilaterally...",
  "gastrointestinal": "Soft, non-tender...",
  "neurological": "Intact cranial nerves...",
  "musculoskeletal": "Full ROM...",
  "skin": "No rash or lesions...",
  "examFindings": "Overall stable condition"
}
```

**Response — nest body systems under `data`:**
```json
{
  "id": 1,
  "uhid": "CDC001",
  "doctorName": "Dr. Ahmed Hassan",
  "date": "2025-01-15",
  "time": "10:30:00",
  "examFindings": "Overall stable condition",
  "data": {
    "generalAppearance": "Alert and oriented x3...",
    "cardiovascular": "Regular rate and rhythm...",
    "respiratory": "...",
    "gastrointestinal": "...",
    "neurological": "...",
    "musculoskeletal": "...",
    "skin": "..."
  },
  "lastModified": null
}
```

**GET filters:** `uhid`, `search` (searches date, doctorName, examFindings, and all fields inside data — case-insensitive)

---

### 8d. Consultation Notes

**Files:** `routes/consultationNotes.js`, `controllers/consultationNoteController.js`

| Method | Path | Auth | Roles | Description |
|--------|------|------|-------|-------------|
| POST | /api/consultation-notes | Yes | doctor | Add note |
| GET | /api/consultation-notes | Yes | doctor | List by patient |

**POST Body:**
```json
{
  "uhid": "CDC001",
  "notes": "Patient presents for routine follow-up...",
  "vitals": {
    "bp": "120/80 mmHg",
    "heartRate": "72 bpm",
    "weight": "75 kg",
    "temperature": "36.6°C",
    "oxygenSaturation": "98%",
    "waistCircumference": "85 cm",
    "waistHeightRatio": "0.49"
  },
  "assessment": "Type 2 DM - well controlled",
  "plan": "Continue current regimen, review in 1 month",
  "prescriptionIds": [1, 2]
}
```

**GET filters:** `uhid`, `search` (searches notes text, doctorName, and date — case-insensitive). If search is empty, return all notes for that patient.

**Response Item:**
```json
{
  "id": 1,
  "uhid": "CDC001",
  "patientName": "John Doe",
  "doctorName": "Dr. Ahmed Hassan",
  "date": "2025-01-15",
  "time": "10:30 AM",
  "notes": "...",
  "vitals": { ... },
  "assessment": "...",
  "plan": "...",
  "prescriptionIds": [1, 2]
}
```

---

## 12. Phase 9 — Medical Documents

**Files:** `routes/documents.js`, `controllers/documentController.js`, `middleware/upload.js`

### Multer Setup (`middleware/upload.js`)

```javascript
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { v4 }  = require('uuid');

const uploadDir = path.join(__dirname, '..', 'uploads', 'documents');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename:    (req, file, cb) => cb(null, v4() + path.extname(file.originalname))
});

const fileFilter = (req, file, cb) => {
  /\.(pdf|jpeg|jpg|png)$/i.test(file.originalname)
    ? cb(null, true)
    : cb(new Error('Only PDF and image files allowed'));
};

module.exports = multer({ storage, fileFilter, limits: { fileSize: 10 * 1024 * 1024 } });
```

### Endpoints

| Method | Path | Auth | Roles | Description |
|--------|------|------|-------|-------------|
| POST | /api/documents | Yes | patient, doctor, staff | Upload |
| GET | /api/documents | Yes | doctor, staff, patient (own) | List |
| PUT | /api/documents/:id/status | Yes | doctor | Review / archive |
| DELETE | /api/documents/:id | Yes | doctor, staff | Delete |

### POST — multipart/form-data fields

| Field | Type | Required |
|-------|------|----------|
| file | File | Yes — PDF or image, max 10MB |
| uhid | string | Yes |
| documentCategory | string | Yes — use exact category names from model section |
| testType | string | No |
| labName | string | No |
| testDate | string | No — YYYY-MM-DD |
| notes | string | No |

**Controller logic:**
1. `documentId` = `'DOC-' + Date.now()`
2. `fileSize` = format req.file.size in KB/MB
3. `fileUrl` = `/uploads/documents/<filename>`
4. `status` = uploader role is `patient` → `'Pending Review'`; otherwise → `'Reviewed'`
5. Set `uploadedByRole` from `req.user.role`

---

### GET Filters

| Param | Description |
|-------|-------------|
| uhid | Patient (required) |
| category | Filter by documentCategory |

Patient role: auto-filter to only their own documents.

---

### DELETE Logic

1. Delete the physical file from `uploads/documents/`
2. Delete the DB record

---

## 13. Phase 10 — Appointments

**Files:** `routes/appointments.js`, `controllers/appointmentController.js`

### Endpoints

| Method | Path | Auth | Roles | Description |
|--------|------|------|-------|-------------|
| POST | /api/appointments | Yes | patient | Book |
| GET | /api/appointments | Yes | patient (own), doctor, staff | List |
| PUT | /api/appointments/:id/status | Yes | staff, doctor, patient | Update status |
| GET | /api/appointments/stats | Yes | doctor, admin | Statistics |

### Status Flow

```
scheduled  →  checked-in  →  completed
scheduled  →  cancelled
```

### POST Body

```json
{
  "doctorId": 1,
  "date": "2025-02-10",
  "timeSlot": "9:00 AM",
  "appointmentType": "follow-up",
  "reason": "Monthly follow-up",
  "notes": ""
}
```

Controller auto-sets: `appointmentNumber` (APT-YYYY-NNN), `patientId` from logged-in patient, `status: 'scheduled'`, `bookedAt` = now.

---

### GET Filters

| Param | Description |
|-------|-------------|
| uhid | Patient filter (auto-set for patient role) |
| doctor | Doctor ID |
| date | Specific date — also supports the keyword `today` (resolves to current date) |
| status | scheduled, checked-in, completed, cancelled |

### Check-in Validation

When status is being set to `checked-in`:
- Appointment date must be today
- Current status must be `scheduled`

---

### Response Item

```json
{
  "id": 1,
  "appointmentNumber": "APT-2025-001",
  "uhid": "CDC001",
  "patientName": "John Doe",
  "doctorName": "Dr. Ahmed Hassan",
  "specialty": "Endocrinology",
  "date": "2025-02-10",
  "timeSlot": "9:00 AM",
  "duration": "30 minutes",
  "appointmentType": "follow-up",
  "reason": "Monthly follow-up",
  "notes": "",
  "status": "scheduled",
  "bookedAt": "2025-01-20T10:30:00.000Z"
}
```

### Stats Response

```json
{
  "total": 20,
  "scheduled": 8,
  "checkedIn": 3,
  "completed": 7,
  "cancelled": 2,
  "today": 5,
  "todayScheduled": 3,
  "todayCheckedIn": 2
}
```

---

## 14. Phase 11 — Medical Equipment

**Files:** Sub-routes on `routes/patients.js`, `controllers/equipmentController.js`

### Endpoints

| Method | Path | Auth | Roles | Description |
|--------|------|------|-------|-------------|
| GET | /api/patients/:uhid/equipment | Yes | doctor, staff | Get current equipment |
| POST | /api/patients/:uhid/equipment | Yes | doctor | Add equipment |
| PUT | /api/patients/:uhid/equipment/:id | Yes | doctor | Update |
| POST | /api/patients/:uhid/equipment/:id/replace | Yes | doctor | Replace |
| GET | /api/patients/:uhid/equipment/history | Yes | doctor | Full history |

---

### GET /equipment — Response Shape (must match this exactly)

```json
{
  "insulinPump": {
    "hasPump": true,
    "current": {
      "type": "new",
      "serialNo": "IP-2024-001",
      "model": "Omnipod 5",
      "manufacturer": "Insulet",
      "startDate": "2024-06-15",
      "warrantyStartDate": "2024-06-15",
      "warrantyEndDate": "2025-06-15",
      "addedBy": "Dr. Ahmed Hassan",
      "addedDate": "2024-06-15T10:00:00.000Z",
      "lastUpdatedBy": null,
      "lastUpdatedDate": null
    },
    "transmitter": {
      "hasTransmitter": true,
      "type": "new",
      "serialNo": "TX-2024-001",
      "startDate": "2024-06-15",
      "warrantyStartDate": "2024-06-15",
      "warrantyEndDate": "2025-06-15",
      "addedBy": "Dr. Ahmed Hassan",
      "addedDate": "2024-06-15T10:00:00.000Z",
      "lastUpdatedBy": null,
      "lastUpdatedDate": null
    },
    "history": []
  }
}
```

If patient has no pump: `{ "insulinPump": { "hasPump": false, "current": null, "transmitter": { "hasTransmitter": false, ... }, "history": [] } }`

Controller: query MedicalEquipment for active pump and transmitter, query EquipmentHistory for history, assemble into this shape.

---

### POST Body (Add)

```json
{
  "deviceType": "pump",
  "type": "new",
  "serialNo": "IP-2024-001",
  "model": "Omnipod 5",
  "manufacturer": "Insulet",
  "startDate": "2024-06-15",
  "warrantyStartDate": "2024-06-15",
  "warrantyEndDate": "2025-06-15"
}
```

Controller sets: `addedBy` = req.user name, `addedDate` = now, `isActive = true`.

---

### POST /replace Body

```json
{
  "deviceType": "pump",
  "reason": "Device malfunction",
  "type": "new",
  "serialNo": "IP-2025-002",
  "model": "Omnipod 5",
  "manufacturer": "Insulet",
  "startDate": "2025-01-20",
  "warrantyStartDate": "2025-01-20",
  "warrantyEndDate": "2026-01-20"
}
```

**Replace logic:**
1. Find current active equipment of this deviceType for this patient
2. Copy it to EquipmentHistory — set `endDate` = now, `reason` from body, `archivedBy` = req.user name, `archivedDate` = now
3. Set old equipment `isActive = false`
4. Create new MedicalEquipment record with `isActive = true`
5. Return the full equipment response (GET shape above)

---

## 15. Phase 12 — Admin / User Management

**Files:** `routes/users.js`, `controllers/userController.js`

### Endpoints

| Method | Path | Auth | Roles | Description |
|--------|------|------|-------|-------------|
| POST | /api/users/doctors | Yes | admin | Create doctor |
| POST | /api/users/staff | Yes | admin | Create staff |
| POST | /api/users/lab-techs | Yes | admin | Create lab tech |
| GET | /api/users | Yes | admin | List all users |
| PUT | /api/users/:id | Yes | admin | Update |
| PUT | /api/users/:id/status | Yes | admin | Activate / Deactivate |

---

### POST /users/doctors Body

```json
{
  "firstName": "Ahmed",
  "lastName": "Hassan",
  "email": "ahmed.hassan@cdc.com",
  "phone": "+254 712 345 678",
  "licenseNumber": "LIC-2020-12345",
  "specialty": "Endocrinology",
  "subSpecialty": "Diabetes Management",
  "department": "Endocrinology",
  "qualification": "MD",
  "medicalSchool": "University of Nairobi",
  "yearsExperience": 8,
  "employmentType": "Full-time",
  "startDate": "2020-03-01",
  "address": "123 Hospital Lane",
  "city": "Nairobi"
}
```

**Logic:**
1. Check email is not already taken
2. Generate a temporary password, hash with bcrypt
3. Create User: `{ email, password, role: 'doctor', firstName, lastName, phone }`
4. Create DoctorProfile with all professional fields, linked via userId
5. Optionally send credentials email via Nodemailer (when SMTP is configured)
6. Return the full user + profile

---

### POST /users/staff Body

```json
{
  "firstName": "Mary",
  "lastName": "Njeri",
  "email": "mary.njeri@cdc.com",
  "phone": "+254 712 111 222",
  "position": "Receptionist",
  "department": "Front Desk",
  "shift": "Morning",
  "startDate": "2023-01-15"
}
```

Same pattern: create User (role: 'staff') + StaffProfile.

---

### POST /users/lab-techs Body

```json
{
  "firstName": "Sarah",
  "lastName": "Mwangi",
  "email": "sarah.mwangi@cdc.com",
  "phone": "+254 712 333 444",
  "specialization": "Clinical Chemistry",
  "certificationNumber": "CERT-2022-456",
  "qualification": "BSc Medical Laboratory Sciences",
  "institution": "Moi University",
  "yearsExperience": 5,
  "shift": "Morning",
  "startDate": "2022-06-01"
}
```

Same pattern: create User (role: 'lab') + LabTechProfile.

---

### GET /users — Response

Return all users with their role-specific profiles joined. Each item:

```json
{
  "id": 1,
  "name": "Dr. Ahmed Hassan",
  "email": "ahmed.hassan@cdc.com",
  "phone": "+254 712 345 678",
  "role": "doctor",
  "status": "Active",
  "specialty": "Endocrinology",
  "department": "Endocrinology"
}
```

**Filter:** `role` query param (doctor, staff, lab, patient, admin)

---

### PUT /users/:id/status Body

```json
{ "isActive": false }
```

---

## 16. Phase 13 — Dashboard Statistics

Role-specific dashboard data for each user type. Single endpoint returns different data based on authenticated user's role.

### Files to Create

```
controllers/dashboardController.js
routes/dashboard.js
```

### Endpoint

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /api/dashboard | Any authenticated user | Returns role-specific statistics |

### Response by Role

#### Admin Dashboard
```json
{
  "success": true,
  "data": {
    "role": "admin",
    "generatedAt": "2026-02-16T07:32:50.410Z",
    "users": {
      "total": 14,
      "doctors": 6,
      "staff": 4,
      "labTechs": 3,
      "admins": 1
    },
    "patients": {
      "total": 2,
      "newThisWeek": 0
    },
    "today": {
      "appointments": 0,
      "queueCount": 0,
      "pendingLabTests": 4
    }
  }
}
```

#### Doctor Dashboard
```json
{
  "success": true,
  "data": {
    "role": "doctor",
    "generatedAt": "2026-02-16T07:32:38.919Z",
    "myPatients": 2,
    "today": {
      "queueWaiting": 0,
      "appointments": 0,
      "consultationsCompleted": 0
    },
    "pending": {
      "labResults": 4,
      "activePrescriptions": 1
    },
    "nextPatient": null
  }
}
```

#### Staff Dashboard
```json
{
  "success": true,
  "data": {
    "role": "staff",
    "generatedAt": "2026-02-16T07:36:02.429Z",
    "queue": {
      "waiting": 0,
      "inTriage": 0,
      "withDoctor": 0,
      "completed": 0,
      "total": 0
    },
    "today": {
      "checkIns": 0,
      "appointments": 0
    },
    "pending": {
      "documentsToReview": 1
    },
    "upcomingAppointments": []
  }
}
```

#### Lab Tech Dashboard
```json
{
  "success": true,
  "data": {
    "role": "lab",
    "generatedAt": "2026-02-16T07:36:10.000Z",
    "tests": {
      "pending": 4,
      "inProgress": 0,
      "completedToday": 0,
      "urgent": 0
    },
    "pendingTestsList": [
      {
        "id": 1,
        "testType": "HbA1c",
        "priority": "Routine",
        "patient": "John Doe",
        "uhid": "CDC001",
        "orderedAt": "2026-02-10T10:00:00.000Z"
      }
    ]
  }
}
```

#### Patient Dashboard
```json
{
  "success": true,
  "data": {
    "role": "patient",
    "generatedAt": "2026-02-16T07:36:13.945Z",
    "patient": {
      "uhid": "CDC001",
      "name": "John Doe",
      "diabetesType": "Type 2",
      "hba1c": "7.2",
      "hba1cStatus": "Well Controlled",
      "primaryDoctor": "Dr. Ahmed Hassan"
    },
    "nextAppointment": {
      "date": "2026-03-01",
      "timeSlot": "9:00 AM",
      "doctor": "Dr. Ahmed Hassan",
      "appointmentType": "consultation"
    },
    "recentLabTests": [],
    "activePrescriptions": 1,
    "recentBloodSugar": [
      { "date": "2026-02-04", "timeSlot": "fasting", "value": "98.0" }
    ]
  }
}
```

### Implementation Notes

- Reuses `formatters.js` utilities (formatPatientName, formatDoctorName, getTodayISO)
- Reuses `medicalConstants.js` (classifyHbA1c for patient HbA1c status)
- Queue queries use `createdAt` date range (Queue model has no `date` field)
- Queue position is computed dynamically, not stored
- Appointment uses `timeSlot` (not `time`) and `appointmentType` (not `type`)

---

## 17. app.js — Final Route Registration

Replace the commented-out routes in `app.js` with:

```javascript
// Auth
app.use('/api/auth', require('./routes/auth'));

// Core
app.use('/api/patients', require('./routes/patients'));   // includes vitals, blood-sugar, equipment
app.use('/api/queue',    require('./routes/queue'));

// Doctor features
app.use('/api/prescriptions',        require('./routes/prescriptions'));
app.use('/api/lab-tests',            require('./routes/labTests'));
app.use('/api/treatment-plans',      require('./routes/treatmentPlans'));
app.use('/api/assessments',          require('./routes/assessments'));
app.use('/api/physical-exams',       require('./routes/physicalExams'));
app.use('/api/consultation-notes',   require('./routes/consultationNotes'));

// Shared
app.use('/api/documents',            require('./routes/documents'));
app.use('/api/appointments',         require('./routes/appointments'));
app.use('/api/reports',              require('./routes/reports'));
app.use('/api/dashboard',            require('./routes/dashboard'));

// Admin
app.use('/api/users',                require('./routes/users'));
```

---

## 18. Context → Endpoint Mapping

| Frontend Context | Key Functions | Backend Endpoints |
|-----------------|---------------|-------------------|
| UserContext | login, logout | POST /api/auth/login, GET /api/auth/me |
| UserContext | addUser, updateUser, deleteUser | POST/PUT /api/users/* |
| PatientContext | addPatient, getPatientByUHID, searchPatients | POST/GET /api/patients |
| PatientContext | updatePatientVitals | POST /api/patients/:uhid/vitals |
| PatientContext | getPatientStats | GET /api/patients/stats |
| PatientContext | uploadMedicalDocument, getMedicalDocuments, deleteMedicalDocument | POST/GET/DELETE /api/documents |
| PatientContext | addMedicalEquipment, replaceMedicalEquipment, getMedicalEquipmentHistory | POST /api/patients/:uhid/equipment, POST .../replace, GET .../history |
| PatientContext | addBloodSugarReading, getBloodSugarReadings | POST/GET /api/patients/:uhid/blood-sugar |
| QueueContext | addToQueue, updateQueueStatus, callNextPatient, getQueueStats | POST/PUT/GET /api/queue |
| PrescriptionContext | addPrescription, getPrescriptionsByPatient, updatePrescriptionStatus | POST/GET/PUT /api/prescriptions |
| LabContext | addLabTest (order), addLabTest (results), getPendingTests, getCriticalTests, getLabStats | POST/PUT/GET /api/lab-tests |
| TreatmentPlanContext | addTreatmentPlan, getPlansByPatient, updatePlanStatus, getPlanStats | POST/GET/PUT /api/treatment-plans |
| PhysicalExamContext | saveExamination, getExaminationsByPatient, searchExaminations | POST/GET /api/physical-exams |
| InitialAssessmentContext | saveAssessment, getAssessmentsByPatient | POST/GET /api/assessments |
| ConsultationNotesContext | addNote, getNotesByPatient, searchNotes | POST/GET /api/consultation-notes |
| AppointmentContext | addAppointment, updateAppointmentStatus, getAppointmentStats | POST/PUT/GET /api/appointments |
| DashboardContext | getDashboardStats | GET /api/dashboard |

---

## 19. Status Values Reference

These exact strings are used by the frontend. Your ENUM definitions and responses must match exactly — including casing and spaces.

| Entity | Field | Values |
|--------|-------|--------|
| User | role | `doctor` `staff` `lab` `patient` `admin` |
| Patient | status | `Active` `Inactive` |
| Patient | riskLevel | `Low` `Medium` `High` |
| Patient | diabetesType | `Type 1` `Type 2` `Pre-diabetes` `Gestational` |
| Queue | status | `Waiting` `In Triage` `With Doctor` `Completed` |
| Queue | priority | `Normal` `Urgent` |
| Prescription | status | `Active` `Completed` `Cancelled` |
| Lab Test | status | `Pending` `Sample Collected` `In Progress` `Completed` |
| Lab Test | priority | `Routine` `Urgent` |
| Lab Test | interpretation | `Normal` `Abnormal` `Critical` |
| Treatment Plan | status | `Active` `Completed` |
| Appointment | status | `scheduled` `checked-in` `completed` `cancelled` |
| Appointment | type | `follow-up` `routine check-up` `urgent` |
| Medical Document | status | `Pending Review` `Reviewed` `Archived` |
| Medical Equipment | deviceType | `pump` `transmitter` |

---

## 20. Final Checklist

Work through this before connecting the frontend.

### Models & Database
- [ ] All 18 models created with correct field names and types
- [ ] All associations defined in models/index.js
- [ ] sequelize.sync() creates all tables — verify in MySQL
- [ ] UNIQUE constraints: uhid, email, prescriptionNumber, testNumber, appointmentNumber, documentId
- [ ] BloodSugarReading unique on (patientId, date, timeSlot)

### Auth
- [ ] Login works for all 5 roles
- [ ] JWT issued and verified correctly
- [ ] Forgot password flow: token generated, email sent, token expires after 1 hour
- [ ] Reset password clears the token after use
- [ ] GET /api/auth/me returns correct profile per role

### Patients
- [ ] UHID auto-generation (CDC001, CDC002…)
- [ ] Search matches across name, uhid, phone, email
- [ ] All query filters work (doctor, riskLevel, status, pagination)
- [ ] Vitals auto-calculate bmi and waistHeightRatio
- [ ] Vitals response formats values with units

### Queue
- [ ] Duplicate patient check (reject if already in queue and not Completed)
- [ ] Urgent priority insertion order is correct
- [ ] Status flow enforced: Waiting → In Triage → With Doctor → Completed
- [ ] Call-next picks the first Waiting patient
- [ ] estimatedWait computed as position × 15 min
- [ ] consultationEndTime set when status → Completed

### Blood Sugar
- [ ] Single and bulk POST both work
- [ ] Upsert on (patientId, date, timeSlot) — no duplicate errors
- [ ] All date filters work (days, from/to, specific date)
- [ ] Patient can only access own data

### Prescriptions
- [ ] RX number auto-generation (RX-YYYY-NNN)
- [ ] Medications stored as JSON array correctly
- [ ] All filters work (uhid, status, doctor, date range)
- [ ] Patient role sees only own prescriptions
- [ ] Today's prescriptions endpoint works
- [ ] Stats counts are accurate

### Lab Tests
- [ ] Test number auto-generation (LAB-YYYY-NNN)
- [ ] Results stored as flexible JSON
- [ ] Pending endpoint returns correct statuses
- [ ] Critical tests endpoint filters isCritical = true
- [ ] Stats counts are accurate

### Doctor Workflow
- [ ] Treatment plans: new plan auto-completes previous Active plans for same patient
- [ ] Assessments: full CRUD with uhid filter
- [ ] Physical exams: response nests body fields under `data` key
- [ ] Physical exams: search works across all body system fields
- [ ] Consultation notes: search works across notes, doctorName, date

### Documents
- [ ] Multer upload works (PDF, JPG, PNG)
- [ ] File size limit enforced (10 MB)
- [ ] documentId generated as DOC-<timestamp>
- [ ] Status auto-set based on uploader role
- [ ] DELETE removes both file from disk and record from DB

### Appointments
- [ ] APT number auto-generation (APT-YYYY-NNN)
- [ ] `date=today` filter resolves to current date
- [ ] Check-in only allowed if appointment is today and status is 'scheduled'
- [ ] Stats include today's breakdown

### Equipment
- [ ] GET response matches the nested shape exactly (insulinPump.current, insulinPump.transmitter, history)
- [ ] Replace: old equipment archived to history, new one created as active
- [ ] History endpoint returns all archived entries

### Admin
- [ ] Create doctor/staff/lab-tech creates User + profile in one flow
- [ ] Email uniqueness enforced on creation
- [ ] User list filterable by role
- [ ] Activate/deactivate toggles isActive

### Final
- [ ] All routes registered in app.js
- [ ] Every route has authenticate + authorize middleware
- [ ] All POST/PUT routes have input validation (express-validator)
- [ ] All responses go through success() / error() helpers
- [ ] CORS allows localhost:5173
- [ ] Test every endpoint with Postman or Thunder Client
- [ ] Fill in SMTP credentials in .env before testing forgot-password
- [ ] Change JWT_SECRET to something strong before production

---

## 21. Future Enhancements (Post-Integration)

These features should be implemented after the frontend-backend integration is complete.

### 21.1 Email Notifications for New Users

**Problem:** When admin creates a new user (doctor, staff, lab tech), the system generates a random temporary password. The user has no way to know their password.

**Solution:** Send welcome email with credentials.

**Implementation Steps:**
1. Configure SMTP in `.env`:
   ```
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=587
   SMTP_USER=your-email@gmail.com
   SMTP_PASS=your-app-password
   ```
2. Create `utils/emailService.js` with nodemailer
3. Create email template for welcome credentials
4. Call `sendCredentialsEmail(email, tempPassword)` in `userController.js` after creating user
5. Remove `tempPassword` from API response in production

**Email Template Should Include:**
- Welcome message
- Login URL
- Email address
- Temporary password
- Instructions to change password on first login

### 21.2 Force Password Change on First Login

**Problem:** Users logging in with temporary passwords should be required to change their password immediately for security.

**Solution:** Add `mustChangePassword` flag to User model.

**Implementation Steps:**
1. Add column to User model:
   ```javascript
   mustChangePassword: {
     type: DataTypes.BOOLEAN,
     defaultValue: false
   }
   ```
2. Set `mustChangePassword: true` when admin creates new user
3. Modify login response to include this flag
4. Frontend redirects to "Change Password" page if flag is true
5. After password change, set flag to false

**Login Response Change:**
```javascript
{
  success: true,
  data: {
    token: "...",
    user: { ... },
    mustChangePassword: true  // Frontend checks this
  }
}
```

### 21.3 SMS Notifications (Optional - Paid Service)

**Note:** SMS services require paid subscriptions (~$0.007 per message).

**Use Cases:**
- Appointment reminders (1 day before)
- Critical lab result alerts
- Two-factor authentication (2FA)

**Services to Consider:**
| Service | Cost/SMS | Notes |
|---------|----------|-------|
| Twilio | ~$0.0075 | Most popular |
| AWS SNS | ~$0.0065 | Amazon ecosystem |
| Vonage | ~$0.0068 | Good API |

**Recommendation:** Start with email only. Add SMS later if budget allows and there's clear ROI (e.g., reducing appointment no-shows).

---

## 22. Test Users Reference

| Role | Email | Password | Notes |
|------|-------|----------|-------|
| Doctor | ahmed.hassan@cdc.com | password123 | Has DoctorProfile |
| Admin | admin@cdc.com | password123 | Full system access |
| Staff | staff@cdc.com | password123 | Has StaffProfile |
| Patient | patient@cdc.com | password123 | Linked to CDC001 John Doe |
| Lab Tech | lab@cdc.com | password123 | Has LabTechProfile |

---

## 23. Moving to Production — Deployment Checklist

This section documents every change required when deploying CDC HMS to a production server.

### 23.1 Email (SMTP) Configuration

Currently the system uses a **Gmail test account** for sending emails. Before going live you must switch to the company's official email address.

**Steps:**

1. **Get the company email credentials** — e.g. `info@yourcompany.com` or `noreply@yourcompany.com`

2. **Update `.env`** on the production server:
   ```env
   SMTP_HOST=smtp.gmail.com        # or your company mail server
   SMTP_PORT=587
   SMTP_USER=noreply@yourcompany.com
   SMTP_PASSWORD=<new-app-password-or-smtp-password>
   ```

3. **If using Gmail for the company email:**
   - Enable 2-Step Verification on the Google account
   - Go to Google Account → Security → App Passwords
   - Generate a new App Password (name it e.g. "CDC HMS Production")
   - Use the 16-character code as `SMTP_PASSWORD`
   - The test App Password (`empuqogjtavmljzw`) is tied to a personal Gmail — do **not** use it in production

4. **If using a business mail server (Outlook, cPanel, Zoho, etc.):**
   - Change `SMTP_HOST` to match (e.g. `smtp.office365.com`, `mail.yourdomain.com`)
   - Change `SMTP_PORT` if needed (Outlook uses 587; some cPanel servers use 465 with `secure: true`)
   - Update `secure: false` → `secure: true` in `utils/emailService.js` if port is 465

5. **Test** by registering a new user after deploying — the welcome email should arrive from the company address

---

### 23.2 Frontend URL

The `FRONTEND_URL` env variable controls the domain used in password-reset links sent by email.

**Change it to the production domain:**
```env
# Development (current)
FRONTEND_URL=http://localhost:5173

# Production
FRONTEND_URL=https://www.yourcompany.com
```

> This is the **only** change needed for reset-link URLs — `emailService.js` reads this variable automatically.

---

### 23.3 Security Hardening

| Setting | Development | Production |
|---------|-------------|------------|
| `JWT_SECRET` | `cdc_hms_secret_key_change_in_production` | Long random string (32+ chars) |
| `DB_PASSWORD` | *(empty)* | Strong password |
| `SMTP_PASSWORD` | Personal Gmail App Password | Company App Password |
| API `tempPassword` in response | Included (for testing) | Consider removing |

**Generate a strong JWT secret:**
```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```
Copy the output and set it as `JWT_SECRET` in production `.env`.

**Removing `tempPassword` from API responses (recommended for production):**

Currently `patientController.js` returns `tempPassword` in the response so the frontend can display it in the success toast. In production this is a security risk (passwords in API responses can appear in logs).

Once email is confirmed working, remove it:
- In `patientController.js`: remove `tempPassword` from the `success(...)` call
- In `userController.js`: remove the `tempPassword` field from any response bodies
- In frontend `CreatePatient.jsx` (admin & staff): remove the temp password line from the success toast

---

### 23.4 Database

```env
# Production — use a dedicated MySQL user (not root)
DB_HOST=localhost           # or your DB server IP
DB_PORT=3306
DB_NAME=cdc_hms
DB_USER=cdc_hms_user        # dedicated DB user, NOT root
DB_PASSWORD=<strong-password>
```

**Production DB setup:**
```sql
CREATE USER 'cdc_hms_user'@'localhost' IDENTIFIED BY 'StrongPassword123!';
GRANT ALL PRIVILEGES ON cdc_hms.* TO 'cdc_hms_user'@'localhost';
FLUSH PRIVILEGES;
```

---

### 23.5 Server & CORS

In `server.js` (or `app.js`), update the CORS origin from localhost to the production domain:
```javascript
// Development
origin: 'http://localhost:5173'

// Production
origin: 'https://www.yourcompany.com'
```

Set `NODE_ENV=production` in the environment so Express disables stack traces in error responses.

---

### 23.6 Production `.env` Template

Copy this template and fill in all values before deploying:

```env
# Server
PORT=3000
NODE_ENV=production

# MySQL Database
DB_HOST=localhost
DB_PORT=3306
DB_NAME=cdc_hms
DB_USER=cdc_hms_user
DB_PASSWORD=CHANGE_THIS

# JWT
JWT_SECRET=CHANGE_THIS_TO_64_CHAR_RANDOM_STRING
JWT_EXPIRES_IN=7d

# Email (company address)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=noreply@yourcompany.com
SMTP_PASSWORD=CHANGE_THIS_APP_PASSWORD

# Frontend URL
FRONTEND_URL=https://www.yourcompany.com

# Password Reset Token (1 hour)
RESET_TOKEN_EXPIRES_IN=3600000
```

---

### 23.7 Quick Production Checklist

- [ ] Update `SMTP_USER` and `SMTP_PASSWORD` to company email
- [ ] Update `FRONTEND_URL` to production domain
- [ ] Generate and set a strong `JWT_SECRET`
- [ ] Set a strong `DB_PASSWORD`, use a dedicated DB user (not root)
- [ ] Update CORS origin in `app.js`
- [ ] Set `NODE_ENV=production`
- [ ] Test welcome email after first user registration
- [ ] Test password reset email flow end-to-end
- [ ] Remove `tempPassword` from API responses once email is confirmed working
- [ ] Run database migrations/sync on production server
- [ ] Set up process manager (PM2) to keep the Node.js server running

