// Histopathology request (1 Nov 2026, Emu): one request, several specimens,
// one requisition, no price. Real database (throwaway only).
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
require('dotenv').config({ quiet: true });

require('./_guard').assertThrowawayDb('histopathology request test');

const db = require('../models');
const histology = require('../controllers/histologyController');

const { Patient, User, LabTest, HistologyRequest } = db;
const TAG = 'TST-HPR';

const call = (fn, { user, body = {}, params = {}, query = {} } = {}) => new Promise((resolve) => {
  const res = { statusCode: 200 };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => resolve({ status: res.statusCode, body: b });
  fn({ user, body, params, query, headers: {}, ip: '127.0.0.1' }, res);
});

let doctor, patient;
const asUser = (u) => ({ id: u.id, role: u.role, permissions: [], deniedPermissions: [], firstName: u.firstName, lastName: u.lastName });

before(async () => {
  await db.sequelize.authenticate();
  const old = await Patient.findAll({ where: { uhid: `${TAG}-1` } });
  for (const p of old) {
    const rows = await HistologyRequest.findAll({ where: { PatientId: p.id } });
    await LabTest.destroy({ where: { id: rows.map((r) => r.LabTestId).filter(Boolean) } });
    await HistologyRequest.destroy({ where: { PatientId: p.id } });
    await p.destroy();
  }
  await User.destroy({ where: { email: 'hpr-doctor@cdc.test' } });
  doctor = await User.create({ firstName: 'Ebrahim', lastName: 'Yusuf', email: 'hpr-doctor@cdc.test', password: 'x', role: 'doctor', isActive: true });
  patient = await Patient.create({ uhid: `${TAG}-1`, firstName: TAG, lastName: 'Patient' });
});

after(async () => {
  const rows = await HistologyRequest.findAll({ where: { PatientId: patient.id } });
  await LabTest.destroy({ where: { id: rows.map((r) => r.LabTestId).filter(Boolean) } });
  await HistologyRequest.destroy({ where: { PatientId: patient.id } });
  await patient.destroy();
  await doctor.destroy();
  await db.sequelize.close();
});

describe('one request, several specimens', () => {
  test('a CNB and an FNAC → one requisition, two numbered specimens, two unpriced lab lines', async () => {
    const r = await call(histology.createRequest, {
      user: asUser(doctor), params: { uhid: patient.uhid },
      body: {
        clinicalDetails: 'Right lobe TR5 nodule; ipsilateral node. Bethesda please.',
        sendTo: 'Lancet Kenya — Histopathology', priority: 'Urgent', relevantHistory: 'No previous surgery',
        specimens: [
          { kind: 'histology', siteType: 'thyroid', thyroidLobe: 'right', noduleLabel: 'R2', tirads: 'TR5', specimenType: 'core_needle', pieces: 2, fixative: 'formalin' },
          { kind: 'cytology', siteType: 'lymph_node', siteText: 'Right level III, 14 mm', specimenType: 'fnac', fixative: 'slides' },
        ],
      },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const { requisitionNumber, specimens } = r.body.data;
    assert.ok(requisitionNumber);
    assert.equal(specimens.length, 2);
    assert.deepEqual(specimens.map((s) => s.kind), ['histology', 'cytology']);
    assert.match(specimens[0].specimenNumber, /^HP/);
    assert.match(specimens[1].specimenNumber, /^CY/);
    assert.ok(specimens.every((s) => s.requisitionNumber === requisitionNumber && s.priority === 'Urgent' && s.relevantHistory === 'No previous surgery'));

    const labs = await LabTest.findAll({ where: { requisitionNumber }, order: [['id', 'ASC']] });
    assert.deepEqual(labs.map((l) => l.testType), ['Histopathology', 'Cytology']);
    assert.ok(labs.every((l) => l.price === null && l.status === 'Pending' && l.priority === 'Urgent'));
  });

  test('a bad second specimen saves nothing', async () => {
    const before = await HistologyRequest.count({ where: { PatientId: patient.id } });
    const r = await call(histology.createRequest, {
      user: asUser(doctor), params: { uhid: patient.uhid },
      body: { clinicalDetails: 'x', specimens: [
        { kind: 'histology', siteType: 'thyroid', thyroidLobe: 'left', specimenType: 'core_needle' },
        { kind: 'cytology', siteType: 'other', specimenType: 'fluid' },
      ] },
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.field, 'specimens.1.siteText');
    assert.equal(await HistologyRequest.count({ where: { PatientId: patient.id } }), before);
  });

  test('the single-specimen request still works, on a requisition of its own, unpriced', async () => {
    const r = await call(histology.create, {
      user: asUser(doctor), params: { uhid: patient.uhid },
      body: { kind: 'cytology', siteType: 'thyroid', thyroidLobe: 'left', specimenType: 'fnac', clinicalDetails: 'Left TR4' },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok(r.body.data.requisitionNumber);
    const lab = await LabTest.findByPk(r.body.data.labTest.id);
    assert.equal(lab.price, null);
  });

  test('the patient list carries each specimen\'s request', async () => {
    const r = await call(histology.listForPatient, { user: asUser(doctor), params: { uhid: patient.uhid } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const list = Array.isArray(r.body.data) ? r.body.data : (r.body.data.requests || []);
    const byReq = new Map();
    for (const s of list) byReq.set(s.requisitionNumber, (byReq.get(s.requisitionNumber) || 0) + 1);
    assert.deepEqual([...byReq.values()].sort(), [1, 2]);
  });
});
