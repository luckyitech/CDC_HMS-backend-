# CDC HMS API

Backend REST API for the **Comprehensive Diabetes Care (CDC) Hospital Management System**. Built with Node.js, Express 5, Sequelize ORM, and MySQL.

---

## Features

- **Role-based authentication** — Doctor, Staff, Lab Technician, Patient, Admin
- **Patient management** — Registration, profiles, UHID generation
- **Queue management** — Real-time queue with SSE (Server-Sent Events)
- **Consultation workflow** — Initial assessment, physical exams, consultation notes
- **Prescriptions** — Create, view, and manage patient prescriptions
- **Lab tests** — Order tests, enter results, flag critical values
- **Treatment plans** — Create and track diabetic treatment plans
- **Medical documents** — Secure file upload with MIME validation
- **Blood sugar tracking** — Log and trend daily readings
- **Appointments** — Book and manage patient appointments
- **Medical equipment** — Track insulin pumps and CGM devices
- **Admin controls** — Create users, manage accounts, dashboard analytics
- **Email notifications** — Welcome emails with login credentials via Nodemailer

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js |
| Framework | Express 5 |
| ORM | Sequelize 6 |
| Database | MySQL |
| Auth | JWT (jsonwebtoken) |
| Password | bcryptjs |
| File Upload | Multer |
| Email | Nodemailer |
| Security | Helmet, express-rate-limit, express-validator |
| Real-time | Server-Sent Events (SSE) |

---

## Getting Started

### Prerequisites

- Node.js 18+
- MySQL 8+
- A running MySQL database

### Installation

```bash
# Clone the repository
git clone https://github.com/luckyitech/CDC_HMS-backend-.git
cd CDC_HMS-backend-

# Install dependencies
npm install

# Copy environment file and fill in your values
cp .env.example .env
```

### Environment Variables

Edit `.env` with your actual values:

```env
PORT=3000

DB_HOST=localhost
DB_PORT=3306
DB_NAME=cdc_hms
DB_USER=your_db_user
DB_PASSWORD=your_db_password

JWT_SECRET=your_long_random_secret_here
JWT_EXPIRES_IN=7d

SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your_email@gmail.com
SMTP_PASSWORD=your_app_password

RESET_TOKEN_EXPIRES_IN=3600000
```

> **Important:** Never commit your `.env` file. It is already listed in `.gitignore`.

### Database Setup

Create the database in MySQL:

```sql
CREATE DATABASE cdc_hms;
```

The tables are created automatically by Sequelize on first run (`sync`).

### Run the Server

```bash
# Development (with auto-reload)
npm run dev

# Production
npm start
```

Server starts on `http://localhost:3000` by default.

---

## API Overview

All endpoints are prefixed with `/api`.

| Resource | Base Path |
|---|---|
| Auth | `/api/auth` |
| Patients | `/api/patients` |
| Queue | `/api/queue` |
| Prescriptions | `/api/prescriptions` |
| Lab Tests | `/api/lab-tests` |
| Treatment Plans | `/api/treatment-plans` |
| Physical Exams | `/api/physical-exams` |
| Initial Assessments | `/api/assessments` |
| Consultation Notes | `/api/consultation-notes` |
| Medical Documents | `/api/documents` |
| Appointments | `/api/appointments` |
| Blood Sugar | `/api/blood-sugar` |
| Users (Admin) | `/api/users` |
| Dashboard | `/api/dashboard` |
| Reports | `/api/reports` |
| SSE | `/api/sse` |

Full API reference is available in `CDC-HMS-API.postman_collection.json` — import it into Postman to explore all endpoints.

---

## Project Structure

```
cdc-hms-api/
├── config/          # Database connection
├── controllers/     # Request handlers (business logic)
├── middleware/      # Auth, validation, rate limiting, file upload
├── models/          # Sequelize models (18 tables)
├── routes/          # Express route definitions
├── utils/           # Helpers (response, email, SSE, formatters)
├── .env.example     # Environment variable template
├── app.js           # Express app setup
└── server.js        # Entry point
```

---

## Security

- JWT authentication on all protected routes
- Role-based access control (RBAC) on every endpoint
- Rate limiting: 1000 req/15min general, 50 req/15min on auth routes
- Passwords hashed with bcryptjs (10 rounds)
- Helmet.js security headers
- MIME type validation on file uploads (PDF, JPEG, PNG only, max 10MB)
- Temporary passwords sent via email only — never returned in API responses

---

## Roles

| Role | Access |
|---|---|
| `admin` | Full system access, user management |
| `doctor` | Patient records, consultations, prescriptions, lab orders |
| `staff` | Patient registration, queue management, triage |
| `lab` | Lab test results, critical alerts |
| `patient` | Own records, blood sugar logs, appointments |
