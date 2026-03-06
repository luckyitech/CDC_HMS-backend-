const http = require('http');

function request(method, path, token = null, body = null) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const bodyStr = body ? JSON.stringify(body) : null;
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);

    const req = http.request(
      { hostname: 'localhost', port: 3000, path, method, headers },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, data }); }
        });
      }
    );
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function result(label, res) {
  const ok = res.data?.success;
  const icon = ok ? '✅' : '❌';
  const detail = ok ? '' : ` → ${res.data?.message || JSON.stringify(res.data).slice(0, 80)}`;
  console.log(`  ${icon} ${label}${detail}`);
}

async function run() {
  console.log('\n========== CDC HMS API — Full Route Test ==========\n');

  // ─── LOGIN ─────────────────────────────────────────
  console.log('── AUTH ──');
  const health = await request('GET', '/api/health');
  result('GET  /api/health', health);

  const adminLogin = await request('POST', '/api/auth/login', null, { email: 'admin@cdc.com', password: 'password123', role: 'admin' });
  result('POST /api/auth/login (admin)', adminLogin);
  const ADMIN = adminLogin.data?.data?.token;

  const doctorLogin = await request('POST', '/api/auth/login', null, { email: 'ahmed.hassan@cdc.com', password: 'password123', role: 'doctor' });
  result('POST /api/auth/login (doctor)', doctorLogin);
  const DOCTOR = doctorLogin.data?.data?.token;

  const staffLogin = await request('POST', '/api/auth/login', null, { email: 'staff@cdc.com', password: 'password123', role: 'staff' });
  result('POST /api/auth/login (staff)', staffLogin);
  const STAFF = staffLogin.data?.data?.token;

  result('GET  /api/auth/me', await request('GET', '/api/auth/me', ADMIN));

  if (!ADMIN || !DOCTOR || !STAFF) {
    console.log('\n⚠️  Could not get all tokens. Stopping.\n');
    return;
  }

  // ─── GET UHID ──────────────────────────────────────
  const patients = await request('GET', '/api/patients', ADMIN);
  const UHID = patients.data?.data?.patients?.[0]?.uhid || 'CDC001';
  console.log(`\n  (Using UHID: ${UHID} for parameterised tests)\n`);

  // ─── PATIENTS ──────────────────────────────────────
  console.log('── PATIENTS ──');
  result('GET  /api/patients (admin)', patients);
  result('GET  /api/patients/:uhid (admin)', await request('GET', `/api/patients/${UHID}`, ADMIN));

  // ─── QUEUE ─────────────────────────────────────────
  console.log('\n── QUEUE ──');
  result('GET  /api/queue (staff)', await request('GET', '/api/queue', STAFF));
  result('GET  /api/queue/stats (staff)', await request('GET', '/api/queue/stats', STAFF));

  // ─── PRESCRIPTIONS ─────────────────────────────────
  console.log('\n── PRESCRIPTIONS ──');
  result('GET  /api/prescriptions (doctor)', await request('GET', '/api/prescriptions', DOCTOR));

  // ─── LAB TESTS ─────────────────────────────────────
  console.log('\n── LAB TESTS ──');
  result('GET  /api/lab-tests (doctor)', await request('GET', '/api/lab-tests', DOCTOR));

  // ─── TREATMENT PLANS ───────────────────────────────
  console.log('\n── TREATMENT PLANS ──');
  result(`GET  /api/treatment-plans?uhid=${UHID} (doctor)`, await request('GET', `/api/treatment-plans?uhid=${UHID}`, DOCTOR));

  // ─── PHYSICAL EXAMS ────────────────────────────────
  console.log('\n── PHYSICAL EXAMS ──');
  result(`GET  /api/physical-exams?uhid=${UHID} (doctor)`, await request('GET', `/api/physical-exams?uhid=${UHID}`, DOCTOR));

  // ─── ASSESSMENTS ───────────────────────────────────
  console.log('\n── ASSESSMENTS ──');
  result(`GET  /api/assessments?uhid=${UHID} (doctor)`, await request('GET', `/api/assessments?uhid=${UHID}`, DOCTOR));

  // ─── CONSULTATION NOTES ────────────────────────────
  console.log('\n── CONSULTATION NOTES ──');
  result(`GET  /api/consultation-notes?uhid=${UHID} (doctor)`, await request('GET', `/api/consultation-notes?uhid=${UHID}`, DOCTOR));

  // ─── APPOINTMENTS ──────────────────────────────────
  console.log('\n── APPOINTMENTS ──');
  result('GET  /api/appointments (admin)', await request('GET', '/api/appointments', ADMIN));

  // ─── USERS ─────────────────────────────────────────
  console.log('\n── USERS ──');
  result('GET  /api/users (admin)', await request('GET', '/api/users', ADMIN));

  // ─── DOCUMENTS ─────────────────────────────────────
  console.log('\n── DOCUMENTS ──');
  result('GET  /api/documents (doctor)', await request('GET', '/api/documents', DOCTOR));

  // ─── REPORTS ───────────────────────────────────────
  console.log('\n── REPORTS ──');
  result('GET  /api/reports/types (admin)', await request('GET', '/api/reports/types', ADMIN));
  result('GET  /api/reports/clinic-overview (admin)', await request('GET', '/api/reports/clinic-overview', ADMIN));
  result('GET  /api/reports/high-risk-patients (admin)', await request('GET', '/api/reports/high-risk-patients', ADMIN));
  result(`GET  /api/reports/glycemic?uhid=${UHID} (admin)`, await request('GET', `/api/reports/glycemic?uhid=${UHID}`, ADMIN));
  result(`GET  /api/reports/patient-summary?uhid=${UHID} (admin)`, await request('GET', `/api/reports/patient-summary?uhid=${UHID}`, ADMIN));
  result(`GET  /api/reports/medication-adherence?uhid=${UHID} (admin)`, await request('GET', `/api/reports/medication-adherence?uhid=${UHID}`, ADMIN));

  // ─── DASHBOARD ─────────────────────────────────────
  console.log('\n── DASHBOARD ──');
  result('GET  /api/dashboard (admin)', await request('GET', '/api/dashboard', ADMIN));
  result('GET  /api/dashboard (doctor)', await request('GET', '/api/dashboard', DOCTOR));
  result('GET  /api/dashboard (staff)', await request('GET', '/api/dashboard', STAFF));

  // ─── AUTH GUARDS (should fail) ─────────────────────
  console.log('\n── AUTH GUARDS (expect ❌ = working correctly) ──');
  const noToken = await request('GET', '/api/patients');
  console.log(`  ${noToken.data?.success === false ? '✅' : '❌'} GET /api/patients without token → blocked (${noToken.data?.message})`);
  const wrongRole = await request('GET', '/api/queue', ADMIN); // admin not allowed
  console.log(`  ${wrongRole.data?.success === false ? '✅' : '❌'} GET /api/queue as admin → blocked (${wrongRole.data?.message})`);

  console.log('\n===================================================\n');
}

run().catch(console.error);
