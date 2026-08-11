/**
 * HMIS V3 — create a nurse test user with password123
 * Run with: node create-nurse-user.js
 *
 * Use this to get a nurse login for reviewing the inpatient workspace until the
 * admin Create Users form gains a Nurse tab (deferred to the RBAC work).
 */

const bcrypt = require('bcryptjs');
const db = require('./models');

const { User } = db;

async function createNurseUser() {
  try {
    console.log('Creating nurse with password123...\n');

    const existing = await User.findOne({ where: { email: 'nurse@cdc.com' } });

    if (existing) {
      const hashedPassword = await bcrypt.hash('password123', 10);
      await existing.update({ password: hashedPassword, role: 'nurse', isActive: true });
      console.log('   ✓ Existing nurse updated (password reset, role=nurse).\n');
    } else {
      const hashedPassword = await bcrypt.hash('password123', 10);
      await User.create({
        email: 'nurse@cdc.com',
        password: hashedPassword,
        role: 'nurse',
        firstName: 'Amina',
        lastName: 'Wanjiru',
        phone: '+254700000000',
        isActive: true,
      });
      console.log('   ✓ Nurse created!\n');
    }

    console.log('┌─────────────────────────────────────────┐');
    console.log('│  NURSE PORTAL LOGIN CREDENTIALS         │');
    console.log('├─────────────────────────────────────────┤');
    console.log('│  Email:    nurse@cdc.com                │');
    console.log('│  Password: password123                  │');
    console.log('└─────────────────────────────────────────┘');
    console.log('\nNote: the nurse ENUM migration (20260807000001) must have run first.');

    process.exit(0);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

createNurseUser();
