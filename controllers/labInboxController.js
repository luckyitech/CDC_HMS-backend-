const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Op } = require('sequelize');
const { success, error } = require('../utils/response');
const { resolvePatient } = require('../utils/patientFamily');
const { clinicToday } = require('../utils/clinicTime');
const { createMedicalDocument, formatFileSize } = require('../utils/medicalDocumentCreate');
const db = require('../models');

const { LabInboxItem, Patient, User, MedicalDocument } = db;

const DOCUMENTS_DIR = path.join(__dirname, '..', 'uploads', 'documents');
const DEFAULT_CATEGORY = 'Lab Report - External';

// ---------------------------------------------------------------------------
// Lab Inbox controller — triage of external lab-report PDFs pulled from the
// clinic mailbox (see services/labInboxPoller.js). A row is `New` until a
// staff member pairs it (→ a real MedicalDocument, `Matched`) or discards it
// (`Discarded`, soft-delete). Nothing here is a medical record until paired.
// ---------------------------------------------------------------------------

const patientBrief = (p) =>
  p ? { id: p.id, uhid: p.uhid, firstName: p.firstName, lastName: p.lastName, phone: p.phone } : null;

const formatItem = (it) => ({
  id: it.id,
  status: it.status,
  senderEmail: it.senderEmail,
  senderName: it.senderName,
  subject: it.subject,
  emailDate: it.emailDate,
  fileName: it.fileName,
  fileSize: it.fileSize,
  mimeType: it.mimeType,
  suggestion: {
    patient: patientBrief(it.suggestedPatient),
    score: it.suggestionScore,
    confidence: it.suggestionConfidence,
    source: it.suggestionSource,
    extracted: {
      name: it.extractedName,
      phone: it.extractedPhone,
      idNumber: it.extractedIdNumber,
      uhid: it.extractedUhid,
      dob: it.extractedDob,
    },
  },
  matched: it.status === 'Matched' ? {
    patient: patientBrief(it.matchedPatient),
    documentId: it.matchedDocumentId,
    by: it.matchedBy ? `${it.matchedBy.firstName} ${it.matchedBy.lastName}` : null,
    at: it.matchedAt,
  } : null,
  discarded: it.status === 'Discarded' ? {
    by: it.discardedBy ? `${it.discardedBy.firstName} ${it.discardedBy.lastName}` : null,
    at: it.discardedAt,
    reason: it.discardReason,
  } : null,
  receivedAt: it.createdAt,
});

const withAssociations = {
  include: [
    { model: Patient, as: 'suggestedPatient', attributes: ['id', 'uhid', 'firstName', 'lastName', 'phone'] },
    { model: Patient, as: 'matchedPatient',   attributes: ['id', 'uhid', 'firstName', 'lastName', 'phone'] },
    { model: User, as: 'matchedBy',   attributes: ['firstName', 'lastName'] },
    { model: User, as: 'discardedBy', attributes: ['firstName', 'lastName'] },
  ],
};

// GET /api/lab-inbox?status=New
const list = async (req, res) => {
  try {
    const status = req.query.status || 'New';
    const where = {};
    if (status !== 'All') where.status = status;

    const items = await LabInboxItem.findAll({
      where,
      ...withAssociations,
      order: [['emailDate', 'DESC'], ['createdAt', 'DESC']],
      limit: 500,
    });

    return success(res, { items: items.map(formatItem), total: items.length });
  } catch (err) {
    console.error('LabInbox.list error:', err);
    return error(res, 'Failed to load the lab inbox. Please try again.', 500);
  }
};

// GET /api/lab-inbox/count — badge count of New items
const count = async (req, res) => {
  try {
    const n = await LabInboxItem.count({ where: { status: 'New' } });
    return success(res, { count: n });
  } catch (err) {
    console.error('LabInbox.count error:', err);
    return error(res, 'Failed to count inbox items.', 500);
  }
};

// GET /api/lab-inbox/:id/file — serve the staged PDF (authenticated; NOT static)
const serveFile = async (req, res) => {
  try {
    const item = await LabInboxItem.findByPk(req.params.id);
    if (!item) return error(res, 'Inbox item not found.', 404);
    if (!item.filePath || !fs.existsSync(item.filePath)) {
      return error(res, 'The staged file is no longer on the server.', 404);
    }
    res.setHeader('Content-Type', item.mimeType || 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${(item.fileName || 'report.pdf').replace(/"/g, '')}"`);
    return res.sendFile(path.resolve(item.filePath));
  } catch (err) {
    console.error('LabInbox.serveFile error:', err);
    return error(res, 'Failed to open the file.', 500);
  }
};

// POST /api/lab-inbox/poll — manual "Pull now"
const poll = async (req, res) => {
  try {
    // Lazy require: the poller pulls in the IMAP client, which need not load
    // (or even be installed) for the rest of the inbox API to work.
    const { runPoll } = require('../services/labInboxPoller');
    const result = await runPoll({ trigger: 'manual', userId: req.user.id });
    return success(res, result);
  } catch (err) {
    console.error('LabInbox.poll error:', err);
    return error(res, err.message || 'Mailbox check failed. Check the email connection in System Settings.', 502);
  }
};

// POST /api/lab-inbox/:id/match  { uhid, testType, labName, testDate, notes, category }
const match = async (req, res) => {
  try {
    const { uhid, testType, labName, testDate, notes } = req.body;
    const documentCategory = req.body.category || req.body.documentCategory || DEFAULT_CATEGORY;

    if (!uhid) return error(res, 'A patient UHID is required to pair this report.', 400);

    const item = await LabInboxItem.findByPk(req.params.id);
    if (!item) return error(res, 'Inbox item not found.', 404);
    if (item.status === 'Matched') return error(res, 'This report has already been paired.', 409);
    if (item.status === 'Discarded') return error(res, 'This report was discarded. Restore it before pairing.', 409);
    if (!item.filePath || !fs.existsSync(item.filePath)) {
      return error(res, 'The staged file is missing on the server, so it cannot be paired.', 409);
    }

    if (testDate) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(testDate)) return error(res, 'Invalid test date. Use YYYY-MM-DD.', 400);
      if (testDate > clinicToday()) return error(res, 'Test date cannot be in the future.', 400);
    }

    const family = await resolvePatient(uhid);
    if (!family) return error(res, `Patient with UHID '${uhid}' not found.`, 404);
    if (family.isDeactivated) return error(res, 'This patient profile is inactive. Reports cannot be filed to it.', 403);
    const { patient } = family;

    // Copy (not move) the staged PDF into the documents store — the inbox row
    // keeps its own staged file for audit.
    if (!fs.existsSync(DOCUMENTS_DIR)) fs.mkdirSync(DOCUMENTS_DIR, { recursive: true });
    const ext = path.extname(item.fileName || item.filePath) || '.pdf';
    const newFilename = crypto.randomBytes(16).toString('hex') + ext;
    fs.copyFileSync(item.filePath, path.join(DOCUMENTS_DIR, newFilename));
    const size = fs.statSync(path.join(DOCUMENTS_DIR, newFilename)).size;

    const document = await createMedicalDocument({
      patient,
      actingUser: req.user,
      file: { originalName: item.fileName, filename: newFilename, size },
      documentCategory,
      testType: testType || item.subject || null,
      labName: labName || item.senderName || null,
      testDate: testDate || null,
      notes: notes || null,
      status: 'Pending Review', // a paired external report always awaits doctor sign-off
    });

    await item.update({
      status: 'Matched',
      matchedPatientId: patient.id,
      matchedDocumentId: document.id,
      matchedById: req.user.id,
      matchedAt: new Date(),
    });

    return success(res, {
      item: formatItem(await LabInboxItem.findByPk(item.id, withAssociations)),
      documentId: document.id,
      patient: patientBrief(patient),
    }, 201);
  } catch (err) {
    console.error('LabInbox.match error:', err);
    return error(res, 'Failed to pair the report. Please try again.', 500);
  }
};

// POST /api/lab-inbox/:id/discard  { reason }
const discard = async (req, res) => {
  try {
    const { reason } = req.body;
    const item = await LabInboxItem.findByPk(req.params.id);
    if (!item) return error(res, 'Inbox item not found.', 404);
    if (item.status === 'Matched') return error(res, 'This report is already paired to a patient and cannot be discarded.', 409);
    if (item.status === 'Discarded') return error(res, 'This report is already discarded.', 400);
    if (reason && reason.length > 255) return error(res, 'Reason is too long (max 255 characters).', 400);

    await item.update({
      status: 'Discarded',
      discardedById: req.user.id,
      discardedAt: new Date(),
      discardReason: reason || null,
    });

    return success(res, { item: formatItem(await LabInboxItem.findByPk(item.id, withAssociations)) });
  } catch (err) {
    console.error('LabInbox.discard error:', err);
    return error(res, 'Failed to discard the report. Please try again.', 500);
  }
};

module.exports = { list, count, serveFile, poll, match, discard };
