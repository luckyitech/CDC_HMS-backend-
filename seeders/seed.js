/**
 * Seed script — creates the initial system users and (optionally) a demo patient.
 *
 *   npm run seed              full seed, including the demo patient
 *   npm run seed -- --no-demo real clinic: system users only, no sample data
 *
 * Every account gets its OWN randomly generated passphrase, printed once at the
 * end. Nothing is hardcoded: this file used to set 'password123' on all five
 * accounts, which meant the credentials for a deployed clinic were readable by
 * anyone with access to this repository.
 *
 * Two properties worth keeping:
 *
 *   - A password is only ever set when an account is CREATED. Re-running this
 *     never touches an existing account, so it cannot silently undo a password
 *     the admin has since changed for themselves.
 *   - To rotate an existing account's password, use the explicit tool:
 *       npm run set-password -- admin@cdc.com
 *
 * The admin has no real mailbox yet, so the forgot-password flow has nothing to
 * send to. That is fine: hand them the passphrase printed below and they change
 * it themselves from Settings → Change Password, which needs no email.
 */

require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('../models');
const { generatePassphrase, entropyBits } = require('../utils/passphrase');

const { User, DoctorProfile, StaffProfile, LabTechProfile, Patient } = db;

const skipDemo = process.argv.includes('--no-demo');

const created = [];    // [{ email, role, password }] — printed once at the end
const untouched = [];  // accounts that already existed; their passwords are left alone

/**
 * Create a user if absent, with a fresh passphrase. Existing users are returned
 * as-is and never re-passworded.
 */
const ensureUser = async ({ email, firstName, lastName, role, phone }) => {
  const found = await User.findOne({ where: { email } });
  if (found) {
    untouched.push({ email, role });
    return found;
  }

  const password = generatePassphrase();
  const user = await User.create({
    firstName, lastName, email, role, phone,
    password: await bcrypt.hash(password, 10),   // 10 rounds, as everywhere else
    isActive: true,
  });
  created.push({ email, role, password });
  return user;
};

async function seed() {
  try {
    await db.sequelize.authenticate();
    console.log(`Connected to ${db.sequelize.config.database}.\n`);

    // ── 1. Admin ──────────────────────────────────────────────────────────────
    const admin = await ensureUser({
      email: 'admin@cdc.com', firstName: 'System', lastName: 'Admin',
      role: 'admin', phone: '+254700000001',
    });
    console.log(`Admin:    ${admin.email}`);

    // ── 2. Doctor ─────────────────────────────────────────────────────────────
    const doctor = await ensureUser({
      email: 'ahmed.hassan@cdc.com', firstName: 'Ahmed', lastName: 'Hassan',
      role: 'doctor', phone: '+254700000002',
    });
    console.log(`Doctor:   ${doctor.email}`);

    await DoctorProfile.findOrCreate({
      where: { UserId: doctor.id },
      defaults: {
        UserId: doctor.id,
        specialty: 'Endocrinology',
        department: 'Diabetes & Endocrinology',
        licenseNumber: 'KMD-12345',
        qualification: 'MBChB, MMed (Internal Medicine)',
        yearsExperience: 10,
        employmentType: 'Full-time',
        startDate: new Date('2015-01-01'),
      },
    });

    // ── 3. Staff ──────────────────────────────────────────────────────────────
    const staff = await ensureUser({
      email: 'staff@cdc.com', firstName: 'Sarah', lastName: 'Kamau',
      role: 'staff', phone: '+254700000003',
    });
    console.log(`Staff:    ${staff.email}`);

    await StaffProfile.findOrCreate({
      where: { UserId: staff.id },
      defaults: {
        UserId: staff.id,
        position: 'Nurse',
        department: 'Outpatient',
        shift: 'Morning',
        startDate: new Date('2018-03-01'),
      },
    });

    // ── 4. Lab Tech ───────────────────────────────────────────────────────────
    const lab = await ensureUser({
      email: 'lab@cdc.com', firstName: 'James', lastName: 'Otieno',
      role: 'lab', phone: '+254700000004',
    });
    console.log(`Lab Tech: ${lab.email}`);

    await LabTechProfile.findOrCreate({
      where: { UserId: lab.id },
      defaults: {
        UserId: lab.id,
        specialization: 'Clinical Chemistry',
        certificationNumber: 'KMT-67890',
        qualification: 'BSc Medical Laboratory Sciences',
        yearsExperience: 5,
        shift: 'Morning',
        startDate: new Date('2020-06-01'),
      },
    });

    // ── 5 & 6. Demo patient — sample data, skipped with --no-demo ─────────────
    if (skipDemo) {
      console.log('\nSkipping the demo patient (--no-demo).');
    } else {
      const patientUser = await ensureUser({
        email: 'patient@cdc.com', firstName: 'John', lastName: 'Doe',
        role: 'patient', phone: '+254700000005',
      });
      console.log(`Patient:  ${patientUser.email}`);

      await Patient.findOrCreate({
        where: { uhid: 'CDC001' },
        defaults: {
          uhid: 'CDC001',
          firstName: 'John',
          lastName: 'Doe',
          age: 45,
          gender: 'Male',
          phone: '+254700000005',
          email: 'patient@cdc.com',
          address: 'Nairobi, Kenya',
          dateOfBirth: new Date('1980-05-15'),
          diagnosis: 'Type 2',
          diagnosisDate: new Date('2018-01-10'),
          hba1c: '7.2%',
          status: 'Active',
          riskLevel: 'Medium',
          comorbidities: ['Hypertension'],
          allergies: 'None',
          currentMedications: ['Metformin 500mg - Twice daily'],
          UserId: patientUser.id,
          primaryDoctorId: doctor.id,
        },
      });
    }

    // ── Report ────────────────────────────────────────────────────────────────
    console.log('\n' + '='.repeat(62));
    if (created.length) {
      console.log('  NEW ACCOUNTS — these passwords are shown ONCE and stored nowhere');
      console.log('='.repeat(62));
      created.forEach(({ email, role, password }) => {
        console.log(`  ${role.padEnd(8)} ${email.padEnd(24)} ${password}`);
      });
      console.log('='.repeat(62));
      console.log(`  ~${entropyBits()} bits each, bcrypt cost 10.`);
      console.log('  Hand each one over, then have them change it from');
      console.log('  Settings → Change Password. Do not commit these anywhere.');
    } else {
      console.log('  No new accounts — every user already existed.');
      console.log('='.repeat(62));
    }

    if (untouched.length) {
      console.log(`\n  Left alone (already existed, password unchanged):`);
      untouched.forEach(({ email, role }) => console.log(`    ${role.padEnd(8)} ${email}`));
      console.log('\n  To rotate one of those:  npm run set-password -- <email>');
    }
    console.log('');

    process.exit(0);
  } catch (err) {
    console.error('Seed failed:', err.message);
    process.exit(1);
  }
}

seed();
