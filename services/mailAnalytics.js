const { Op } = require('sequelize');
const db = require('../models');

const { StaffMailTraffic, StaffMailEvent, PatientEmailMessage, MedicalDocument, User, Patient } = db;

// ---------------------------------------------------------------------------
// Staff Email phase 5 — Inbox → Analytics → Email (Emu, 27 Sep).
//
//   volume        StaffMailTraffic (every message sent/received by a connected
//                 mailbox): totals, per staff member, per day
//   reply times   patient threads (PatientEmailMessages): for each message
//                 that came IN FROM THE PATIENT (their own address on the
//                 file — not an insurer or a lab on a linked thread), how long
//                 until the clinic's next message OUT on the same thread —
//                 median, 90th percentile; threads whose latest message is from
//                 the patient are "waiting"
//   documents     documents from patient files emailed (patient_emailed +
//                 patient_docs_sent rows), by category
//   patients      most-contacted patients (thread messages in range)
//
// Metadata only; no subject or text leaves this service. Gated at the route
// to admin / monitoring.view (it shows each person's mail volume).
// Aggregated in JS over the rows in range, like commsAnalytics.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;

const rangeOf = ({ from, to } = {}) => {
  const end = to ? new Date(`${to}T23:59:59.999`) : new Date();
  const start = from ? new Date(`${from}T00:00:00`) : new Date(end.getTime() - 30 * DAY);
  return { start, end };
};
const fullName = (u) => (u ? `${u.firstName || ''} ${u.lastName || ''}`.trim() : 'Unknown');
const dayKey = (d) => new Date(d).toISOString().slice(0, 10);
const quantile = (sorted, q) => {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i); const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
};
const hours = (ms) => Math.round((ms / 3600000) * 10) / 10;
const parse = (s) => { try { const v = JSON.parse(s || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };

const emailStats = async ({ from, to, staffId } = {}) => {
  const { start, end } = rangeOf({ from, to });
  const staffFilter = staffId ? { userId: parseInt(staffId, 10) || 0 } : {};

  // ---- volume ---------------------------------------------------------------
  const traffic = await StaffMailTraffic.findAll({
    where: { at: { [Op.between]: [start, end] }, ...staffFilter },
    attributes: ['userId', 'direction', 'via', 'at', 'attachmentCount', 'patientId'],
    include: [{ model: User, as: 'user', attributes: ['id', 'firstName', 'lastName', 'role'] }],
  });
  const byStaff = new Map();
  const byDay = new Map();
  let sent = 0; let received = 0; let sentElsewhere = 0; let patientTagged = 0;
  for (const t of traffic) {
    const s = byStaff.get(t.userId) || { userId: t.userId, name: fullName(t.user), role: t.user ? t.user.role : null, sent: 0, received: 0 };
    const d = byDay.get(dayKey(t.at)) || { day: dayKey(t.at), sent: 0, received: 0 };
    if (t.direction === 'out') { s.sent += 1; d.sent += 1; sent += 1; if (t.via === 'elsewhere') sentElsewhere += 1; }
    else { s.received += 1; d.received += 1; received += 1; }
    if (t.patientId) patientTagged += 1;
    byStaff.set(t.userId, s); byDay.set(dayKey(t.at), d);
  }

  // ---- patient threads: reply times, waiting, most contacted ---------------
  const threadWhere = { status: 'active', sentAt: { [Op.between]: [start, end] } };
  if (staffId) threadWhere.mailboxUserId = parseInt(staffId, 10) || 0;
  const msgs = await PatientEmailMessage.findAll({
    where: threadWhere,
    attributes: ['patientId', 'threadKey', 'direction', 'sentAt', 'mailboxUserId'],
    order: [['sentAt', 'ASC']],
  });
  // Reply times need each thread's full history (a reply may answer a message
  // from before the range) — read the threads touched, whole.
  const keys = [...new Set(msgs.map((m) => m.threadKey))];
  const whole = keys.length ? await PatientEmailMessage.findAll({
    where: { status: 'active', threadKey: { [Op.in]: keys } },
    attributes: ['patientId', 'threadKey', 'direction', 'sentAt', 'mailboxUserId', 'fromAddress'],
    order: [['sentAt', 'ASC']],
  }) : [];
  // Each patient's own addresses (their file + any file merged into it).
  const pIds = [...new Set(whole.map((m) => m.patientId))];
  const fam = pIds.length ? await Patient.findAll({
    where: { [Op.or]: [{ id: { [Op.in]: pIds } }, { mergedIntoId: { [Op.in]: pIds } }] },
    attributes: ['id', 'mergedIntoId', 'email'],
  }) : [];
  const emailsOf = new Map();
  for (const p of fam) {
    const owner = p.mergedIntoId || p.id;
    const e = String(p.email || '').trim().toLowerCase();
    if (e) emailsOf.set(owner, new Set([...(emailsOf.get(owner) || []), e]));
  }
  const fromPatient = (m) => m.direction === 'in' && (emailsOf.get(m.patientId) || new Set()).has(String(m.fromAddress || '').toLowerCase());
  const threads = new Map();
  for (const m of whole) {
    const k = `${m.patientId}|${m.threadKey}`;
    threads.set(k, [...(threads.get(k) || []), m]);
  }
  const replyMs = [];
  const waiting = [];
  for (const list of threads.values()) {
    for (let i = 0; i < list.length; i += 1) {
      const m = list[i];
      if (!fromPatient(m) || m.sentAt < start || m.sentAt > end) continue;
      // Only the first of a run of patient messages counts (three in a row wait once).
      if (i > 0 && fromPatient(list[i - 1])) continue;
      const answer = list.slice(i + 1).find((x) => x.direction === 'out');
      if (answer) replyMs.push(new Date(answer.sentAt) - new Date(m.sentAt));
    }
    const last = list[list.length - 1];
    if (fromPatient(last)) {
      let firstWaiting = list.length - 1;
      while (firstWaiting > 0 && fromPatient(list[firstWaiting - 1])) firstWaiting -= 1;
      waiting.push({ patientId: last.patientId, since: list[firstWaiting].sentAt, mailboxUserId: last.mailboxUserId });
    }
  }
  replyMs.sort((a, b) => a - b);

  const perPatient = new Map();
  for (const m of msgs) {
    const p = perPatient.get(m.patientId) || { patientId: m.patientId, in: 0, out: 0 };
    p[m.direction] += 1;
    perPatient.set(m.patientId, p);
  }

  // ---- documents emailed -----------------------------------------------------
  const docEvents = await StaffMailEvent.findAll({
    where: { event: { [Op.in]: ['patient_emailed', 'patient_docs_sent'] }, createdAt: { [Op.between]: [start, end] }, ...(staffId ? { actorId: parseInt(staffId, 10) || 0 } : {}) },
    attributes: ['event', 'detail'],
  });
  const docIds = [];
  let docsTotal = 0; let docsUnknown = 0; let toPatients = 0; let toOthers = 0;
  for (const e of docEvents) {
    const d = parse(e.detail);
    const ids = Array.isArray(d.documents) ? d.documents : (Array.isArray(d.documentIds) ? d.documentIds : []);
    const count = Array.isArray(d.documents) ? d.documents.length : (Number(d.documents) || 0);
    docsTotal += count;
    if (e.event === 'patient_emailed') toPatients += count; else toOthers += count;
    docIds.push(...ids);
    docsUnknown += Math.max(0, count - ids.length);
  }
  const docRows = docIds.length ? await MedicalDocument.findAll({
    where: { id: { [Op.in]: [...new Set(docIds.map((n) => parseInt(n, 10)).filter((n) => n > 0))] } },
    attributes: ['id', 'documentCategory'],
  }) : [];
  const catOf = new Map(docRows.map((d) => [d.id, d.documentCategory || 'Uncategorised']));
  const byCategory = new Map();
  for (const id of docIds) {
    const c = catOf.get(parseInt(id, 10)) || 'Document no longer on file';
    byCategory.set(c, (byCategory.get(c) || 0) + 1);
  }
  if (docsUnknown) byCategory.set('Before categories were recorded', docsUnknown);

  // ---- names -----------------------------------------------------------------
  const patientIds = [...new Set([...perPatient.keys(), ...waiting.map((w) => w.patientId)])];
  const patients = patientIds.length ? await Patient.findAll({ where: { id: { [Op.in]: patientIds } }, attributes: ['id', 'uhid', 'firstName', 'lastName'] }) : [];
  const pBy = new Map(patients.map((p) => [p.id, p]));
  const userIds = [...new Set(waiting.map((w) => w.mailboxUserId).filter(Boolean))];
  const users = userIds.length ? await User.findAll({ where: { id: { [Op.in]: userIds } }, attributes: ['id', 'firstName', 'lastName'] }) : [];
  const uBy = new Map(users.map((u) => [u.id, u]));
  const patientOut = (id) => { const p = pBy.get(id); return p ? { uhid: p.uhid, name: fullName(p) } : { uhid: null, name: 'Unknown patient' }; };

  const now = Date.now();
  return {
    range: { from: dayKey(start), to: dayKey(end) },
    totals: { sent, received, sentElsewhere, patientTagged },
    byStaff: [...byStaff.values()].sort((a, b) => (b.sent + b.received) - (a.sent + a.received)),
    byDay: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
    replyTimes: {
      answered: replyMs.length,
      medianHours: replyMs.length ? hours(quantile(replyMs, 0.5)) : null,
      p90Hours: replyMs.length ? hours(quantile(replyMs, 0.9)) : null,
    },
    waiting: waiting
      .map((w) => ({ patient: patientOut(w.patientId), waitingHours: hours(now - new Date(w.since)), staff: w.mailboxUserId ? fullName(uBy.get(w.mailboxUserId)) : null }))
      .sort((a, b) => b.waitingHours - a.waitingHours).slice(0, 20),
    documents: {
      total: docsTotal, toPatients, toOthers,
      byCategory: [...byCategory.entries()].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count),
    },
    patients: [...perPatient.values()]
      .map((p) => ({ patient: patientOut(p.patientId), in: p.in, out: p.out, total: p.in + p.out }))
      .sort((a, b) => b.total - a.total).slice(0, 10),
  };
};

module.exports = { emailStats, _internals: { quantile, rangeOf } };
