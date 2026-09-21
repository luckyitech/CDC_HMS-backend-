// End-to-end exercise of the WhatsApp inbound pipeline against a scratch
// MariaDB, with a scripted fake Meta for media. Manual smoke run (the project
// has no CI):  npm run test:comms   (needs a .env.test → an EMPTY throwaway DB).
require('dotenv').config({ path: '.env.test', override: true });

// SAFETY: this calls sequelize.sync({ force: true }) — that DROPS EVERY TABLE in
// whatever database it points at. Never run it against a developer's or the
// clinic's database. Guarded exactly like the _gmc harness.
if (process.env.CONFIRM_TEST_DB !== '1' || !process.env.DB_NAME || /prod|cdc_hms$/i.test(process.env.DB_NAME)) {
  console.error(`[comms test] refusing to run: DB_NAME="${process.env.DB_NAME || ''}" CONFIRM_TEST_DB="${process.env.CONFIRM_TEST_DB || ''}". `
    + 'Point .env.test at an empty test database and set CONFIRM_TEST_DB=1.');
  process.exit(0);
}

const fs = require('fs');
const path = require('path');
const fakeMeta = require('../../scripts/fake-meta');
const { parseJsonColumn } = require('../../utils/jsonColumn');   // MariaDB returns JSON as a string

let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`); if (!ok) failures += 1; };

const CHANNEL_PNID = '999888777';
const lockedPdf = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'locked.pdf'));
const plainPdf = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'plain.pdf'));

(async () => {
  const meta = await fakeMeta.start();
  process.env.WHATSAPP_GRAPH_BASE = meta.base;   // BEFORE requiring whatsappApi

  // Capture SSE broadcasts by patching the shared manager BEFORE the inbound
  // service destructures its broadcast reference.
  const sse = require('../../utils/sseManager');
  const broadcasts = [];
  sse.broadcast = (event, data) => broadcasts.push({ event, data });

  const db = require('../../models');
  const commsConfig = require('../../utils/commsConfig');
  const { processWebhook } = require('../../services/whatsappInbound');
  const { ConversationMessage } = db;

  await db.sequelize.sync({ force: true });

  // Credentials so getCommsConfig().isConfigured and whatsappApi work.
  await commsConfig.setCommsConfig({
    wabaId: 'WABA', appId: 'APP', appSecret: 'secret', accessToken: 'tok', verifyToken: 'vt',
    graphVersion: 'v25.0', autoLink: true, mediaMaxMb: 25,
  });

  // Channel + patients + a lab organisation.
  const channel = await db.MessagingChannel.create({ channel: 'whatsapp', externalId: CHANNEL_PNID, displayPhone: '+254 700 000 000', label: 'Main', wabaId: 'WABA', isActive: true });
  await db.Patient.create({ uhid: 'CDC-U1', firstName: 'Uni', lastName: 'Que', phone: '0711000001' });
  await db.Patient.create({ uhid: 'CDC-S1', firstName: 'Sha', lastName: 'Red', phone: '0711000002' });
  await db.Patient.create({ uhid: 'CDC-S2', firstName: 'Also', lastName: 'Shared', phone: '0711000002' });
  const org = await db.ExternalOrganisation.create({ type: 'lab', name: 'Pathologists Lane', isActive: true });
  await db.ExternalOrganisationContact.create({ organisationId: org.id, kind: 'whatsapp', value: '254711000009' });

  const convFor = (waId) => db.Conversation.findOne({ where: { channelId: channel.id, externalUserId: waId } });

  // 1) Unique-phone inbound → auto-linked
  await processWebhook(fakeMeta.inboundText({ phoneNumberId: CHANNEL_PNID, from: '254711000001', id: 'wamid.1', text: 'Hello clinic', name: 'Uni Que' }));
  let c = await convFor('254711000001');
  const u1 = await db.Patient.findOne({ where: { uhid: 'CDC-U1' } });
  check('unique inbound creates a conversation', !!c);
  check('unique inbound auto-links to the one patient', c && c.patientId === u1.id && c.linkMethod === 'auto');
  check('conversation counters + window set', c && c.unreadCount === 1 && c.openQueryCount === 1 && !!c.windowExpiresAt);
  const m1 = await ConversationMessage.findOne({ where: { externalMessageId: 'wamid.1' } });
  check('message row: in / received / open query / patient snapshot', m1 && m1.direction === 'in' && m1.status === 'received' && m1.queryStatus === 'open' && m1.patientId === u1.id);
  check('comms_new broadcast fired', broadcasts.some((b) => b.event === 'comms_new'));

  // 2) Shared phone → not linked, candidates surfaced
  await processWebhook(fakeMeta.inboundText({ phoneNumberId: CHANNEL_PNID, from: '254711000002', id: 'wamid.2', text: 'Hi', name: 'Sha Red' }));
  c = await convFor('254711000002');
  check('shared-phone inbound is NOT auto-linked', c && !c.patientId);
  const cand = parseJsonColumn(c && c.suggestedPatientIds) || [];
  check('shared-phone inbound surfaces 2 candidates', Array.isArray(cand) && cand.length === 2);

  // 3) Unknown phone → unlinked, no candidates
  await processWebhook(fakeMeta.inboundText({ phoneNumberId: CHANNEL_PNID, from: '254799999999', id: 'wamid.3', text: 'Who?', name: 'Nobody' }));
  c = await convFor('254799999999');
  check('unknown-phone inbound: unlinked, no candidates', c && !c.patientId && (!c.suggestedPatientIds || c.suggestedPatientIds.length === 0));

  // 4) Duplicate message id → no-op
  const before = await ConversationMessage.count();
  c = await convFor('254711000001');
  const unreadBefore = c.unreadCount;
  await processWebhook(fakeMeta.inboundText({ phoneNumberId: CHANNEL_PNID, from: '254711000001', id: 'wamid.1', text: 'Hello clinic', name: 'Uni Que' }));
  const after = await ConversationMessage.count();
  c = await convFor('254711000001');
  check('duplicate message id is idempotent (no new row, counters unchanged)', after === before && c.unreadCount === unreadBefore);

  // 5) Inbound PDF from a patient → media staged, encrypted flag detected
  meta.registerMedia('media-locked', lockedPdf, 'application/pdf');
  await processWebhook(fakeMeta.inboundDocument({ phoneNumberId: CHANNEL_PNID, from: '254711000001', id: 'wamid.5', mediaId: 'media-locked', filename: 'result.pdf', caption: 'your result' }));
  const m5 = await ConversationMessage.findOne({ where: { externalMessageId: 'wamid.5' } });
  check('inbound document downloads media to private/comms/', m5 && m5.mediaPath && m5.mediaPath.includes(path.join('private', 'comms')) && fs.existsSync(m5.mediaPath));
  check('inbound encrypted PDF is flagged mediaEncrypted', m5 && m5.mediaEncrypted === true);
  check('inbound document is NOT mirrored to Lab Inbox (patient thread)', (await db.LabInboxItem.count()) === 0);

  // 6) Inbound PDF from a lab number → typed lab + mirrored into Lab Inbox
  meta.registerMedia('media-lab', plainPdf, 'application/pdf');
  broadcasts.length = 0;
  await processWebhook(fakeMeta.inboundDocument({ phoneNumberId: CHANNEL_PNID, from: '254711000009', id: 'wamid.6', mediaId: 'media-lab', filename: 'labreport.pdf', caption: 'CDC-U1 FBC', name: 'Pathologists Lane' }));
  c = await convFor('254711000009');
  check('lab-number thread is typed as lab', c && c.contactType === 'lab' && c.contactOrgId === org.id);
  const item = await db.LabInboxItem.findOne({ where: { source: 'whatsapp' } });
  check('lab PDF is mirrored into the Lab Inbox (source whatsapp)', !!item && item.status === 'New' && !!item.sourceMessageId);
  check('lab mirror links back to the WhatsApp message', item && item.sourceMessageId === (await ConversationMessage.findOne({ where: { externalMessageId: 'wamid.6' } })).id);
  check('lab_inbox_new broadcast fired', broadcasts.some((b) => b.event === 'lab_inbox_new'));

  // 7) Delivery status updates an outbound message (forward-only + pricing)
  const conv = await convFor('254711000001');
  const out = await ConversationMessage.create({ conversationId: conv.id, channel: 'whatsapp', direction: 'out', externalMessageId: 'wamid.OUT99', type: 'text', body: 'hi', status: 'sent', sentById: null });
  await processWebhook(fakeMeta.statusUpdate({ phoneNumberId: CHANNEL_PNID, id: 'wamid.OUT99', status: 'delivered', billable: true, category: 'service' }));
  await processWebhook(fakeMeta.statusUpdate({ phoneNumberId: CHANNEL_PNID, id: 'wamid.OUT99', status: 'read' }));
  await processWebhook(fakeMeta.statusUpdate({ phoneNumberId: CHANNEL_PNID, id: 'wamid.OUT99', status: 'delivered' })); // out of order
  await out.reload();
  check('status advances to read and captures pricing', out.status === 'read' && out.billable === true && out.pricingCategory === 'service');
  check('out-of-order status does not regress read→delivered', out.status === 'read');

  // 8) Template status webhook updates the cache
  await processWebhook({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'message_template_status_update', value: { message_template_name: 'appointment_confirmation', message_template_language: 'en', event: 'APPROVED', message_template_id: 'tpl-1' } }] }] });
  const tpl = await db.MessageTemplate.findOne({ where: { name: 'appointment_confirmation', language: 'en' } });
  check('template status webhook caches the template as APPROVED', tpl && tpl.status === 'APPROVED');

  // 9) Unknown phone_number_id is skipped, not crashed
  const cnt = await ConversationMessage.count();
  await processWebhook(fakeMeta.inboundText({ phoneNumberId: 'not-our-number', from: '254700111222', id: 'wamid.X', text: 'stray' }));
  check('webhook for an unknown number is skipped', (await ConversationMessage.count()) === cnt);

  // 10) HTTP layer — the raw-body route through the real app (proves the mount
  //     order: express.raw + signature verification before express.json()).
  const app = require('../../app');
  const httpServer = app.listen(3998, '127.0.0.1');
  await new Promise((r) => httpServer.once('listening', r));
  const WB = 'http://127.0.0.1:3998/api/comms/webhook';

  const getVerify = await fetch(`${WB}?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=CHALLENGE123`);
  check('GET verify echoes the challenge on a correct token', getVerify.status === 200 && (await getVerify.text()) === 'CHALLENGE123');
  const getBad = await fetch(`${WB}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=X`);
  check('GET verify rejects a wrong token (403)', getBad.status === 403);

  const payload = JSON.stringify(fakeMeta.inboundText({ phoneNumberId: CHANNEL_PNID, from: '254711000001', id: 'wamid.HTTP1', text: 'via http' }));
  const badPost = await fetch(WB, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=deadbeef' }, body: payload });
  check('POST with a bad signature is 401 (never 200)', badPost.status === 401);
  const goodPost = await fetch(WB, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': fakeMeta.signPayload(payload, 'secret') }, body: payload });
  check('POST with a valid signature is acknowledged 200', goodPost.status === 200);
  await new Promise((r) => setTimeout(r, 300));   // processed after the ack
  check('a valid signed POST is processed into a message row', !!(await ConversationMessage.findOne({ where: { externalMessageId: 'wamid.HTTP1' } })));

  await new Promise((r) => httpServer.close(r));
  await meta.close();
  await db.sequelize.close();
  console.log(`\n${failures === 0 ? 'ALL PASS ✅' : `${failures} FAILED ❌`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e.stack || e); process.exit(1); });
