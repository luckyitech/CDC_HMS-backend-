/**
 * Script to create a lab technician test user with password123
 * Run with: node create-lab-user.js
 */

const bcrypt = require('bcryptjs');
const db = require('./models');

const { User, LabTechProfile } = db;

async function createLabUser() {
  try {
    console.log('Creating lab technician with password123...\n');

    // Check if lab user already exists
    const existingUser = await User.findOne({ where: { email: 'lab@cdc.com' } });

    if (existingUser) {
      // Update password to password123
      console.log('Lab user exists. Updating password to password123...');
      const hashedPassword = await bcrypt.hash('password123', 10);
      await existingUser.update({ password: hashedPassword });
      console.log('   ✓ Password updated!\n');
    } else {
      // Create new user
      console.log('Creating new lab user...');
      const hashedPassword = await bcrypt.hash('password123', 10);

      const user = await User.create({
        email: 'lab@cdc.com',
        password: hashedPassword,
        role: 'lab',
        firstName: 'Sarah',
        lastName: 'Johnson',
        phone: '+971501234567',
        isActive: true,
      });

      await LabTechProfile.create({
        UserId: user.id,
        specialization: 'Clinical Chemistry',
        certificationNumber: 'LAB-2024-001',
        qualification: 'BSc Medical Laboratory Science',
        institution: 'UAE University',
        yearsExperience: 5,
        shift: 'Morning',
      });

      console.log('   ✓ Lab technician created!\n');
    }

    console.log('┌─────────────────────────────────────────┐');
    console.log('│  LAB PORTAL LOGIN CREDENTIALS           │');
    console.log('├─────────────────────────────────────────┤');
    console.log('│  Email:    lab@cdc.com                  │');
    console.log('│  Password: password123                  │');
    console.log('└─────────────────────────────────────────┘');

    process.exit(0);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

createLabUser();
