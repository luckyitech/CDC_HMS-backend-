// End-to-end exercise of the authenticated /api/comms API against a scratch
// MariaDB, with a scripted fake Meta. Manual smoke run: npm run test:comms:api
require('dotenv').config({ path: '.env.test', override: true });
require('../_guard').assertThrowawayDb('comms api test');

const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const fakeMeta = require('../../scripts/fake-meta');

let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`); if (!ok) failures += 1; };
const CHANNEL_PNID = '999888777';
const lockedPdf = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'locked.pdf'));

(async () => {
  const meta = await fakeMeta.start();
  process.env.WHATSAPP_GRAPH_BASE = meta.base;
  process.env.JWT_EXPIRES_IN = '1h';

  const db = require('../../models');
  const commsConfig = require('../../utils/commsConfig');
  const { processWebhook } = require('../../services/whatsappInbound');
  const app = require('../../app');

  await db.sequelize.sync({ force: true });
  await commsConfig.setCommsConfig({ wabaId: 'WABA', appId: 'APP', appSecret: 'secret', accessToken: 'tok', verifyToken: 'vt', graphVersion: 'v25.0', autoLink: true, warnNoConsent: true });

  const channel = await db.MessagingChannel.create({ channel: 'whatsapp', externalId: CHANNEL_PNID, displayPhone: '+254 700 000 000', label: 'Main', wabaId: 'WABA', isActive: true });
  const doctor = await db.User.create({ firstName: 'Dee', lastName: 'Oc', name: 'Dee Oc', email: 'doc@t.local', password: 'x', role: 'doctor' });
  const admin = await db.User.create({ firstName: 'Ad', lastName: 'Min', name: 'Ad Min', email: 'admin@t.local', password: 'x', role: 'admin' });
  const nurse = await db.User.create({ firstName: 'Nur', lastName: 'Se', name: 'Nur Se', email: 'nur@t.local', password: 'x', role: 'nurse' });
  // patient whose idNumber does NOT match the PDF password, so filing needs the typed password
  const patient = await db.Patient.create({ uhid: 'CDC-P1', firstName: 'Pat', lastName: 'One', phone: '0711000001', idNumber: '000', whatsappOptIn: false, primaryDoctorId: doctor.id });

  const tok = (u) => jwt.sign({ id: u.id, role: u.role, name: u.name }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const server = app.listen(3997, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:3997/api';
  const api = async (token, method, p, body, raw) => {
    const r = await fetch(base + p, { method, headers: { ...(raw ? {} : { 'content-type': 'application/json' }), authorization: `Bearer ${token}` }, body: raw ? body : (body ? JSON.stringify(body) : undefined) });
    let json = null; try { json = await r.json(); } catch {}
    return { status: r.status, ...(json || {}) };
  };

  // Seed a conversation via an inbound message (auto-links to CDC-P1).
  await processWebhook(fakeMeta.inboundText({ phoneNumberId: CHANNEL_PNID, from: '254711000001', id: 'wamid.in1', text: 'Hi, can I get my results?', name: 'Pat One' }));
  const conv = await db.Conversation.findOne({ where: { externalUserId: '254711000001' } });
  const inMsg = await db.ConversationMessage.findOne({ where: { externalMessageId: 'wamid.in1' } });

  // 1) badge
  let r = await api(tok(doctor), 'GET', '/comms/badge');
  check('GET /badge returns structured counts', r.status === 200 && r.data && r.data.whatsapp && typeof r.data.total === 'number' && r.data.whatsapp.openQueries >= 1);

  // 2) list + 3) detail + 4) messages
  r = await api(tok(doctor), 'GET', '/comms/conversations?filter=all');
  check('GET /conversations lists the thread', r.status === 200 && r.data.conversations.some((c) => c.id === conv.id && c.patient && c.patient.uhid === 'CDC-P1'));
  r = await api(tok(doctor), 'GET', `/comms/conversations/${conv.id}`);
  check('GET /conversations/:id returns detail + patient', r.status === 200 && r.data.conversation.patient.uhid === 'CDC-P1' && r.data.conversation.windowOpen === true);
  r = await api(tok(doctor), 'GET', `/comms/conversations/${conv.id}/messages`);
  check('GET messages returns the inbound message', r.status === 200 && r.data.messages.some((m) => m.direction === 'in' && m.query && m.query.status === 'open'));

  // 5) send text within window
  const callsBefore = meta.calls.length;
  r = await api(tok(doctor), 'POST', `/comms/conversations/${conv.id}/messages`, { text: 'Yes — they are ready.' });
  check('POST send text within window → 201 + outbound row', r.status === 201 && r.data.message.direction === 'out' && r.data.message.status === 'sent');
  check('send hit the WhatsApp API (fake Meta recorded it)', meta.calls.slice(callsBefore).some((c) => /\/messages$/.test(c.url) && c.method === 'POST'));
  check('consent warning surfaced (patient not opted in)', r.data.consentWarning === true);

  // 6) complete query — note required
  r = await api(tok(doctor), 'POST', `/comms/messages/${inMsg.id}/complete`, { resolutionKind: 'answered' });
  check('complete without a note → 400', r.status === 400);
  r = await api(tok(doctor), 'POST', `/comms/messages/${inMsg.id}/complete`, { resolutionKind: 'answered', resolutionNote: 'Told patient results are ready' });
  check('complete with a note → 200, query completed', r.status === 200 && r.data.message.query.status === 'completed');
  await conv.reload();
  check('openQueryCount decremented on completion', conv.openQueryCount === 0);

  // 7) window-closed behaviour
  await conv.update({ windowExpiresAt: new Date(Date.now() - 1000) });
  r = await api(tok(doctor), 'POST', `/comms/conversations/${conv.id}/messages`, { text: 'late reply' });
  check('send after the window closes → 409 windowClosed', r.status === 409 && r.code === 'windowClosed');
  r = await api(tok(doctor), 'POST', `/comms/conversations/${conv.id}/messages`, { templateName: 'results_ready', language: 'en', preview: 'Results ready' });
  check('template send after the window → 201', r.status === 201 && r.data.message.type === 'template');
  await conv.update({ windowExpiresAt: new Date(Date.now() + 3600_000) });   // reopen for later steps

  // 8) link / unlink
  r = await api(tok(doctor), 'POST', `/comms/conversations/${conv.id}/unlink`, { reason: 'wrong patient' });
  check('unlink clears the patient', r.status === 200 && !r.data.conversation.patient);
  r = await api(tok(doctor), 'POST', `/comms/conversations/${conv.id}/link`, { uhid: 'CDC-P1', moveEarlier: true });
  check('link (merge-aware) re-attaches the patient', r.status === 200 && r.data.conversation.patient.uhid === 'CDC-P1');

  // 9) escalate → shows on the target's badge
  r = await api(tok(nurse), 'POST', `/comms/conversations/${conv.id}/escalate`, { toUserId: doctor.id, note: 'please advise on dose' });
  check('escalate creates an escalation', r.status === 201 && r.data.escalation.id);
  r = await api(tok(doctor), 'GET', '/comms/badge');
  check('escalation shows on the doctor badge', r.data.whatsapp.escalatedToMe >= 1);

  // 10) file an inbound PDF to the record (password removal)
  const dir = path.join(__dirname, '..', '..', 'private', 'comms', String(conv.id));
  fs.mkdirSync(dir, { recursive: true });
  const mediaPath = path.join(dir, 'locked-fixture.pdf');
  fs.writeFileSync(mediaPath, lockedPdf);
  const docMsg = await db.ConversationMessage.create({ conversationId: conv.id, channel: 'whatsapp', direction: 'in', externalMessageId: 'wamid.doc1', type: 'document', mediaPath, mediaMime: 'application/pdf', mediaFileName: 'result.pdf', mediaEncrypted: true, status: 'received', queryStatus: 'open' });
  r = await api(tok(doctor), 'POST', `/comms/messages/${docMsg.id}/file`, { uhid: 'CDC-P1' });
  check('file a locked PDF without a password → 422 password_required', r.status === 422 && r.code === 'password_required');
  r = await api(tok(doctor), 'POST', `/comms/messages/${docMsg.id}/file`, { uhid: 'CDC-P1', password: 'wrong' });
  check('file with a wrong password → 422', r.status === 422);
  r = await api(tok(doctor), 'POST', `/comms/messages/${docMsg.id}/file`, { uhid: 'CDC-P1', password: 'secret', completeQuery: true });
  check('file with the correct password → 201, document created', r.status === 201 && r.data.documentId);
  const filedDoc = await db.MedicalDocument.findByPk(r.data.documentId);
  check('filed document is Pending Review and linked to the patient', filedDoc && filedDoc.status === 'Pending Review' && filedDoc.PatientId === patient.id);
  await docMsg.reload();
  check('message stamped with the document + query completed', docMsg.medicalDocumentId === filedDoc.id && docMsg.queryStatus === 'completed');

  // 11) book from chat
  const futureDate = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  r = await api(tok(doctor), 'POST', `/comms/conversations/${conv.id}/book`, { doctorId: doctor.id, date: futureDate, timeSlot: '10:00 AM', appointmentType: 'Follow-up', reason: 'review', sendConfirmation: true });
  check('book from chat → 201 with an appointment', r.status === 201 && r.data.appointmentId, `status ${r.status} ${r.message || ''}`);
  check('booking sent a confirmation (window open)', r.data && r.data.confirmationSent === true);
  const appt = r.data && r.data.appointmentId ? await db.Appointment.findByPk(r.data.appointmentId) : null;
  check('appointment row exists for the patient', appt && appt.PatientId === patient.id);

  // 12) reminders
  r = await api(tok(doctor), 'POST', `/comms/conversations/${conv.id}/reminders`, { remindAt: new Date(Date.now() - 1000).toISOString(), note: 'follow up' });
  check('create a (past-due) reminder → 201', r.status === 201);
  r = await api(tok(doctor), 'GET', '/comms/reminders?filter=due&mine=1');
  check('due reminders list includes it', r.status === 200 && r.data.reminders.length >= 1);

  // 13) analytics — operations (VIEW) and costs (admin only)
  r = await api(tok(doctor), 'GET', '/comms/analytics/operations');
  check('operations analytics → 200 with totals', r.status === 200 && r.data.totals && typeof r.data.totals.outbound === 'number');
  r = await api(tok(doctor), 'GET', '/comms/analytics/costs');
  check('cost analytics is refused for a non-admin doctor → 403', r.status === 403);
  r = await api(tok(admin), 'GET', '/comms/analytics/costs');
  check('cost analytics → 200 for an admin', r.status === 200 && r.data.currency === 'KES');

  // 14) capability gate: a lab user (no grant) is refused
  const lab = await db.User.create({ firstName: 'La', lastName: 'B', name: 'La B', email: 'lab@t.local', password: 'x', role: 'lab' });
  r = await api(tok(lab), 'GET', '/comms/conversations');
  check('a lab user without a grant is refused (403)', r.status === 403);

  await new Promise((res) => server.close(res));
  await meta.close();
  await db.sequelize.close();
  console.log(`\n${failures === 0 ? 'ALL PASS ✅' : `${failures} FAILED ❌`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e.stack || e); process.exit(1); });
