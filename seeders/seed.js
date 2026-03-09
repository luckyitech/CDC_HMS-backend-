/**
 * Production seed script — creates the initial system users and a demo patient.
 * Run once on the server: node seeders/seed.js
 */

require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('../models');

const { User, DoctorProfile, StaffProfile, LabTechProfile, Patient } = db;

async function seed() {
  try {
    await db.sequelize.authenticate();
    console.log('Database connected.');

    const password = await bcrypt.hash('password123', 10);

    // ── 1. Admin ──────────────────────────────────────────────────────────────
    const [admin] = await User.findOrCreate({
      where: { email: 'admin@cdc.com' },
      defaults: {
        firstName: 'System',
        lastName: 'Admin',
        email: 'admin@cdc.com',
        password,
        role: 'admin',
        phone: '+254700000001',
        isActive: true,
      },
    });
    console.log(`Admin: ${admin.email} (${admin.id === undefined ? 'existing' : 'created'})`);

    // ── 2. Doctor ─────────────────────────────────────────────────────────────
    const [doctor] = await User.findOrCreate({
      where: { email: 'ahmed.hassan@cdc.com' },
      defaults: {
        firstName: 'Ahmed',
        lastName: 'Hassan',
        email: 'ahmed.hassan@cdc.com',
        password,
        role: 'doctor',
        phone: '+254700000002',
        isActive: true,
      },
    });
    console.log(`Doctor: ${doctor.email}`);

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
    console.log('DoctorProfile created/found.');

    // ── 3. Staff ──────────────────────────────────────────────────────────────
    const [staff] = await User.findOrCreate({
      where: { email: 'staff@cdc.com' },
      defaults: {
        firstName: 'Sarah',
        lastName: 'Kamau',
        email: 'staff@cdc.com',
        password,
        role: 'staff',
        phone: '+254700000003',
        isActive: true,
      },
    });
    console.log(`Staff: ${staff.email}`);

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
    console.log('StaffProfile created/found.');

    // ── 4. Lab Tech ───────────────────────────────────────────────────────────
    const [lab] = await User.findOrCreate({
      where: { email: 'lab@cdc.com' },
      defaults: {
        firstName: 'James',
        lastName: 'Otieno',
        email: 'lab@cdc.com',
        password,
        role: 'lab',
        phone: '+254700000004',
        isActive: true,
      },
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
    console.log('LabTechProfile created/found.');

    // ── 5. Patient user ───────────────────────────────────────────────────────
    const [patientUser] = await User.findOrCreate({
      where: { email: 'patient@cdc.com' },
      defaults: {
        firstName: 'John',
        lastName: 'Doe',
        email: 'patient@cdc.com',
        password,
        role: 'patient',
        phone: '+254700000005',
        isActive: true,
      },
    });
    console.log(`Patient user: ${patientUser.email}`);

    // ── 6. Patient record linked to patient user and doctor ───────────────────
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
        diabetesType: 'Type 2',
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
    console.log('Patient record created/found.');

    console.log('\n✅ Seed complete. Test credentials:');
    console.log('  Admin:   admin@cdc.com       / password123');
    console.log('  Doctor:  ahmed.hassan@cdc.com / password123');
    console.log('  Staff:   staff@cdc.com        / password123');
    console.log('  Lab:     lab@cdc.com          / password123');
    console.log('  Patient: patient@cdc.com      / password123');

    process.exit(0);
  } catch (err) {
    console.error('Seed failed:', err.message);
    process.exit(1);
  }
}

seed();
