#!/usr/bin/env node
'use strict';

// End-to-end smoke test for triage timestamps & attribution, against a REAL
// database and the REAL HTTP API. Not a unit test: it seeds a nurse, a doctor
// and a patient, then walks the nursing flow and asserts what the queue row and
// vitals rows look like afterwards.
//
//   node scripts/smoke-triage-attribution.js            (server on $PORT or 3000)
//   API_URL=http://localhost:3005 node scripts/smoke-triage-attribution.js
//
// Refuses to run when NODE_ENV=production. Cleans up its own rows.

require('dotenv').config();
const assert = require('assert/strict');
const bcrypt = require('bcryptjs');
const db = require('../models');
const { User, Patient, Queue, PatientVital } = db;

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to run the smoke test against production.');
  process.exit(1);
}

const API = process.env.API_URL || `http://localhost:${process.env.PORT || 3000}`;
const TAG = '__SMOKE_TRIAGE__';

const call = async (method, path, token, body) => {
  const res = await fetch(`${API}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ...json };
};

const login = async (email) => {
  const r = await call('POST', '/auth/login', null, { email, password: 'smoke123' });
  assert.equal(r.success, true, `login failed for ${email}: ${r.message}`);
  return r.data.token || r.token;
};

const cleanup = async () => {
  const users = await User.findAll({ where: { email: [`${TAG}nurse@cdc.local`, `${TAG}doctor@cdc.local`] } });
  const patient = await Patient.findOne({ where: { uhid: `${TAG}UHID` } });
  if (patient) {
    await PatientVital.destroy({ where: { PatientId: patient.id } });
    await Queue.destroy({ where: { PatientId: patient.id } });
    await patient.destroy();
  }
  for (const u of users) await u.destroy();
};

(async () => {
  let passed = 0;
  const ok = (msg) => { passed++; console.log('  ✓', msg); };

  await cleanup();
  const hash = await bcrypt.hash('smoke123', 10);
  const nurse  = await User.create({ email: `${TAG}nurse@cdc.local`,  password: hash, role: 'nurse',  firstName: 'Smoke', lastName: 'Nurse',  isActive: true });
  const doctor = await User.create({ email: `${TAG}doctor@cdc.local`, password: hash, role: 'doctor', firstName: 'Smoke', lastName: 'Doctor', isActive: true });
  const patient = await Patient.create({ uhid: `${TAG}UHID`, firstName: 'Smoke', lastName: 'Patient', gender: 'Female', dateOfBirth: '1980-01-01', phone: '0700000000' });

  const nurseTok  = await login(nurse.email);
  const doctorTok = await login(doctor.email);

  // ── 1. Normal flow: Awaiting Triage → In Triage → vitals → Awaiting Doctor ──
  console.log('\nNormal nursing flow');
  let q = await Queue.create({ PatientId: patient.id, status: 'Awaiting Triage', priority: 'Normal', addedBy: 'smoke' });

  let r = await call('PUT', `/queue/${q.id}`, nurseTok, { status: 'In Triage' });
  assert.equal(r.success, true, r.message);
  await q.reload();
  assert.equal(q.status, 'In Triage');
  assert.ok(q.triageStartTime, 'triageStartTime stamped on In Triage');
  assert.equal(q.triagedBy, 'Smoke Nurse');
  ok('opening triage stamps triageStartTime + triagedBy from the JWT');

  const startTime = q.triageStartTime;
  r = await call('POST', `/patients/${patient.uhid}/vitals`, nurseTok, {
    bp: '120/80', heartRate: 72, temperature: 36.6, weight: 70, height: 170,
    recordedById: 999999,           // must be ignored — attribution is from the JWT
  });
  assert.equal(r.status, 201, r.message);
  assert.equal(r.data.recordedBy, 'Smoke Nurse');
  assert.equal(r.data.recordedById, nurse.id);
  ok('vitals response names the nurse; a client-supplied recordedById is ignored');

  await q.reload();
  assert.ok(q.triageEndTime, 'triageEndTime stamped on vitals save');
  assert.equal(String(q.triageStartTime), String(startTime), 'triageStartTime untouched');
  assert.equal(q.status, 'In Triage', 'saving vitals does not change status');
  const endTime = q.triageEndTime;
  ok('saving vitals stamps triageEndTime, leaves status and start alone');

  // second triage — same visit — must not move triageEndTime
  await new Promise((res) => setTimeout(res, 1100));
  r = await call('POST', `/patients/${patient.uhid}/vitals`, nurseTok, { bp: '118/78', heartRate: 70, temperature: 36.5 });
  assert.equal(r.status, 201, r.message);
  await q.reload();
  assert.equal(String(q.triageEndTime), String(endTime), 'second triage does not move triageEndTime');
  ok('a second triage keeps the first triageEndTime');

  r = await call('PUT', `/queue/${q.id}`, nurseTok, { status: 'Awaiting Doctor', assignedDoctorId: doctor.id });
  assert.equal(r.success, true, r.message);
  await q.reload();
  assert.ok(q.sentToDoctorAt, 'sentToDoctorAt stamped on nurse → doctor');
  assert.equal(String(q.triageEndTime), String(endTime), 'leaving In Triage does not overwrite triageEndTime');
  const sentAt = q.sentToDoctorAt;
  ok('sending to doctor stamps sentToDoctorAt and preserves triageEndTime');

  // "add to bill" merge — Awaiting Doctor → Awaiting Doctor — must not re-stamp
  await new Promise((res) => setTimeout(res, 1100));
  r = await call('PUT', `/queue/${q.id}`, nurseTok, { status: 'Awaiting Doctor', selectedCharges: ['Nursing fee'] });
  assert.equal(r.success, true, r.message);
  await q.reload();
  assert.equal(String(q.sentToDoctorAt), String(sentAt));
  ok('re-sending Awaiting Doctor (add-to-bill merge) does not re-stamp sentToDoctorAt');

  // doctor referral: With Doctor → Awaiting Doctor via update() must NOT stamp
  await q.update({ status: 'With Doctor', sentToDoctorAt: null });
  r = await call('PUT', `/queue/${q.id}`, doctorTok, { status: 'Awaiting Doctor' });
  assert.equal(r.success, true, r.message);
  await q.reload();
  assert.equal(q.sentToDoctorAt, null);
  ok('With Doctor → Awaiting Doctor (doctor-side) does not stamp sentToDoctorAt');

  // history endpoint carries the new fields
  r = await call('GET', `/queue/patient/${patient.uhid}`, doctorTok);
  assert.equal(r.success, true, r.message);
  const visit = r.data.visits.find((v) => v.id === q.id);
  assert.equal(visit.triagedBy, 'Smoke Nurse');
  assert.ok(visit.triageEndTime);
  assert.ok('sentToDoctorAt' in visit);
  ok('GET /queue/patient/:uhid returns triagedBy, triageEndTime, sentToDoctorAt');

  r = await call('GET', `/patients/${patient.uhid}/vitals/history`, doctorTok);
  assert.equal(r.success, true, r.message);
  assert.equal(r.data.length, 2);
  assert.ok(r.data.every((v) => v.recordedBy === 'Smoke Nurse'));
  ok('vitals history names the recording clinician on every row');

  r = await call('GET', `/patients/${patient.uhid}/vitals`, doctorTok);
  assert.equal(r.data.recordedBy, 'Smoke Nurse');
  ok('latest vitals names the recording clinician');

  // ── 2. Doctor completing vitals: attributed, but not triage ─────────────
  console.log('\nDoctor-side vitals');
  await q.update({ status: 'With Doctor', triageEndTime: null });
  r = await call('POST', `/patients/${patient.uhid}/vitals/doctor`, doctorTok, { weight: 71 });
  assert.equal(r.status, 201, r.message);
  assert.equal(r.data.recordedBy, 'Smoke Doctor');
  await q.reload();
  assert.equal(q.triageEndTime, null, 'doctor vitals do not stamp triage');
  ok('doctor vitals are attributed to the doctor and do not touch the queue');

  // ── 3. Injection return: Pending Injection is not flipped, but end + dispatch stamp ──
  console.log('\nInjection return');
  await q.update({ status: 'Completed' });
  const q2 = await Queue.create({ PatientId: patient.id, status: 'Pending Injection', priority: 'Normal', addedBy: 'smoke', reason: 'For GLP-1 injection' });
  r = await call('POST', `/patients/${patient.uhid}/vitals`, nurseTok, { bp: '121/79', heartRate: 74, temperature: 36.7 });
  assert.equal(r.status, 201, r.message);
  await q2.reload();
  assert.equal(q2.status, 'Pending Injection', 'status untouched');
  assert.ok(q2.triageEndTime, 'triageEndTime stamped');
  assert.equal(q2.triageStartTime, null, 'no invented start time');
  assert.equal(q2.triagedBy, 'Smoke Nurse');
  ok('vitals on an injection return stamp end + triagedBy, never a fake start');

  r = await call('PUT', `/queue/${q2.id}`, nurseTok, { status: 'Awaiting Doctor', assignedDoctorId: doctor.id });
  await q2.reload();
  assert.ok(q2.sentToDoctorAt);
  ok('Pending Injection → Awaiting Doctor stamps sentToDoctorAt');

  // ── 4. Merge-awareness: vitals saved against a merged duplicate stamp the live row ──
  console.log('\nMerged patient');
  const dup = await Patient.create({ uhid: `${TAG}UHID-DUP`, firstName: 'Smoke', lastName: 'Dup', gender: 'Female', dateOfBirth: '1980-01-01', phone: '0700000001', mergedIntoId: patient.id });
  await q2.update({ status: 'Completed' });
  const q3 = await Queue.create({ PatientId: dup.id, status: 'Awaiting Triage', priority: 'Normal', addedBy: 'smoke' });
  r = await call('POST', `/patients/${patient.uhid}/vitals`, nurseTok, { bp: '122/80', heartRate: 75, temperature: 36.6 });
  assert.equal(r.status, 201, r.message);
  await q3.reload();
  assert.ok(q3.triageEndTime, 'queue row on the merged duplicate is found and stamped');
  ok('queue lookup is merge-aware across the patient family');
  await Queue.destroy({ where: { PatientId: dup.id } });
  await dup.destroy();

  await cleanup();
  console.log(`\n${passed} checks passed.`);
  process.exit(0);
})().catch(async (err) => {
  console.error('\n✗', err.message);
  await cleanup().catch(() => {});
  process.exit(1);
});
