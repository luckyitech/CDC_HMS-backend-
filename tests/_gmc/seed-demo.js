// Seeds the scratch DB with a doctor, a nurse, a patient and ~14 days of meter
// readings so the frontend can be exercised end to end. Manual, not CI.
require('dotenv').config({ path: '.env.test', override: true });
const bcrypt = require('bcryptjs');
const db = require('../../models');
(async () => {
  await db.sequelize.sync({ force: true });
  const pw = await bcrypt.hash('local123', 10);
  const doctor = await db.User.create({ firstName: 'Ebrahim', lastName: 'Yusuf', email: 'local.doctor@cdc.local', password: pw, role: 'doctor', isActive: true, passwordChangedAt: new Date() });
  const nurse  = await db.User.create({ firstName: 'Amina', lastName: 'Wanjiru', email: 'local.nurse@cdc.local', password: pw, role: 'nurse', isActive: true, passwordChangedAt: new Date() });
  const p = await db.Patient.create({ uhid: 'CDC001', firstName: 'John', lastName: 'Doe', gender: 'Male', phone: '0700000000', dateOfBirth: '1980-03-04', diabetesType: 'Type 2', status: 'Active', registrationComplete: true });
  await db.PatientVital.create({ PatientId: p.id, bp: '132/84', heartRate: 78, temperature: 36.6, weight: 84.2, height: 172, rbs: 9.4, hba1c: 7.9, recordedById: nurse.id, recordedAt: new Date() });
  const meter = await db.PatientMeter.create({ PatientId: p.id, deviceSerial: '13504545', deviceModel: 'Accu-Chek Instant', deviceModelId: '973', firmware: 'v7.1.6', status: 'Active', firstLinkedAt: new Date(), linkedById: nurse.id, lastSequenceNumber: 60, lastSyncAt: new Date(), lastClockDeltaSec: 10920 });
  let seed = 7; const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const norm = (m, s) => m + s * Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
  const rows = []; let seq = 1;
  const now = new Date();
  for (let d = 20; d >= 0; d--) for (const [h, mi, m, s, tag] of [[6, 30, 124, 20, 'fasting'], [9, 30, 172, 36, 'morning'], [13, 0, 137, 30, 'midday'], [18, 40, 142, 30, 'evening'], [22, 0, 160, 38, 'bedtime']]) {
    if (rnd() < 0.2) continue;
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - d);
    const at = new Date(Date.UTC(day.getFullYear(), day.getMonth(), day.getDate(), h, mi + Math.round(norm(0, 10))));
    if (at > new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes()))) continue;
    let mg = Math.round(norm(m, s)); if (rnd() < 0.03) mg = 55 + Math.round(rnd() * 12); mg = Math.max(40, Math.min(400, mg));
    rows.push({ PatientId: p.id, PatientMeterId: meter.id, deviceSerial: '13504545', sequenceNumber: seq++, measuredAt: at, timeOffsetMin: 0, glucoseMgdl: mg, unitsReported: 'kg/L', sampleType: 8, sampleLocation: 15, sensorStatus: 0, contextTag: tag, contextSource: 'clock', importBatchId: d > 3 ? 'b-demo-1' : 'b-demo-2', importedById: nurse.id, importedByRole: 'clinic', hostClockDeltaSec: 10920, status: 'Active' });
  }
  rows.push({ PatientId: p.id, PatientMeterId: meter.id, deviceSerial: '13504545', sequenceNumber: seq++, measuredAt: new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() - 1, 6, 40)), glucoseMgdl: 16, unitsReported: 'kg/L', sampleType: 8, sampleLocation: 15, sensorStatus: 0, contextTag: 'fasting', contextSource: 'clock', importBatchId: 'b-demo-2', importedById: nurse.id, importedByRole: 'clinic', hostClockDeltaSec: 10920, status: 'Excluded', excludeReason: 'Flagged at import (implausible value)', excludedById: nurse.id, excludedAt: new Date() });
  await db.GlucoseMeterReading.bulkCreate(rows);
  for (let d = 12; d > 8; d--) { const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - d); const ds = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
    await db.BloodSugarReading.create({ PatientId: p.id, date: ds, timeSlot: 'fasting', value: 128, time: '6:45 AM', recordedByRole: 'patient' });
    await db.BloodSugarReading.create({ PatientId: p.id, date: ds, timeSlot: 'beforeDinner', value: 150, time: '6:30 PM', recordedByRole: 'patient' }); }
  console.log('seeded', rows.length, 'meter rows; doctor', doctor.email);
  await db.sequelize.close();
})().catch((e) => { console.error(e); process.exit(1); });
