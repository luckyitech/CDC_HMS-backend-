/**
 * Seed script — creates the initial system users and (optionally) a demo patient.
 *
 *   npm run seed              full seed, including the demo patient
 *   npm run seed -- --no-demo real clinic: system users only, no sample data
 *
 * PASSWORDS
 *
 *   SEED_PASSWORD set in .env   every seeded account gets that password
 *   SEED_PASSWORD unset         each account gets its own random passphrase,
 *                               printed once
 *
 * Use SEED_PASSWORD for an environment you log into yourself — a shared, known
 * password across the test accounts is the whole point, and .env is gitignored
 * so it never reaches the repository. That was the real problem with the old
 * hardcoded 'password123': not that it was shared, but that it was published.
 *
 * Leave it unset when seeding a real clinic, where each person should have a
 * password nobody else knows. Either way the password must pass the same policy
 * the app enforces on its own auth routes; a weak SEED_PASSWORD is refused.
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
const { generatePassphrase, entropyBits, meetsPolicy } = require('../utils/passphrase');

const { User, DoctorProfile, StaffProfile, LabTechProfile, Patient } = db;

const skipDemo = process.argv.includes('--no-demo');

// SEED_PASSWORD sets one known password across every seeded account. It lives in
// .env, which is gitignored, so the password is knowable by whoever runs the
// seed without ever being readable in the repository — which was the actual
// problem with the old hardcoded 'password123', not the fact that it was shared.
//
// These accounts get logged into daily for testing, so a different random
// password per account would be worse than useless. Leave SEED_PASSWORD unset
// and each account gets its own generated passphrase instead, which is the
// right default for a real clinic where nobody should share a login.
const sharedPassword = process.env.SEED_PASSWORD || null;

const created = [];    // [{ email, role, password }] — printed once at the end
const untouched = [];  // accounts that already existed; their passwords are left alone

/**
 * Create a user if absent. Existing users are returned as-is and never
 * re-passworded, so re-running the seed cannot undo a password someone changed.
 */
const ensureUser = async ({ email, firstName, lastName, role, phone }) => {
  const found = await User.findOne({ where: { email } });
  if (found) {
    untouched.push({ email, role });
    return found;
  }

  const password = sharedPassword || generatePassphrase();
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
    // Refuse a weak SEED_PASSWORD rather than quietly seeding one. The whole
    // point of replacing 'password123' was to stop a guessable credential
    // reaching a live clinic; letting it back in through .env would undo that.
    if (sharedPassword && !meetsPolicy(sharedPassword)) {
      console.error('SEED_PASSWORD does not meet the policy the app enforces on its own');
      console.error('auth routes: at least 8 characters with an uppercase letter, a');
      console.error('lowercase letter, a number and a symbol. Nothing was seeded.');
      process.exit(1);
    }

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
    if (created.length && sharedPassword) {
      console.log('  NEW ACCOUNTS — all using your SEED_PASSWORD from .env');
      console.log('='.repeat(62));
      created.forEach(({ email, role }) => console.log(`  ${role.padEnd(8)} ${email}`));
      console.log('='.repeat(62));
      console.log('  Password: the SEED_PASSWORD you set in .env (gitignored).');
    } else if (created.length) {
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
