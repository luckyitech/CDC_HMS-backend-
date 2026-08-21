const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// =====================================================================
// The patient access log records WHO OPENED a clinical record.
//
// These are logic tests with a stub model — the behaviour that matters here is
// which calls produce a row and which do not, and that is decided entirely in
// the middleware. The database shape is exercised separately by running the
// migration against a real MySQL/MariaDB.
// =====================================================================

const load = (captured) => {
  // Fresh module each time, with the models module stubbed, so the middleware
  // captures the stub at require time exactly as it captures the real model.
  const modelsPath = require.resolve('../models');
  const mwPath = require.resolve('../middleware/logPatientAccess');
  const realModels = require.cache[modelsPath];
  require.cache[modelsPath] = {
    id: modelsPath, filename: modelsPath, loaded: true,
    exports: { PatientAccessLog: { create: async (row) => { captured.push(row); } } },
  };
  delete require.cache[mwPath];
  const mw = require('../middleware/logPatientAccess');
  delete require.cache[mwPath];
  if (realModels) require.cache[modelsPath] = realModels; else delete require.cache[modelsPath];
  return mw;
};

const call = async (mw, section, req) => {
  let passed = false;
  mw(section)(req, {}, () => { passed = true; });
  await new Promise((r) => setImmediate(r));
  return passed;
};

const REQ = (over = {}) => ({
  user: { id: 14, name: 'A Nurse', role: 'staff' },
  patient: { id: 412, uhid: '00412' },
  query: {}, method: 'GET',
  originalUrl: '/api/consultation-notes?uhid=00412', ip: '10.0.0.9',
  ...over,
});

describe('the patient access log', () => {
  test('records who opened the record, and what', async () => {
    const rows = []; const mw = load(rows);
    await call(mw, 'consultation-notes', REQ());
    assert.equal(rows.length, 1);
    assert.equal(rows[0].userName, 'A Nurse');
    assert.equal(rows[0].userRole, 'staff');
    assert.equal(rows[0].section, 'consultation-notes');
    assert.equal(rows[0].patientId, 412);
  });

  test('never delays or blocks the request', async () => {
    // An audit log that can take the clinic offline is a worse problem than a
    // missing row, so next() is called before anything is written and a write
    // that throws is swallowed.
    const mw = load([]);
    const modelsPath = require.resolve('../models');
    const mwPath = require.resolve('../middleware/logPatientAccess');
    const real = require.cache[modelsPath];
    require.cache[modelsPath] = {
      id: modelsPath, filename: modelsPath, loaded: true,
      exports: { PatientAccessLog: { create: async () => { throw new Error('db down'); } } },
    };
    delete require.cache[mwPath];
    const failing = require('../middleware/logPatientAccess');
    delete require.cache[mwPath];
    if (real) require.cache[modelsPath] = real; else delete require.cache[modelsPath];

    assert.equal(await call(failing, 'vitals', REQ()), true,
      'the handler must still run when the log cannot be written');
  });

  test('does not log a patient reading their own record', async () => {
    // Every patient opens their own file constantly. Recording it would bury
    // the entries that matter under noise from the person the log protects.
    const rows = []; const mw = load(rows);
    await call(mw, 'blood-sugar', REQ({ user: { id: 9, name: 'P', role: 'patient' } }));
    assert.equal(rows.length, 0);
  });

  test('logs the administrator like everyone else', async () => {
    // The admin holds every capability implicitly, which makes it the account
    // most worth recording, not the one to excuse.
    const rows = []; const mw = load(rows);
    await call(mw, 'treatment-plans', REQ({ user: { id: 1, name: 'System Admin', role: 'admin' } }));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].userRole, 'admin');
  });

  test('logs by uhid when the route never resolves a patient row', async () => {
    // The collection routes filter by a query parameter and have no
    // req.patient. Storing null for the id is honest; a 0 would read as a real
    // foreign key and would eventually be joined against something.
    const rows = []; const mw = load(rows);
    await call(mw, 'glp1', REQ({ patient: null, query: { uhid: '00412' } }));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].patientId, null);
    assert.equal(rows[0].uhid, '00412');
  });

  test('writes nothing when there is no patient to name', async () => {
    // A row with no subject cannot answer the only question this table exists
    // to answer, so it is not worth storing.
    const rows = []; const mw = load(rows);
    await call(mw, 'glp1', REQ({ patient: null, query: {} }));
    assert.equal(rows.length, 0);
  });

  test('strips the query string from the recorded path', async () => {
    // The query can carry a uhid and, in future, filters. The path is for
    // tracing an entry back to a request, not for storing a second copy of the
    // parameters.
    const rows = []; const mw = load(rows);
    await call(mw, 'glp1', REQ());
    assert.equal(rows[0].path, '/api/consultation-notes');
  });
});
