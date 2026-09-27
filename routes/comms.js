const express = require('express');
const multer = require('multer');

const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const comms = require('../controllers/commsController');

// Communications Inbox — patient messages on the clinic's WhatsApp number.
// Front desk, doctors and nurses hold both capabilities by role; a lab
// technician can be granted them; either can be withdrawn per person. Coarse
// gate here; the merge rule, the 24 h window and timing live in the controller.
const VIEW  = ['staff', 'doctor', 'nurse', 'admin', 'comms.view'];
const WRITE = ['staff', 'doctor', 'nurse', 'admin', 'comms.write'];
const CONFIG = ['admin', 'config.write'];   // cost analytics + the organisations editor
// Staff Email phase 5: reading the TEXT of a patient's email threads — doctors,
// nurses, admins by role; anyone else by grant (Emu, 27 Sep).
const PATIENT_EMAIL_VIEW = ['doctor', 'nurse', 'admin', 'patientemail.view'];

// Outbound media (Send via WhatsApp / composer attach) — kept in memory, ≤10 MB.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// --- badge + channels ---
router.get('/badge',    authenticate, authorize(...VIEW), comms.badge);
router.get('/channels', authenticate, authorize(...VIEW), comms.channels);

// --- reminders (before /:id routes so 'reminders' is not read as an id) ---
router.get('/reminders',            authenticate, authorize(...VIEW),  comms.listReminders);
router.post('/reminders/:id/done',     authenticate, authorize(...WRITE), comms.updateReminder('done'));
router.post('/reminders/:id/snooze',   authenticate, authorize(...WRITE), comms.updateReminder('snooze'));
router.post('/reminders/:id/reassign', authenticate, authorize(...WRITE), comms.updateReminder('reassign'));
router.post('/reminders/:id/cancel',   authenticate, authorize(...WRITE), comms.updateReminder('cancel'));

// --- templates + organisations ---
router.get('/templates',       authenticate, authorize(...VIEW),  comms.listTemplates);
router.post('/templates/sync', authenticate, authorize(...WRITE), comms.syncTemplates);
router.get('/organisations',   authenticate, authorize(...VIEW),  comms.listOrganisations);
router.post('/organisations',  authenticate, authorize(...CONFIG), comms.saveOrganisation);

// --- patient communications trail (Patient file → Communications tab) ---
router.get('/patients/:uhid/trail', authenticate, authorize(...VIEW), comms.patientTrail);
// Phase 5 — the patient's email threads (text), and an admin-only soft removal.
router.get('/patients/:uhid/email-threads', authenticate, authorize(...PATIENT_EMAIL_VIEW), comms.patientEmailThreads);
router.post('/patients/:uhid/email-messages/:id/remove', authenticate, authorize('admin'), comms.removePatientEmail);
// Phase 5b — save an attachment of a patient-thread email into the patient's
// Documents. The POST /api/documents gate; only the mailbox owner (controller).
router.post('/patients/:uhid/email-messages/:id/attachments/:index/save', authenticate, authorize('doctor', 'staff', 'admin', 'documents.write'), comms.savePatientEmailAttachment);

// --- analytics ---
router.get('/analytics/operations', authenticate, authorize(...VIEW),   comms.analyticsOperations);
router.get('/analytics/costs',      authenticate, authorize(...CONFIG), comms.analyticsCosts);
// Phase 5 — email analytics: shows each person's mail volume, so the Activity
// Log's gate, not the Inbox's.
router.get('/analytics/email',      authenticate, authorize('admin', 'monitoring.view'), comms.analyticsEmail);

// --- escalations ---
router.post('/escalations/:id/resolve', authenticate, authorize(...WRITE), comms.resolveEscalation);

// --- messages ---
router.get('/messages/:id/media',   authenticate, authorize(...VIEW),  comms.serveMedia);
router.post('/messages/:id/complete', authenticate, authorize(...WRITE), comms.completeQuery);
router.post('/messages/:id/reopen',   authenticate, authorize(...WRITE), comms.reopenQuery);
router.post('/messages/:id/file',     authenticate, authorize(...WRITE), comms.fileToRecord);

// --- conversations ---
router.get('/conversations',  authenticate, authorize(...VIEW),  comms.list);
router.post('/conversations', authenticate, authorize(...WRITE), comms.startForPatient);
router.get('/conversations/:id',          authenticate, authorize(...VIEW),  comms.detail);
router.get('/conversations/:id/messages', authenticate, authorize(...VIEW),  comms.messages);
router.post('/conversations/:id/messages', authenticate, authorize(...WRITE), upload.single('file'), comms.send);
router.post('/conversations/:id/read',     authenticate, authorize(...WRITE), comms.markRead);
router.post('/conversations/:id/link',     authenticate, authorize(...WRITE), comms.link);
router.post('/conversations/:id/unlink',   authenticate, authorize(...WRITE), comms.unlink);
router.post('/conversations/:id/contact-type', authenticate, authorize(...WRITE), comms.setContactType);
router.post('/conversations/:id/pin',      authenticate, authorize(...WRITE), comms.pin);
router.post('/conversations/:id/unpin',    authenticate, authorize(...WRITE), comms.unpin);
router.post('/conversations/:id/topic',    authenticate, authorize(...WRITE), comms.setTopic);
router.post('/conversations/:id/assign',   authenticate, authorize(...WRITE), comms.assign);
router.post('/conversations/:id/close',    authenticate, authorize(...WRITE), comms.close);
router.post('/conversations/:id/reopen',   authenticate, authorize(...WRITE), comms.reopen);
router.post('/conversations/:id/escalate', authenticate, authorize(...WRITE), comms.escalate);
router.post('/conversations/:id/internal-note', authenticate, authorize(...WRITE), comms.internalNote);
router.post('/conversations/:id/reminders', authenticate, authorize(...WRITE), comms.createReminder);
router.post('/conversations/:id/book',     authenticate, authorize(...WRITE), comms.bookFromChat);

module.exports = router;
