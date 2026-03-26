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
├── config/          # Database connection + sequelize-cli config
├── controllers/     # Request handlers (business logic)
├── middleware/      # Auth, validation, rate limiting, file upload
├── migrations/      # Sequelize migration files (schema versioning)
├── models/          # Sequelize models (18 tables)
├── routes/          # Express route definitions
├── utils/           # Helpers (response, email, SSE, formatters)
├── .env.example     # Environment variable template
├── .sequelizerc     # sequelize-cli path config
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

---

## Production Deployment

This guide documents how the CDC HMS API is deployed on the Host Africa VPS (Ubuntu 24.04, IP `102.68.87.18`).

### Server Requirements

- Ubuntu 22.04 / 24.04
- Node.js 20+ (installed via NodeSource)
- MySQL 8+
- PM2 (process manager)
- Nginx (reverse proxy)

### 1. Install Node.js 20

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
node -v   # should print v20.x.x
```

### 2. Clone the Repository

```bash
mkdir -p /var/www/cdc
cd /var/www/cdc
git clone https://github.com/luckyitech/CDC_HMS-backend-.git api
cd api
```

### 3. Install Dependencies

```bash
npm install --omit=dev
```

### 4. Create the `.env` File

```bash
nano .env
```

Paste and fill in your values:

```env
PORT=3001
DB_HOST=127.0.0.1
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

> **Note:** Use `DB_HOST=127.0.0.1` not `localhost` — MySQL on Linux listens on IPv4, and `localhost` resolves to IPv6 (`::1`) which will be refused.

### 5. Create the Database

```sql
CREATE DATABASE cdc_hms CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'cdc_user'@'localhost' IDENTIFIED BY 'your_password';
GRANT ALL PRIVILEGES ON cdc_hms.* TO 'cdc_user'@'localhost';
FLUSH PRIVILEGES;
```

### 6. Seed Initial Users (first deploy only)

Tables are created automatically by Sequelize on first start. After the first `pm2 start`, run:

```bash
node seeders/seed.js
```

This creates the default admin, doctor, staff, lab tech, and patient accounts.

### 7. Start with PM2

```bash
npm install -g pm2
pm2 start server.js --name cdc-api
pm2 save
pm2 startup   # follow the printed command to enable auto-start on reboot
```

### 8. Configure Nginx

```bash
nano /etc/nginx/sites-available/cdiabetescentre
```

Paste:

```nginx
server {
    listen 80;
    server_name api.cdiabetescentre.com;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # SSE endpoint — disable buffering for real-time events
    location /api/sse {
        proxy_pass http://127.0.0.1:3001;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 86400s;
        proxy_set_header Connection '';
        proxy_http_version 1.1;
    }
}
```

Enable and reload:

```bash
ln -s /etc/nginx/sites-available/cdiabetescentre /etc/nginx/sites-enabled/
nginx -t
systemctl reload nginx
```

### 9. DNS

On your domain registrar (one.com), add an A record:

| Type | Name | Value |
|------|------|-------|
| A | api | 102.68.87.18 |

### Updating the Backend

Whenever you push new code:

```bash
cd /var/www/cdc/api
git pull
pm2 restart cdc-api --update-env
```

If the update includes schema changes, run migrations after restarting:

```bash
npm run migrate
```

---

## Database Migrations

This project uses **Sequelize CLI migrations** to manage all database schema changes. Migrations are the only supported way to alter the database schema — `alter: true` is disabled in `server.js` and must never be re-enabled.

### Why Migrations?

- `alter: true` causes Sequelize to hang on startup while it analyzes foreign key constraints — the server never finishes booting.
- Migrations give you a versioned, reproducible history of every schema change.
- On production, you can apply changes safely with zero downtime by running `npm run migrate` after a `git pull`.

### Run Pending Migrations

```bash
npm run migrate
```

This applies all migration files in `migrations/` that have not been run yet. Safe to run multiple times — already-applied migrations are skipped.

### Undo the Last Migration

```bash
npm run migrate:undo
```

Reverts only the most recently applied migration. Run again to undo further.

### How to Add a New Migration

Whenever you add, rename, or remove a column or table in a Sequelize model, create a migration file:

**1. Create the file** in `migrations/` with a timestamp prefix:

```
migrations/YYYYMMDDHHMMSS-describe-your-change.js
```

Example: `migrations/20260401120000-add-notes-to-appointments.js`

**2. Write the migration:**

```js
'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const tableDescription = await queryInterface.describeTable('Appointments');

    if (!tableDescription.notes) {
      await queryInterface.addColumn('Appointments', 'notes', {
        type: Sequelize.TEXT,
        defaultValue: null,
      });
    }
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('Appointments', 'notes');
  },
};
```

> **Always guard with `describeTable`** — this prevents errors if the column already exists (e.g. when re-running on a DB that was previously synced with `alter: true`).

**3. Run the migration:**

```bash
npm run migrate
```

**4. Never use `alter: true`** — keep `server.js` set to `alter: false` permanently. All schema changes go through migration files only.
