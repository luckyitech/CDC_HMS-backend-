// End-to-end exercise of /api/patients/:uhid/glucose/* against a scratch
// MariaDB. Not a CI test (the project has none) — a manual smoke run:
//   node tests/_gmc/api.test.js      (needs .env.test → an empty database)
require('dotenv').config({ path: '.env.test', override: true });
process.env.JWT_EXPIRES_IN = '1h';
const jwt = require('jsonwebtoken');
const db = require('../../models');
const app = require('../../app');

const PORT = 3999;
const base = `http://127.0.0.1:${PORT}/api`;
let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`); if (!ok) failures++; };

const call = async (token, method, path, body) => {
  const r = await fetch(base + path, {
    method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, ...(json || {}) };
};

const meterRow = (seq, at, mgdl, extra = {}) => ({
  sequenceNumber: seq, measuredAt: at, timeOffsetMin: 0, glucoseMgdl: mgdl, unitsReported: 'kg/L',
  sampleType: 8, sampleLocation: 15, sensorStatus: 0, rawHex: '0b', ...extra,
});

(async () => {
  await db.sequelize.sync({ force: true });
  const mkUser = (role, i) => db.User.create({ firstName: role, lastName: `Test${i}`, email: `${role}${i}@cdc.local`, password: 'x', role, isActive: true, passwordChangedAt: new Date() });
  const nurse  = await mkUser('nurse', 1);
  const doctor = await mkUser('doctor', 2);
  const pA = await db.Patient.create({ uhid: 'CDC-A', firstName: 'Alpha', lastName: 'Test', gender: 'Female', phone: '1', dateOfBirth: '1980-01-01' });
  const pB = await db.Patient.create({ uhid: 'CDC-B', firstName: 'Beta',  lastName: 'Test', gender: 'Male',   phone: '2', dateOfBirth: '1970-01-01' });
  // a merged duplicate of A — reads must include it
  const pA2 = await db.Patient.create({ uhid: 'CDC-A2', firstName: 'Alpha', lastName: 'Dup', gender: 'Female', phone: '3', dateOfBirth: '1980-01-01', mergedIntoId: pA.id });
  await db.BloodSugarReading.create({ PatientId: pA2.id, date: '2026-09-10', timeSlot: 'fasting', value: 110, recordedByRole: 'patient' });
  await db.PatientVital.create({ PatientId: pA.id, bp: '120/80', heartRate: 70, temperature: 36.6, rbs: 9.4, hba1c: 7.9, recordedAt: new Date('2026-09-12T09:41:00Z') });

  const tok = (u) => jwt.sign({ id: u.id, email: u.email, role: u.role, name: 'x' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const N = tok(nurse), D = tok(doctor);
  const server = app.listen(PORT);
  try {
    const device = { serial: '13504545', modelId: '973', firmware: 'v7.1.6', name: 'meter+13504545' };

    // 1. preflight on an unknown meter
    let r = await call(N, 'POST', '/patients/CDC-A/glucose/meter/preflight', { name: 'meter+13504545', modelId: '973' });
    check('preflight unlinked', r.status === 200 && r.data.link === 'unlinked' && r.data.serial === '13504545' && r.data.modelName === 'Accu-Chek Instant', JSON.stringify(r.data?.link));

    // 2. import without confirming the link → 409
    const readings = [
      meterRow(2, '2024-02-12 19:58:10', 118), meterRow(3, '2025-04-11 07:18:36', 152),
      meterRow(4, '2025-04-11 07:22:12', 116), meterRow(5, '2026-09-12 09:31:00', 16),
      meterRow(6, '2026-09-11 22:15:00', 610, { sensorStatus: 0x20 }), meterRow(7, '2026-09-10 06:40:00', 60),
      meterRow(8, '2026-09-09 12:00:00', 200, { sampleType: 10 }),
    ];
    r = await call(N, 'POST', '/patients/CDC-A/glucose/meter/import', { device, readings, hostTime: '2026-09-12 12:36:00', meterTime: '2026-09-12 09:34:00' });
    check('import refuses unlinked', r.status === 409 && r.code === 'METER_UNLINKED', String(r.status));
    r = await call(N, 'POST', '/patients/CDC-A/glucose/meter/import', { device, readings: [], hostTime: '2026-09-12 12:36:00', meterTime: '2026-09-12 09:34:00' });
    check('empty meter, unlinked: nothingNew, no link created', r.status === 200 && r.data.nothingNew === true && r.data.linked === false && r.data.meter === null, JSON.stringify(r.data));

    // 3. link + import, flagging the 16 mg/dL row
    r = await call(N, 'POST', '/patients/CDC-A/glucose/meter/import', { device, readings, hostTime: '2026-09-12 12:36:00', meterTime: '2026-09-12 09:34:00', link: { action: 'link' }, excludeSequenceNumbers: [5] });
    check('import links + inserts', r.status === 201 && r.data.inserted === 7 && r.data.excluded === 1 && r.data.duplicates === 0, JSON.stringify(r.data && { i: r.data.inserted, e: r.data.excluded, d: r.data.duplicates }));
    check('clock delta recorded', r.data?.clockDeltaSec === 3 * 3600 + 120 && r.data.clockDriftWarn === true, String(r.data?.clockDeltaSec));
    check('meter linked', r.data?.meter?.status === 'Active' && r.data.meter.lastSequenceNumber === 8);

    // 4. second download → all duplicates, preflight says linked + lastSeq
    r = await call(N, 'POST', '/patients/CDC-A/glucose/meter/preflight', { serial: '13504545' });
    check('preflight linked + lastSeq', r.data?.link === 'linked' && r.data.lastSequenceNumber === 8, JSON.stringify([r.data?.link, r.data?.lastSequenceNumber]));
    r = await call(N, 'POST', '/patients/CDC-A/glucose/meter/import', { device, readings: readings.slice(0, 3), hostTime: '2026-09-12 12:40:00', meterTime: '2026-09-12 09:38:00' });
    check('re-import is idempotent', r.status === 201 && r.data.inserted === 0 && r.data.duplicates === 3);
    r = await call(N, 'POST', '/patients/CDC-A/glucose/meter/import', { device, readings: [], hostTime: '2026-09-12 12:45:00', meterTime: '2026-09-12 09:43:00' });
    check('nothing new on a linked meter records the sync', r.status === 200 && r.data.nothingNew === true && r.data.linked === true && r.data.meter?.lastSequenceNumber === 8 && r.data.clockDriftWarn === true, JSON.stringify(r.data && { n: r.data.nothingNew, l: r.data.linked, seq: r.data.meter?.lastSequenceNumber }));
    r = await call(N, 'GET', '/patients/CDC-A/glucose/meters');
    check('lastSyncAt moved on the empty sync', !!r.data?.[0]?.lastSyncAt && new Date(r.data[0].lastSyncAt) > new Date(Date.now() - 60000), r.data?.[0]?.lastSyncAt);

    // 5. summary — window covering the recent rows; merged-dup logbook + clinic RBS included
    r = await call(D, 'GET', '/patients/CDC-A/glucose/summary?from=2026-09-08&to=2026-09-12');
    const m = r.data?.metrics;
    const srcs = (r.data?.readings || []).map((x) => x.source);
    check('summary sources', r.status === 200 && srcs.includes('meter') && srcs.includes('logbook') && srcs.includes('clinic'), srcs.join(','));
    // countable meter rows in window: seq7 (60) only — 5 excluded, 6 HI-flagged, 8 control; + logbook 110 + clinic 9.4 mmol (169)
    check('summary counts only usable rows', m?.readings === 3 && m.hypoCount === 1, JSON.stringify(m && { n: m.readings, hypo: m.hypoCount }));
    check('meter time stored verbatim', (r.data.readings.find((x) => x.sequenceNumber === 5) || {}).at === '2026-09-12 09:31:00', r.data.readings.find((x) => x.sequenceNumber === 5)?.at);
    check('excluded row visible + flagged', !!r.data.readings.find((x) => x.sequenceNumber === 5 && x.excluded && !x.plausible));
    check('HI row not countable', !!r.data.readings.find((x) => x.sequenceNumber === 6 && !x.countable && x.flags.includes('resultTooHighOrLow')));
    check('clinic RBS converted to mg/dL', !!r.data.readings.find((x) => x.source === 'clinic' && x.mgdl === 169 && x.at.startsWith('2026-09-12 12:41')), r.data.readings.find((x) => x.source === 'clinic')?.at);
    check('hba1c overlay', r.data.hba1c?.value === 7.9 && r.data.hba1c.source === 'triage');
    check('consensus targets by default', r.data.targets?.individualised === false && r.data.targets.targets.tirHighMgdl === 180);

    // 6. conflict: same meter on patient B → 409; nurse re-assigns with usedFromDate → only recent rows import
    r = await call(N, 'POST', '/patients/CDC-B/glucose/meter/preflight', { serial: '13504545' });
    check('preflight conflict masks other patient', r.data?.link === 'conflict' && r.data.others[0].patientMasked !== 'CDC-A' && r.data.others[0].patientMasked.startsWith('CDC'), JSON.stringify(r.data?.others));
    const newRows = [meterRow(9, '2026-09-12 18:00:00', 140), meterRow(10, '2026-09-12 21:00:00', 150)];
    r = await call(N, 'POST', '/patients/CDC-B/glucose/meter/import', { device, readings: [...readings, ...newRows], hostTime: '2026-09-12 21:30:00', meterTime: '2026-09-12 18:28:00' });
    check('import stops on conflict', r.status === 409 && r.code === 'METER_CONFLICT');
    r = await call(N, 'POST', '/patients/CDC-B/glucose/meter/import', { device, readings: [...readings, ...newRows], hostTime: '2026-09-12 21:30:00', meterTime: '2026-09-12 18:28:00', link: { action: 'reassign', reason: 'Meter handed to spouse' } });
    check('reassign needs usedFromDate', r.status === 400 && r.code === 'USED_FROM_REQUIRED');
    r = await call(N, 'POST', '/patients/CDC-B/glucose/meter/import', { device, readings: [...readings, ...newRows], hostTime: '2026-09-12 21:30:00', meterTime: '2026-09-12 18:28:00', link: { action: 'reassign', reason: 'Meter handed to spouse', usedFromDate: '2026-09-12' } });
    check('reassign imports only new + skips A\'s rows', r.status === 201 && r.data.inserted === 2 && r.data.duplicates === 7 && r.data.skippedBeforeUsedFrom === 0, JSON.stringify(r.data && { i: r.data.inserted, d: r.data.duplicates, s: r.data.skippedBeforeUsedFrom }));
    r = await call(N, 'GET', '/patients/CDC-A/glucose/meters');
    check('A\'s link retired with reason', r.data?.[0]?.status === 'Retired' && /Re-assigned to CDC-B/.test(r.data[0].retireReason), r.data?.[0]?.retireReason);
    // usedFromDate skip: a row dated before the date on a fresh serial
    const dev2 = { serial: '999', modelId: '973' };
    r = await call(N, 'POST', '/patients/CDC-B/glucose/meter/import', { device: dev2, readings: [meterRow(1, '2026-08-01 08:00:00', 100), meterRow(2, '2026-09-12 08:00:00', 100)], hostTime: '2026-09-12 21:30:00', link: { action: 'link', usedFromDate: '2026-09-01' } });
    check('usedFromDate skips earlier records', r.status === 201 && r.data.inserted === 1 && r.data.skippedBeforeUsedFrom === 1);

    // 7. exclude / restore (doctor only)
    const sum = await call(D, 'GET', '/patients/CDC-A/glucose/summary?from=2026-09-08&to=2026-09-12');
    const hypoRow = sum.data.readings.find((x) => x.sequenceNumber === 7);
    r = await call(N, 'PUT', `/patients/CDC-A/glucose/meter/readings/${hypoRow.id}/exclude`, { reason: 'x' });
    check('nurse cannot exclude', r.status === 403);
    r = await call(D, 'PUT', `/patients/CDC-A/glucose/meter/readings/${hypoRow.id}/exclude`, { reason: 'Control test' });
    check('doctor excludes with reason', r.status === 200 && r.data.excluded && r.data.excludeReason === 'Control test' && /Dr\./.test(r.data.excludedByName));
    r = await call(D, 'PUT', `/patients/CDC-A/glucose/meter/readings/${hypoRow.id}/restore`);
    check('restore', r.status === 200 && r.data.excluded === false);

    // 8. targets
    r = await call(N, 'PUT', '/patients/CDC-A/glucose/targets', { rationale: 'x', tirHighMgdl: 140 });
    check('nurse cannot set targets', r.status === 403);
    r = await call(D, 'PUT', '/patients/CDC-A/glucose/targets', { preset: 'pregnancy', rationale: 'Pregnant, 14 weeks' });
    check('doctor sets preset targets', r.status === 200 && r.data.individualised && r.data.targets.tirHighMgdl === 140 && r.data.meta.preset === 'pregnancy', JSON.stringify(r.data?.targets?.tirHighMgdl));
    r = await call(D, 'PUT', '/patients/CDC-A/glucose/targets', { rationale: 'x', tirLowMgdl: 200 });
    check('rejects unordered bands', r.status === 400);
    r = await call(D, 'GET', '/patients/CDC-A/glucose/summary?days=14');
    check('summary uses individual targets', r.data?.targets?.individualised === true && r.data.metrics.targets.tirHighMgdl === 140);

    // 9. batches (Visit History)
    r = await call(D, 'GET', '/patients/CDC-A/glucose/batches');
    check('batches grouped', r.status === 200 && r.data.length === 1 && r.data[0].count === 7 && r.data[0].maxSeq === 8, JSON.stringify(r.data?.map((b) => [b.count, b.maxSeq])));

    // 10. patient self-only
    const patUser = await mkUser('patient', 3); pB.UserId = patUser.id; await pB.save();
    const P = tok(patUser);
    r = await call(P, 'GET', '/patients/CDC-A/glucose/summary');
    check('patient cannot read another patient', r.status === 403);
    r = await call(P, 'GET', '/patients/CDC-B/glucose/summary?days=30');
    check('patient reads own summary', r.status === 200 && r.data.readings.length >= 2, String(r.status));
    r = await call(P, 'POST', '/patients/CDC-B/glucose/meter/import', { device: { serial: '13504545' }, readings: [meterRow(11, '2026-09-13 07:00:00', 120)], hostTime: '2026-09-13 07:05:00' });
    check('patient self-sync on own linked meter', r.status === 201 && r.data.inserted === 1 && r.data.meter.status === 'Active', String(r.status));
  } finally {
    server.close(); await db.sequelize.close();
  }
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
