// Diary + time-matching end-to-end against the scratch MariaDB.
//   node tests/_gmc/diary-api.test.js
require('dotenv').config({ path: '.env.test', override: true });
const jwt = require('jsonwebtoken');
const db = require('../../models');
const app = require('../../app');

const PORT = 3998;
const base = `http://127.0.0.1:${PORT}/api`;
let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`); if (!ok) failures++; };
const call = async (token, method, path, body) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, ...(json || {}) };
};
// naive 'YYYY-MM-DD HH:mm:ss' -> Date carrying it as UTC (matches utils/glucoseTime)
const D = (y, mo, d, h, mi) => new Date(Date.UTC(y, mo - 1, d, h, mi, 0));

(async () => {
  await db.sequelize.sync({ force: true });
  const doctor = await db.User.create({ firstName: 'Doc', lastName: 'Tor', email: 'd@cdc.local', password: 'x', role: 'doctor', isActive: true, passwordChangedAt: new Date() });
  const patUser = await db.User.create({ firstName: 'Pat', lastName: 'Ient', email: 'p@cdc.local', password: 'x', role: 'patient', isActive: true, passwordChangedAt: new Date() });
  const p = await db.Patient.create({ uhid: 'CDC-D', firstName: 'Dia', lastName: 'Ry', gender: 'Male', phone: '9', dateOfBirth: '1975-01-01', UserId: patUser.id });
  const other = await db.Patient.create({ uhid: 'CDC-O', firstName: 'Oth', lastName: 'Er', gender: 'Female', phone: '8', dateOfBirth: '1980-01-01' });
  const meter = await db.PatientMeter.create({ PatientId: p.id, deviceSerial: 'S1', deviceModel: 'Accu-Chek Instant', status: 'Active', firstLinkedAt: new Date() });

  // Readings around a breakfast at 08:00 on 2026-09-10.
  const mk = (seq, at, extra = {}) => db.GlucoseMeterReading.create({ PatientId: p.id, PatientMeterId: meter.id, deviceSerial: 'S1', sequenceNumber: seq, measuredAt: at, glucoseMgdl: 140, unitsReported: 'kg/L', sensorStatus: 0, contextTag: 'x', contextSource: 'clock', importBatchId: 'b1', importedByRole: 'clinic', status: 'Active', ...extra });
  const A = await mk(1, D(2026, 9, 10, 7, 30));                                   // 30 min before → pre
  const B = await mk(2, D(2026, 9, 10, 9, 30));                                   // 90 min after → post
  const C = await mk(3, D(2026, 9, 10, 12, 30));                                  // 4.5 h after → clock only
  const Dd = await mk(4, D(2026, 9, 10, 7, 45), { hostClockDeltaSec: 4000 });     // drift → not matched
  const E = await mk(5, D(2026, 9, 10, 7, 50), { contextSource: 'manual', contextTag: 'custom' }); // manual → protected

  const tok = (u) => jwt.sign({ id: u.id, email: u.email, role: u.role, name: 'x' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const DOC = tok(doctor), PT = tok(patUser);
  const server = app.listen(PORT);
  const readingTag = async (seq) => {
    const s = await call(DOC, 'GET', '/patients/CDC-D/glucose/summary?from=2026-09-10&to=2026-09-10');
    return (s.data.readings.find((x) => x.sequenceNumber === seq) || {});
  };
  try {
    // 1. add the breakfast meal (patient logs it themselves) → matcher runs
    let r = await call(PT, 'POST', '/patients/CDC-D/glucose/diary', { eventType: 'meal', occurredAt: '2026-09-10 08:00:00', label: 'Breakfast', detail: { carbs: 45 } });
    check('patient adds meal', r.status === 201 && r.data.eventType === 'meal' && r.data.label === 'Breakfast', String(r.status));

    check('reading 30m before → pre-Breakfast (matched)', (await readingTag(1)).tag === 'pre-Breakfast' && (await readingTag(1)).tagSource === 'matched', JSON.stringify(await readingTag(1)));
    check('reading 90m after → post-Breakfast (matched)', (await readingTag(2)).tag === 'post-Breakfast' && (await readingTag(2)).tagSource === 'matched');
    check('reading 4.5h after → clock, not matched', (await readingTag(3)).tagSource === 'clock');
    check('drifted reading not matched (clock)', (await readingTag(4)).tagSource === 'clock', JSON.stringify(await readingTag(4)));
    check('manual tag protected', (await readingTag(5)).tagSource === 'manual' && (await readingTag(5)).tag === 'custom');

    // 2. summary exposes diary + mealTags
    r = await call(DOC, 'GET', '/patients/CDC-D/glucose/summary?from=2026-09-10&to=2026-09-10');
    check('summary returns diary array', Array.isArray(r.data.diary) && r.data.diary.length === 1 && r.data.diary[0].label === 'Breakfast');
    check('mealTags.matched counts 2', r.data.metrics.mealTags && r.data.metrics.mealTags.matched === 2, JSON.stringify(r.data.metrics.mealTags));
    check('bucket decoupled from meal tag (time-of-day still populated)', r.data.metrics.timeOfDay.some((b) => b.n > 0));

    // 3. list / edit / delete
    r = await call(PT, 'GET', '/patients/CDC-D/glucose/diary?from=2026-09-10&to=2026-09-10');
    const evId = r.data[0].id;
    check('diary list', r.status === 200 && r.data.length === 1);
    r = await call(PT, 'PUT', `/patients/CDC-D/glucose/diary/${evId}`, { label: 'Early breakfast' });
    check('diary edit', r.status === 200 && r.data.label === 'Early breakfast');
    check('re-tag after edit', (await readingTag(1)).tag === 'pre-Early breakfast', (await readingTag(1)).tag);

    r = await call(PT, 'DELETE', `/patients/CDC-D/glucose/diary/${evId}`);
    check('diary soft-delete', r.status === 200 && r.data.deleted === true);
    check('match cleared after delete (reverts to clock)', (await readingTag(1)).tagSource === 'clock', JSON.stringify(await readingTag(1)));
    r = await call(PT, 'GET', '/patients/CDC-D/glucose/diary?from=2026-09-10&to=2026-09-10');
    check('deleted event hidden from list', r.data.length === 0);

    // 4. auth: patient cannot write another patient's diary; unknown type rejected
    r = await call(PT, 'POST', '/patients/CDC-O/glucose/diary', { eventType: 'meal', occurredAt: '2026-09-10 08:00:00', label: 'X' });
    check('patient cannot write another patient diary', r.status === 403, String(r.status));
    r = await call(DOC, 'POST', '/patients/CDC-D/glucose/diary', { eventType: 'party', occurredAt: '2026-09-10 08:00:00' });
    check('unknown event type rejected', r.status === 400);
    r = await call(DOC, 'POST', '/patients/CDC-D/glucose/diary', { eventType: 'activity', occurredAt: 'not-a-date' });
    check('bad occurredAt rejected', r.status === 400);

    // 5. non-meal event does not tag readings but is stored + shown
    r = await call(PT, 'POST', '/patients/CDC-D/glucose/diary', { eventType: 'insulin', occurredAt: '2026-09-10 07:55:00', label: 'Novomix', detail: { units: 12 } });
    check('insulin event stored', r.status === 201 && r.data.detail.units === 12);
    check('insulin does not tag the 07:30 reading', (await readingTag(1)).tagSource === 'clock');
  } finally {
    server.close(); await db.sequelize.close();
  }
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
