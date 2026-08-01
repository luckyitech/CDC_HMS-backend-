const { success, error } = require('../utils/response');
const db = require('../models');
const { resolvePatient } = require('../utils/patientFamily');
const { code128Png } = require('../utils/code128png');
const { sendPatientBarcodeEmail } = require('../utils/emailService');

const { Patient, BarcodeScan, User, StockBatch, StockItem, StockLevel, StockLocation } = db;
const { Op } = require('sequelize');

// Normalise a scanned payload.
const normalise = (raw) => String(raw || '').trim().toUpperCase();

// ------------------------------------
// Payload namespace routing.
// One scanner, one endpoint, many record types. The payload prefix decides
// what a scan means; adding a future service = add an entry here and a
// resolver branch below. Nothing else changes.
//
//   CDC###        patient UHID                    → live (this file)
//   LAB-YYYY-NNN  lab test (generateLabTestNumber) → future lab service
//   RX-YYYY-NNN   prescription (generatePrescriptionNumber) → future pharmacy service
//   AST-…         clinic asset                     → future asset module
//   STK-…         stock item                       → future stock module
// ------------------------------------
const NAMESPACES = [
  { type: 'patient',      pattern: /^CDC\d+$/, live: true  },
  { type: 'labTest',      pattern: /^LAB-/,    live: false },
  { type: 'prescription', pattern: /^RX-/,     live: false },
  { type: 'asset',        pattern: /^AST-/,    live: false },
  { type: 'stock',        pattern: /^STK-/,    live: true  },   // batch shelf labels (stock module)
];

const classify = (payload) =>
  NAMESPACES.find((ns) => ns.pattern.test(payload)) || null;

// ------------------------------------
// GET /api/patients/scan/:payload
// Resolve a scanned barcode. Currently only the patient namespace is live;
// unrecognised payloads fall through to a plain UHID lookup (staff can
// hand-enter non-CDC UHIDs at registration).
//
// Merge-aware by design: a card or file label printed BEFORE a merge still
// scans afterwards. resolvePatient returns the merged-away record as
// isDeactivated; instead of refusing it, we follow mergedIntoId to the
// surviving canonical patient so reception lands on the right record.
// Query: ?source=usb|camera (audit only, defaults to usb).
// ------------------------------------
const resolveScan = async (req, res) => {
  try {
    const payload = normalise(req.params.payload);
    if (!payload) return error(res, 'Empty scan', 400);

    const ns = classify(payload);

    // Recognised-but-not-yet-live namespaces — clean message, no lookup.
    // When the lab / pharmacy / asset service lands, replace this with a
    // branch that resolves and returns { type: ns.type, ... }.
    if (ns && !ns.live) {
      return error(res, 'This code type is not supported yet', 404);
    }

    // --- Stock batch shelf label (STK-000123) ---
    // Resolves to the batch + item + current per-location quantities so the
    // stock screens can pre-fill from a scan. Audited like every other scan.
    if (ns && ns.type === 'stock') {
      const batch = await StockBatch.findOne({
        where: { labelCode: payload },
        include: [
          { model: StockItem, as: 'item', attributes: ['id', 'name', 'unit', 'category', 'requiresColdChain', 'isHighAlert'] },
          {
            model: StockLevel, as: 'levels',
            where: { quantity: { [Op.gt]: 0 } },
            required: false,
            include: [{ model: StockLocation, as: 'location', attributes: ['id', 'name'] }],
          },
        ],
      });
      if (!batch) return error(res, 'Stock label not recognised', 404);

      BarcodeScan.create({
        PatientId:    null,
        scannedBy:    req.user.id,
        rawPayload:   payload,
        resolvedType: 'stock',
        action:       'scan',
        source:       req.query.source === 'camera' ? 'camera' : 'usb',
      }).catch((e) => console.error('Barcode.resolveScan audit error:', e));

      return success(res, {
        type: 'stock',
        batch: {
          id: batch.id,
          labelCode: batch.labelCode,
          batchNo: batch.batchNo,
          expiryDate: batch.expiryDate,
          status: batch.status,
        },
        item: batch.item,
        levels: (batch.levels || []).map((l) => ({
          locationId: l.location?.id,
          locationName: l.location?.name,
          quantity: l.quantity,
        })),
      });
    }

    const family = await resolvePatient(payload);
    if (!family) return error(res, 'Patient not found', 404);

    let patient = family.patient;
    let redirectedFrom = null;

    // Merged-away UHID → jump to the canonical patient.
    if (family.isDeactivated && patient.mergedIntoId) {
      const canonical = await Patient.findByPk(patient.mergedIntoId);
      if (!canonical) return error(res, 'Patient not found', 404);
      redirectedFrom = patient.uhid;
      patient = canonical;
    }

    // Append-only audit. Non-blocking: a logging failure must not break a scan.
    // resolvedType/PatientId-nullable keep this table reusable when lab,
    // pharmacy, asset and stock scans go live. Feeds the admin Activity Log.
    BarcodeScan.create({
      PatientId:          patient.id,
      scannedBy:          req.user.id,
      rawPayload:         payload,
      resolvedType:       'patient',
      action:             'scan',
      redirectedFromUhid: redirectedFrom,
      source:             req.query.source === 'camera' ? 'camera' : 'usb',
    }).catch((e) => console.error('Barcode.resolveScan audit error:', e));

    // type lets the frontend route by record kind once lab/pharmacy scans go
    // live ('labTest' → lab portal, 'prescription' → pharmacy, …).
    return success(res, {
      type:           'patient',
      uhid:           patient.uhid,
      name:           `${patient.firstName} ${patient.lastName}`,
      redirectedFrom, // null on a normal scan; the old UHID when we redirected
    });
  } catch (err) {
    console.error('Barcode.resolveScan error:', err);
    return error(res, 'Failed to resolve scan', 500);
  }
};

// ------------------------------------
// POST /api/patients/:uhid/barcode-email
// Email the patient their identity card barcode (Code128 PNG, rendered
// server-side with zero dependencies — see utils/code128png).
//
// Route uses findPatient, so req.patient / req.isDeactivated are set.
// A merged-away record is refused: the card should always carry the
// canonical UHID, so staff email it from the surviving record.
// ------------------------------------
const emailBarcode = async (req, res) => {
  try {
    if (req.isDeactivated) {
      return error(res, 'This patient was merged into another record. Email the barcode from the current record.', 403);
    }

    const patient = req.patient;
    if (!patient.email) {
      return error(res, 'This patient has no email address on file. Add one via Edit Profile first.', 400);
    }

    const png = code128Png(patient.uhid);

    // Treating doctor for the card (nullable — omitted from the email if unset).
    let doctorName = null;
    if (patient.primaryDoctorId) {
      const doc = await User.findByPk(patient.primaryDoctorId, {
        attributes: ['firstName', 'lastName'],
      });
      if (doc) doctorName = `Dr. ${doc.firstName} ${doc.lastName}`;
    }

    // Same fire-and-forget contract as the welcome emails: sendEmail logs
    // failures rather than throwing, so a mail outage never breaks the UI.
    await sendPatientBarcodeEmail({
      to:      patient.email,
      name:    `${patient.firstName} ${patient.lastName}`,
      uhid:    patient.uhid,
      dob:     patient.dateOfBirth,
      doctor:  doctorName,
      pngBuffer: png,
    });

    // Activity Log event (non-blocking).
    BarcodeScan.create({
      PatientId:    patient.id,
      scannedBy:    req.user.id,
      rawPayload:   patient.uhid,
      resolvedType: 'patient',
      action:       'email',
      source:       null,
    }).catch((e) => console.error('Barcode.emailBarcode audit error:', e));

    return success(res, { message: `Barcode card sent to ${patient.email}` });
  } catch (err) {
    console.error('Barcode.emailBarcode error:', err);
    return error(res, 'Failed to send barcode email', 500);
  }
};

// ------------------------------------
// POST /api/patients/:uhid/barcode-event
// Log a client-side barcode generation (card / label print) so it appears in
// the admin Activity Log. Printing happens in the browser, so the frontend
// reports it here. Route uses findPatient.
// ------------------------------------
const GENERATE_ACTIONS = ['print_card', 'print_label'];

const logBarcodeGenerated = async (req, res) => {
  try {
    if (req.isDeactivated) {
      return error(res, 'This patient was merged into another record.', 403);
    }
    const { action } = req.body;
    if (!GENERATE_ACTIONS.includes(action)) {
      return error(res, 'Invalid barcode event action', 400);
    }

    await BarcodeScan.create({
      PatientId:    req.patient.id,
      scannedBy:    req.user.id,
      rawPayload:   req.patient.uhid,
      resolvedType: 'patient',
      action,
      source:       null,
    });

    return success(res, { message: 'Logged' });
  } catch (err) {
    console.error('Barcode.logBarcodeGenerated error:', err);
    return error(res, 'Failed to log barcode event', 500);
  }
};

module.exports = { resolveScan, emailBarcode, logBarcodeGenerated };
