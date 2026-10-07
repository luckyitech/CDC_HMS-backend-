// Remote requests — the pure rules (6 Oct 2026). A prescription or lab
// request written outside a consultation. DB work in services/remoteRequests
// and controllers/remoteRequestController.

const CHANNELS = ['phone', 'whatsapp', 'email', 'walk_in'];
const ASKERS = ['patient', 'relative', 'pharmacy'];
const CHANNEL_LABEL = { phone: 'Phone', whatsapp: 'WhatsApp', email: 'Email', walk_in: 'Walk-in, no visit' };
const ASKER_LABEL = { patient: 'Patient', relative: 'Relative / caregiver', pharmacy: 'Pharmacy' };
const NOTE_MAX = 4000;

const clip = (v, max) => (v == null ? '' : String(v).trim().slice(0, max));

/**
 * Validates a new remote request. Returns { ok: true, value } or
 * { ok: false, code, message }. A relative or pharmacy must be named; the
 * clinical note is required (Emu, 6 Oct).
 */
const cleanRequest = (body = {}) => {
  if (!CHANNELS.includes(body.channel)) return { ok: false, code: 'BAD_CHANNEL', message: 'Say how the request came in.' };
  if (!ASKERS.includes(body.requestedByType)) return { ok: false, code: 'BAD_ASKER', message: 'Say who asked.' };
  const requestedByName = clip(body.requestedByName, 120);
  if (body.requestedByType !== 'patient' && !requestedByName) {
    return { ok: false, code: 'NAME_REQUIRED', message: body.requestedByType === 'pharmacy' ? 'Name the pharmacy.' : 'Name the relative or caregiver and how they are related.' };
  }
  const note = clip(body.note, NOTE_MAX);
  if (!note) return { ok: false, code: 'NOTE_REQUIRED', message: 'A clinical note is required for a remote request.' };
  return {
    ok: true,
    value: {
      channel: body.channel,
      requestedByType: body.requestedByType,
      requestedByName: body.requestedByType === 'patient' ? (requestedByName || null) : requestedByName,
      note,
    },
  };
};

/** One line: "Phone · Daughter — Mercy Achieng". */
const summaryLine = (r) => [
  CHANNEL_LABEL[r.channel] || r.channel,
  r.requestedByType === 'patient' ? 'the patient' : (r.requestedByName || ASKER_LABEL[r.requestedByType]),
].join(' · ');

const view = (row) => {
  const r = row?.dataValues || row;
  if (!r) return null;
  return {
    id: r.id,
    channel: r.channel,
    channelLabel: CHANNEL_LABEL[r.channel] || r.channel,
    requestedByType: r.requestedByType,
    requestedByLabel: ASKER_LABEL[r.requestedByType] || r.requestedByType,
    requestedByName: r.requestedByName || null,
    note: r.note,
    status: r.status,
    doctorId: r.doctorId || null,
    doctorName: r.doctor ? `Dr. ${[r.doctor.firstName, r.doctor.lastName].filter(Boolean).join(' ')}` : null,
    cancelledAt: r.cancelledAt || null,
    createdAt: r.createdAt,
    summary: summaryLine(r),
  };
};

/**
 * May this remote request be linked to a new prescription / lab request?
 * Only by its own author, only for the same patient (merge family), only while
 * active, and only on the day it was written (a new call = a new request).
 * Returns null when fine, else { status, code, message }.
 */
const linkRefusal = (rr, { userId, patientIds, today, rrDay }) => {
  if (!rr) return { status: 404, code: 'NO_REMOTE_REQUEST', message: 'That remote request was not found.' };
  if (rr.doctorId !== userId) return { status: 403, code: 'NOT_AUTHOR', message: 'Only the doctor who wrote the remote request can add to it.' };
  if (!patientIds.includes(rr.PatientId)) return { status: 400, code: 'OTHER_PATIENT', message: 'That remote request is for another patient.' };
  if (rr.status !== 'active') return { status: 409, code: 'CANCELLED', message: 'That remote request was cancelled.' };
  if (rrDay !== today) return { status: 409, code: 'OLD_REQUEST', message: 'That remote request is from an earlier day — start a new one.' };
  return null;
};

module.exports = { CHANNELS, ASKERS, CHANNEL_LABEL, ASKER_LABEL, cleanRequest, summaryLine, view, linkRefusal };
