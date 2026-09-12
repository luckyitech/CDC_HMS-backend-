const { Op } = require('sequelize');
const crypto = require('crypto');
const { success, error } = require('../utils/response');
const { canActForPatient } = require('../utils/patientFamily');
const { clinicToday, clinicDatePlusDays, clinicDateTime, clinicMidnight } = require('../utils/clinicTime');
const { naiveToDate, dateToNaive, naiveDay, naiveHour, naiveDayStart, naiveDayEnd } = require('../utils/glucoseTime');
const G = require('../constants/glucose');
const db = require('../models');

const {
  GlucoseMeterReading, PatientMeter, PatientGlucoseTarget,
  BloodSugarReading, PatientVital, Patient, User,
} = db;

// Glucose Management Centre — controller.
//
// Every handler sits behind findPatient (routes/patients.js mounts
// routes/glucose.js at /:uhid/glucose), so req.patient / req.patientIds /
// req.isDeactivated are already resolved merge-aware (A4). Reads use
// req.patientIds; writes use req.patient.id and refuse a deactivated record.
//
// Three sources feed one summary: the home meter (GlucoseMeterReadings, this
// module), the manual logbook (BloodSugarReadings, untouched) and the clinic's
// own triage RBS (PatientVitals.rbs). Each row in the series says which. The
// maths live in constants/glucose.js so the doctor, the patient and any print
// see the same numbers.

// ====================================
// HELPERS
// ====================================

const num = (v) => (v === null || v === undefined ? null : Number(v));
const userName = (u) => (u ? `${u.role === 'doctor' ? 'Dr. ' : ''}${u.firstName} ${u.lastName}` : null);
const userInclude = (as) => ({ model: User, as, attributes: ['firstName', 'lastName', 'role'] });

const maskUhid = (uhid) => {
  const s = String(uhid || '');
  return s.length <= 2 ? '••' : `${s.slice(0, 3)}${'•'.repeat(Math.max(1, s.length - 4))}${s.slice(-1)}`;
};

const formatMeter = (m) => ({
  id: m.id,
  deviceSerial: m.deviceSerial,
  deviceModel: m.deviceModel,
  deviceModelId: m.deviceModelId,
  firmware: m.firmware,
  status: m.status,
  shared: !!m.shared,
  usedFromDate: m.usedFromDate || null,
  firstLinkedAt: m.firstLinkedAt,
  linkedByName: userName(m.linkedBy),
  linkReason: m.linkReason,
  retiredAt: m.retiredAt,
  retiredByName: userName(m.retiredBy),
  retireReason: m.retireReason,
  lastSequenceNumber: m.lastSequenceNumber,
  lastSyncAt: m.lastSyncAt,
  lastClockDeltaSec: m.lastClockDeltaSec,
  clockCorrectedAt: m.clockCorrectedAt,
});

const formatReading = (r) => {
  const mgdl = num(r.glucoseMgdl);
  const flags = G.statusFlags(r.sensorStatus);
  const control = r.sampleType === G.SAMPLE_TYPE_CONTROL_SOLUTION;
  const meterExcluded = (r.sensorStatus & G.EXCLUDING_STATUS_MASK) !== 0;
  return {
    id: r.id,
    source: 'meter',
    at: dateToNaive(r.measuredAt),
    mgdl,
    mmol: G.mgdlToMmol(mgdl),
    deviceSerial: r.deviceSerial,
    sequenceNumber: r.sequenceNumber,
    sampleType: r.sampleType,
    sensorStatus: r.sensorStatus,
    flags,
    controlSolution: control,
    plausible: G.isPlausible(mgdl),
    tag: r.contextTag,
    tagSource: r.contextSource,
    importBatchId: r.importBatchId,
    importedByName: userName(r.importedBy),
    importedByRole: r.importedByRole,
    hostClockDeltaSec: r.hostClockDeltaSec,
    status: r.status,
    excluded: r.status === 'Excluded',
    excludeReason: r.excludeReason,
    excludedByName: userName(r.excludedBy),
    excludedAt: r.excludedAt,
    // Counted in the metrics only when nothing rules it out.
    countable: r.status === 'Active' && !control && !meterExcluded,
  };
};

// Effective targets for a patient: consensus, overridden by the row if any.
const effectiveTargets = (row) => {
  if (!row) return { targets: { ...G.CONSENSUS_TARGETS }, individualised: false, meta: null };
  const override = {};
  for (const k of Object.keys(G.CONSENSUS_TARGETS)) {
    if (row[k] !== null && row[k] !== undefined) override[k] = Number(row[k]);
  }
  const individualised = Object.keys(override).length > 0;
  return {
    targets: { ...G.CONSENSUS_TARGETS, ...override },
    individualised,
    meta: {
      preset: row.preset,
      rationale: row.rationale,
      setAt: row.setAt,
      setByName: userName(row.setBy),
    },
  };
};

// Which serial↔patient state a meter is in for THIS patient. Shared by the
// preflight endpoint and the import, so the two can never disagree.
//   linked    — Active link on this patient
//   unlinked  — no Active link anywhere
//   conflict  — Active link on another patient (not marked shared)
//   shared    — Active on another patient AND on this one, marked shared
const linkStateFor = async (serial, patientIds) => {
  const active = await PatientMeter.findAll({
    where: { deviceSerial: serial, status: 'Active' },
    include: [{ model: Patient, attributes: ['id', 'uhid', 'firstName', 'lastName'] }, userInclude('linkedBy')],
    order: [['firstLinkedAt', 'ASC']],
  });
  const mine   = active.find((m) => patientIds.includes(m.PatientId)) || null;
  const others = active.filter((m) => !patientIds.includes(m.PatientId));
  let state = 'unlinked';
  if (mine && others.length === 0) state = 'linked';
  else if (mine && others.length) state = 'shared';
  else if (!mine && others.length) state = 'conflict';
  return {
    state,
    mine,
    others: others.map((m) => ({
      id: m.id,
      patientMasked: maskUhid(m.Patient?.uhid),
      firstLinkedAt: m.firstLinkedAt,
      usedFromDate: m.usedFromDate,
      shared: !!m.shared,
    })),
  };
};

// Highest sequence number this patient already holds from a meter — what the
// client asks the meter for "everything after".
const lastSeqFor = async (serial, patientIds) => {
  const row = await GlucoseMeterReading.findOne({
    where: { deviceSerial: serial, PatientId: { [Op.in]: patientIds } },
    order: [['sequenceNumber', 'DESC']],
    attributes: ['sequenceNumber'],
  });
  return row ? row.sequenceNumber : null;
};

// Resolve the window from ?days | ?from&to (clinic dates, inclusive).
const windowFrom = (query) => {
  const today = clinicToday();
  if (query.from && query.to) return { from: String(query.from), to: String(query.to) };
  const days = Math.min(Math.max(parseInt(query.days, 10) || 14, 1), 366);
  return { from: clinicDatePlusDays(-(days - 1)), to: today, days };
};

// ====================================
// GET /api/patients/:uhid/glucose/meters
// ====================================
const listMeters = async (req, res) => {
  try {
    if (!canActForPatient(req)) return error(res, 'Access denied', 403);
    const meters = await PatientMeter.findAll({
      where: { PatientId: { [Op.in]: req.patientIds } },
      include: [userInclude('linkedBy'), userInclude('retiredBy')],
      order: [['status', 'ASC'], ['firstLinkedAt', 'DESC']],
    });
    return success(res, meters.map(formatMeter));
  } catch (err) {
    console.error('Glucose.listMeters error:', err);
    return error(res, 'Failed to load meters', 500);
  }
};

// ====================================
// POST /api/patients/:uhid/glucose/meter/preflight
// Body: { serial, modelId?, firmware?, name? }
// The client calls this after connecting and BEFORE asking the meter for
// records: it learns whether the serial is linked / unknown / on someone
// else, and the last sequence number, so it can fetch incrementally and show
// the right preview.
// ====================================
const preflight = async (req, res) => {
  try {
    if (!canActForPatient(req)) return error(res, 'Access denied', 403);
    const serial = String(req.body.serial || G.serialFromAdvertisedName(req.body.name) || '').trim();
    if (!serial) return error(res, 'Meter serial is required', 400);

    const link = await linkStateFor(serial, req.patientIds);
    const lastSequenceNumber = await lastSeqFor(serial, req.patientIds);
    return success(res, {
      serial,
      modelName: G.meterModelName(req.body.modelId),
      link: link.state,
      meter: link.mine ? formatMeter(link.mine) : null,
      others: link.others,
      lastSequenceNumber,
      usedFromDate: link.mine?.usedFromDate || null,
      plausible: G.PLAUSIBLE,
      clockDrift: G.CLOCK_DRIFT,
    });
  } catch (err) {
    console.error('Glucose.preflight error:', err);
    return error(res, 'Failed to check meter', 500);
  }
};

// ====================================
// POST /api/patients/:uhid/glucose/meter/import
// Body: {
//   device:   { serial, modelId, firmware, name, browserId },
//   readings: [{ sequenceNumber, measuredAt:'YYYY-MM-DD HH:mm:ss', timeOffsetMin,
//                glucoseMgdl, unitsReported, sampleType, sampleLocation,
//                sensorStatus, mealFlag, rawHex }],
//   hostTime: 'YYYY-MM-DD HH:mm:ss' (the PC's clock, naive),
//   meterTime: 'YYYY-MM-DD HH:mm:ss' | null (the meter's clock, 0x2A08, naive),
//   batchId?: string,
//   link?:    { action: 'link' | 'reassign' | 'share', usedFromDate?, reason? },
//   excludeSequenceNumbers?: [n, …]  (rows the clinician flagged in the preview)
// }
// Safety rules (plan §8): nothing is filed without a resolved link; a serial
// Active on another patient is a hard stop unless `link` says how to resolve
// it; idempotent on (serial, seq); readings before the link's usedFromDate are
// skipped; provenance on every row; the meter's time is never rewritten.
// ====================================
const importMeter = async (req, res) => {
  try {
    if (!canActForPatient(req)) return error(res, 'Access denied', 403);
    if (req.isDeactivated) return error(res, 'This patient profile is inactive. Readings cannot be imported.', 403);

    const device = req.body.device || {};
    const serial = String(device.serial || G.serialFromAdvertisedName(device.name) || '').trim();
    if (!serial) return error(res, 'Meter serial is required', 400);
    const readings = Array.isArray(req.body.readings) ? req.body.readings : [];
    if (!readings.length) return error(res, 'No readings to import', 400);

    const isPatient = req.user.role === 'patient';
    const importedByRole = isPatient ? 'patient' : 'clinic';
    const now = new Date();

    // ---- clock drift: host − meter, seconds (null when the meter didn't say)
    const hostT = naiveToDate(req.body.hostTime) || null;
    const meterT = naiveToDate(req.body.meterTime) || null;
    const clockDeltaSec = hostT && meterT ? Math.round((hostT - meterT) / 1000) : null;

    // ---- resolve the serial ↔ patient link
    const link = await linkStateFor(serial, req.patientIds);
    const wanted = req.body.link || null;
    let meter = link.mine;
    const modelName = G.meterModelName(device.modelId);

    if (link.state === 'conflict' || (link.state === 'unlinked' && !wanted)) {
      if (link.state === 'conflict' && !wanted) {
        return error(res, 'This meter is linked to a different patient. Nothing was imported.', 409, {
          code: 'METER_CONFLICT', others: link.others,
        });
      }
      if (link.state === 'unlinked') {
        return error(res, 'This meter is not linked to the patient yet — confirm the link first.', 409, { code: 'METER_UNLINKED' });
      }
    }

    if (!meter) {
      // Linking happens here, in the same request as the import, so a link is
      // never created without readings behind it. Patients (Phase 2) may link
      // an unknown meter to themselves; only clinic users may resolve a
      // conflict — and they do it with the date the patient started using it.
      const action = wanted?.action;
      if (link.state === 'conflict') {
        if (isPatient) {
          return error(res, 'This meter is registered to another patient. Please ask the clinic to sort this out at your next visit.', 403, { code: 'METER_CONFLICT' });
        }
        if (!['reassign', 'share'].includes(action)) {
          return error(res, 'Say how to resolve the conflict: re-assign the meter or mark it shared.', 400, { code: 'METER_CONFLICT', others: link.others });
        }
        if (action === 'reassign' && !wanted.usedFromDate) {
          return error(res, 'Re-assigning a meter needs the date this patient started using it.', 400, { code: 'USED_FROM_REQUIRED' });
        }
        if (!wanted.reason || !String(wanted.reason).trim()) {
          return error(res, 'A reason is required to override the meter link.', 400, { code: 'REASON_REQUIRED' });
        }
        if (action === 'reassign') {
          await PatientMeter.update(
            { status: 'Retired', retiredAt: now, retiredById: req.user.id, retireReason: `Re-assigned to ${req.patient.uhid}: ${String(wanted.reason).trim()}` },
            { where: { id: link.others.map((o) => o.id) } }
          );
        } else {
          await PatientMeter.update({ shared: true }, { where: { id: link.others.map((o) => o.id) } });
        }
      } else if (action !== 'link') {
        return error(res, 'Confirm the meter belongs to this patient before importing.', 400, { code: 'METER_UNLINKED' });
      }

      meter = await PatientMeter.create({
        PatientId: req.patient.id,
        deviceSerial: serial,
        deviceModel: modelName,
        deviceModelId: device.modelId || null,
        firmware: device.firmware || null,
        status: 'Active',
        shared: link.state === 'conflict' && action === 'share',
        firstLinkedAt: now,
        linkedById: req.user.id,
        linkReason: link.state === 'conflict' ? `${action}: ${String(wanted.reason).trim()}` : null,
        usedFromDate: wanted?.usedFromDate || null,
      });
    } else if (device.firmware && meter.firmware !== device.firmware) {
      meter.firmware = device.firmware;
    }

    // ---- file the readings
    const usedFrom = meter.usedFromDate ? naiveDayStart(meter.usedFromDate) : null;
    const excludeSet = new Set((req.body.excludeSequenceNumbers || []).map(Number));
    const batchId = String(req.body.batchId || `b-${clinicToday()}-${crypto.randomBytes(3).toString('hex')}`).slice(0, 40);

    const existing = await GlucoseMeterReading.findAll({
      where: { deviceSerial: serial, sequenceNumber: { [Op.in]: readings.map((r) => Number(r.sequenceNumber)) } },
      attributes: ['sequenceNumber'],
    });
    const have = new Set(existing.map((e) => e.sequenceNumber));

    const rows = [];
    let duplicates = 0, skippedBeforeUsedFrom = 0, invalid = 0, excluded = 0, maxSeq = meter.lastSequenceNumber || 0;
    for (const r of readings) {
      const seq = Number(r.sequenceNumber);
      const at = naiveToDate(r.measuredAt);
      const mgdl = Number(r.glucoseMgdl);
      if (!Number.isInteger(seq) || !at || !Number.isFinite(mgdl)) { invalid++; continue; }
      if (have.has(seq)) { duplicates++; continue; }
      if (usedFrom && at < usedFrom) { skippedBeforeUsedFrom++; continue; }
      const flagged = excludeSet.has(seq);
      if (flagged) excluded++;
      if (seq > maxSeq) maxSeq = seq;
      rows.push({
        PatientId: req.patient.id,
        PatientMeterId: meter.id,
        deviceSerial: serial,
        sequenceNumber: seq,
        measuredAt: at,
        timeOffsetMin: r.timeOffsetMin ?? null,
        glucoseMgdl: mgdl,
        unitsReported: r.unitsReported === 'mol/L' ? 'mol/L' : 'kg/L',
        sampleType: r.sampleType ?? null,
        sampleLocation: r.sampleLocation ?? null,
        sensorStatus: Number(r.sensorStatus) || 0,
        mealFlag: r.mealFlag ?? null,
        contextTag: G.bucketForHour(naiveHour(at)),
        contextSource: 'clock',
        importBatchId: batchId,
        importedById: req.user.id,
        importedByRole,
        hostClockDeltaSec: clockDeltaSec,
        rawHex: r.rawHex ? String(r.rawHex).slice(0, 64) : null,
        status: flagged ? 'Excluded' : 'Active',
        excludeReason: flagged ? 'Flagged at import (implausible value)' : null,
        excludedById: flagged ? req.user.id : null,
        excludedAt: flagged ? now : null,
      });
    }

    if (rows.length) {
      // ignoreDuplicates keeps a race (two PCs, one meter) from failing the
      // whole batch — the unique index is the real guard.
      await GlucoseMeterReading.bulkCreate(rows, { ignoreDuplicates: true });
    }

    meter.lastSequenceNumber = maxSeq || meter.lastSequenceNumber;
    meter.lastSyncAt = now;
    meter.lastClockDeltaSec = clockDeltaSec;
    await meter.save();

    return success(res, {
      batchId,
      inserted: rows.length,
      excluded,
      duplicates,
      skippedBeforeUsedFrom,
      invalid,
      clockDeltaSec,
      clockDriftWarn: clockDeltaSec !== null && Math.abs(clockDeltaSec) > G.CLOCK_DRIFT.warnSec,
      meter: formatMeter(await PatientMeter.findByPk(meter.id, { include: [userInclude('linkedBy')] })),
    }, 201);
  } catch (err) {
    console.error('Glucose.importMeter error:', err);
    return error(res, 'Failed to import readings', 500);
  }
};

// ====================================
// GET /api/patients/:uhid/glucose/batches — one row per import (Visit History)
// ====================================
const listBatches = async (req, res) => {
  try {
    if (!canActForPatient(req)) return error(res, 'Access denied', 403);
    const rows = await GlucoseMeterReading.findAll({
      where: { PatientId: { [Op.in]: req.patientIds } },
      attributes: ['importBatchId', 'deviceSerial', 'importedById', 'importedByRole', 'hostClockDeltaSec', 'createdAt', 'measuredAt', 'sequenceNumber'],
      include: [userInclude('importedBy')],
      order: [['createdAt', 'DESC']],
    });
    const byBatch = new Map();
    for (const r of rows) {
      const b = byBatch.get(r.importBatchId) || {
        batchId: r.importBatchId, deviceSerial: r.deviceSerial, importedAt: r.createdAt,
        importedByName: userName(r.importedBy), importedByRole: r.importedByRole,
        hostClockDeltaSec: r.hostClockDeltaSec, count: 0, firstAt: null, lastAt: null, minSeq: null, maxSeq: null,
      };
      b.count++;
      const at = dateToNaive(r.measuredAt);
      if (!b.firstAt || at < b.firstAt) b.firstAt = at;
      if (!b.lastAt || at > b.lastAt) b.lastAt = at;
      b.minSeq = b.minSeq === null ? r.sequenceNumber : Math.min(b.minSeq, r.sequenceNumber);
      b.maxSeq = b.maxSeq === null ? r.sequenceNumber : Math.max(b.maxSeq, r.sequenceNumber);
      byBatch.set(r.importBatchId, b);
    }
    return success(res, [...byBatch.values()]);
  } catch (err) {
    console.error('Glucose.listBatches error:', err);
    return error(res, 'Failed to load imports', 500);
  }
};

// ====================================
// PUT /api/patients/:uhid/glucose/meter/readings/:id/exclude  { reason }
// PUT /api/patients/:uhid/glucose/meter/readings/:id/restore
// Soft-exclude with attribution; nothing is deleted.
// ====================================
const setReadingStatus = (target) => async (req, res) => {
  try {
    if (req.isDeactivated) return error(res, 'This patient profile is inactive.', 403);
    const row = await GlucoseMeterReading.findOne({
      where: { id: req.params.id, PatientId: { [Op.in]: req.patientIds } },
    });
    if (!row) return error(res, 'Reading not found', 404);
    if (target === 'Excluded') {
      const reason = String(req.body.reason || '').trim();
      if (!reason) return error(res, 'A reason is required to exclude a reading', 400);
      Object.assign(row, { status: 'Excluded', excludeReason: reason, excludedById: req.user.id, excludedAt: new Date() });
    } else {
      Object.assign(row, { status: 'Active', excludeReason: null, excludedById: null, excludedAt: null });
    }
    await row.save();
    const fresh = await GlucoseMeterReading.findByPk(row.id, { include: [userInclude('importedBy'), userInclude('excludedBy')] });
    return success(res, formatReading(fresh));
  } catch (err) {
    console.error('Glucose.setReadingStatus error:', err);
    return error(res, 'Failed to update reading', 500);
  }
};

// ====================================
// PUT /api/patients/:uhid/glucose/meters/:id/clock-corrected
// PUT /api/patients/:uhid/glucose/meters/:id/retire  { reason }
// ====================================
const meterAction = (action) => async (req, res) => {
  try {
    if (req.isDeactivated) return error(res, 'This patient profile is inactive.', 403);
    const meter = await PatientMeter.findOne({ where: { id: req.params.id, PatientId: { [Op.in]: req.patientIds } } });
    if (!meter) return error(res, 'Meter not found', 404);
    if (action === 'clock-corrected') {
      meter.clockCorrectedAt = new Date();
      meter.lastClockDeltaSec = 0;
    } else {
      const reason = String(req.body.reason || '').trim();
      if (!reason) return error(res, 'A reason is required to retire a meter', 400);
      Object.assign(meter, { status: 'Retired', retiredAt: new Date(), retiredById: req.user.id, retireReason: reason });
    }
    await meter.save();
    const fresh = await PatientMeter.findByPk(meter.id, { include: [userInclude('linkedBy'), userInclude('retiredBy')] });
    return success(res, formatMeter(fresh));
  } catch (err) {
    console.error('Glucose.meterAction error:', err);
    return error(res, 'Failed to update meter', 500);
  }
};

// ====================================
// GET /api/patients/:uhid/glucose/targets
// PUT /api/patients/:uhid/glucose/targets  { preset?, <target keys>…, rationale }
// ====================================
const getTargets = async (req, res) => {
  try {
    if (!canActForPatient(req)) return error(res, 'Access denied', 403);
    const row = await PatientGlucoseTarget.findOne({ where: { PatientId: { [Op.in]: req.patientIds } }, include: [userInclude('setBy')] });
    return success(res, { ...effectiveTargets(row), consensus: G.CONSENSUS_TARGETS, presets: G.TARGET_PRESETS });
  } catch (err) {
    console.error('Glucose.getTargets error:', err);
    return error(res, 'Failed to load targets', 500);
  }
};

const putTargets = async (req, res) => {
  try {
    if (req.isDeactivated) return error(res, 'This patient profile is inactive.', 403);
    const rationale = String(req.body.rationale || '').trim();
    if (!rationale) return error(res, 'A rationale is required when setting individual targets', 400);

    const preset = req.body.preset && G.TARGET_PRESETS[req.body.preset] ? req.body.preset : null;
    const values = {};
    for (const k of Object.keys(G.CONSENSUS_TARGETS)) {
      const v = req.body[k];
      if (v === null || v === undefined || v === '') { values[k] = null; continue; }
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) return error(res, `${k} must be a number`, 400);
      values[k] = n;
    }
    // A preset fills in its values; explicit keys in the body still win.
    if (preset) {
      for (const [k, v] of Object.entries(G.TARGET_PRESETS[preset].values)) {
        if (values[k] === null) values[k] = v;
      }
    }
    // Sanity: bands must be ordered.
    const eff = { ...G.CONSENSUS_TARGETS, ...Object.fromEntries(Object.entries(values).filter(([, v]) => v !== null)) };
    if (!(eff.tbrLevel2Mgdl < eff.tirLowMgdl && eff.tirLowMgdl < eff.tirHighMgdl && eff.tirHighMgdl <= eff.tarLevel2Mgdl)) {
      return error(res, 'Targets must be ordered: level-2 low < in-range low < in-range high ≤ level-2 high', 400);
    }
    if (!(eff.fastingLowMgdl < eff.fastingHighMgdl)) return error(res, 'Fasting band must be low < high', 400);

    const [row] = await PatientGlucoseTarget.findOrCreate({
      where: { PatientId: req.patient.id },
      defaults: { PatientId: req.patient.id, rationale, setById: req.user.id, setAt: new Date() },
    });
    Object.assign(row, values, { preset, rationale, setById: req.user.id, setAt: new Date() });
    await row.save();
    const fresh = await PatientGlucoseTarget.findByPk(row.id, { include: [userInclude('setBy')] });
    return success(res, { ...effectiveTargets(fresh), consensus: G.CONSENSUS_TARGETS, presets: G.TARGET_PRESETS });
  } catch (err) {
    console.error('Glucose.putTargets error:', err);
    return error(res, 'Failed to save targets', 500);
  }
};

// ====================================
// GET /api/patients/:uhid/glucose/summary?days=14 | from&to · sources=meter,logbook,clinic
// The §6 metrics + the unified series, server-side, so every screen agrees.
// ====================================
const summary = async (req, res) => {
  try {
    if (!canActForPatient(req)) return error(res, 'Access denied', 403);
    const win = windowFrom(req.query);
    const sources = new Set(String(req.query.sources || 'meter,logbook,clinic').split(',').map((s) => s.trim()).filter(Boolean));
    const pid = { [Op.in]: req.patientIds };

    const [targetRow, meters] = await Promise.all([
      PatientGlucoseTarget.findOne({ where: { PatientId: pid }, include: [userInclude('setBy')] }),
      PatientMeter.findAll({ where: { PatientId: pid }, include: [userInclude('linkedBy')], order: [['status', 'ASC'], ['lastSyncAt', 'DESC']] }),
    ]);
    const tgt = effectiveTargets(targetRow);

    const series = [];   // unified rows for the maths + the chart

    if (sources.has('meter')) {
      const rows = await GlucoseMeterReading.findAll({
        where: { PatientId: pid, measuredAt: { [Op.between]: [naiveDayStart(win.from), naiveDayEnd(win.to)] } },
        include: [userInclude('importedBy'), userInclude('excludedBy')],
        order: [['measuredAt', 'ASC']],
      });
      for (const r of rows) {
        const f = formatReading(r);
        series.push({ ...f, dayKey: f.at.slice(0, 10), hour: naiveHour(r.measuredAt), bucket: r.contextTag || G.bucketForHour(naiveHour(r.measuredAt)) });
      }
    }

    if (sources.has('logbook')) {
      const rows = await BloodSugarReading.findAll({
        where: { PatientId: pid, date: { [Op.between]: [win.from, win.to] } },
        order: [['date', 'ASC']],
      });
      for (const r of rows) {
        const slot = G.LOGBOOK_SLOTS[r.timeSlot] || G.LOGBOOK_SLOTS.fasting;
        const mgdl = num(r.value);
        const at = `${r.date} ${String(slot.hour).padStart(2, '0')}:${String(slot.minute).padStart(2, '0')}:00`;
        series.push({
          id: `log-${r.id}`, source: r.recordedByRole === 'clinic' ? 'clinic' : 'logbook', at, mgdl, mmol: G.mgdlToMmol(mgdl),
          tag: r.timeSlot, tagLabel: slot.label, tagSource: 'manual', displayTime: r.time || null,
          plausible: G.isPlausible(mgdl), countable: true, excluded: false, flags: [],
          dayKey: r.date, hour: slot.hour, bucket: slot.bucket,
        });
      }
    }

    if (sources.has('clinic')) {
      // recordedAt is a real instant; fetch by clinic midnights, then trim on
      // the clinic calendar so the window matches the other two sources.
      const rows = await PatientVital.findAll({
        where: { PatientId: pid, rbs: { [Op.ne]: null }, recordedAt: { [Op.gte]: clinicMidnight(win.from), [Op.lt]: clinicMidnight(clinicDatePlusDays(1, clinicMidnight(win.to))) } },
        order: [['recordedAt', 'ASC']],
      });
      for (const r of rows) {
        const at = clinicDateTime(r.recordedAt);
        const day = at.slice(0, 10);
        if (day < win.from || day > win.to) continue;
        const mgdl = G.mmolToMgdl(num(r.rbs));           // triage RBS is entered in mmol/L
        const hour = Number(at.slice(11, 13));
        series.push({
          id: `vital-${r.id}`, source: 'clinic', at, mgdl, mmol: G.mgdlToMmol(mgdl),
          tag: 'clinic RBS', tagSource: 'manual', plausible: G.isPlausible(mgdl), countable: true, excluded: false, flags: [],
          dayKey: day, hour, bucket: G.bucketForHour(hour),
        });
      }
    }

    series.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    const metrics = G.summarise(series, tgt.targets);

    // Latest HbA1c for the overlay: triage first, then the patient record.
    const lastA1c = await PatientVital.findOne({ where: { PatientId: pid, hba1c: { [Op.ne]: null } }, order: [['recordedAt', 'DESC']], attributes: ['hba1c', 'recordedAt'] });
    const hba1c = lastA1c
      ? { value: num(lastA1c.hba1c), at: clinicDateTime(lastA1c.recordedAt), source: 'triage' }
      : (req.patient.hba1c ? { value: num(req.patient.hba1c) || null, at: null, source: 'record' } : null);

    return success(res, {
      window: win,
      sources: [...sources],
      metrics,
      targets: { ...tgt, consensus: G.CONSENSUS_TARGETS, presets: G.TARGET_PRESETS },
      hba1c,
      meters: meters.map(formatMeter),
      readings: series.map(({ dayKey, hour, ...r }) => r),
      timeOfDay: G.TIME_OF_DAY,
      unitsFactor: G.MGDL_PER_MMOL,
    });
  } catch (err) {
    console.error('Glucose.summary error:', err);
    return error(res, 'Failed to build glucose summary', 500);
  }
};

module.exports = {
  listMeters, preflight, importMeter, listBatches,
  excludeReading: setReadingStatus('Excluded'),
  restoreReading: setReadingStatus('Active'),
  meterClockCorrected: meterAction('clock-corrected'),
  retireMeter: meterAction('retire'),
  getTargets, putTargets, summary,
};
