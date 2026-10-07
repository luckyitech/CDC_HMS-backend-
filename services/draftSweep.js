// =====================================================================
// Autosave drafts — the hourly sweep (6 Oct 2026).
//
//   - A draft untouched for 12 days gets ONE bell reminder to its author
//     ("will be deleted in 2 days"), sent after 06:00 Nairobi. Saving the
//     draft again clears the reminder (the controller resets reminderSentAt).
//   - A draft untouched for 14 days is deleted. Drafts are not part of the
//     medical record, so this is a real delete by design.
//
// Armed from server.js in its own try/catch — a failure here can never
// affect the API. Rules in utils/formDrafts.
// =====================================================================

const { Op } = require('sequelize');
const db = require('../models');
const D = require('../utils/formDrafts');
const { nairobiHour } = require('../utils/clinicTime');

const { FormDraft, Notification, Patient, User } = db;

const INTERVAL_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 3600 * 1000;
let timer = null;

// Where the author's portal opens a patient file (the bell link).
const PROFILE_BASE = { doctor: '/doctor', staff: '/staff', admin: '/admin', nurse: '/nurse' };

const dayLabel = (d) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Africa/Nairobi' });

/** Deletes expired drafts. Returns how many. */
const runPurge = async (now = new Date()) => {
  const cutoff = new Date(now.getTime() - D.DRAFT_LIFETIME_DAYS * DAY_MS);
  const n = await FormDraft.destroy({ where: { updatedAt: { [Op.lte]: cutoff } } });
  if (n) console.log(`[Drafts] deleted ${n} draft(s) untouched for ${D.DRAFT_LIFETIME_DAYS} days`);
  return n;
};

/** Sends the day-12 bell, once per draft. Returns how many were sent. */
const runReminders = async (now = new Date()) => {
  if (nairobiHour(now) < 6) return 0;
  const from = new Date(now.getTime() - D.DRAFT_LIFETIME_DAYS * DAY_MS);
  const to = new Date(now.getTime() - D.REMINDER_DAY * DAY_MS);
  const due = await FormDraft.findAll({
    where: { reminderSentAt: null, updatedAt: { [Op.gt]: from, [Op.lte]: to } },
    include: [
      { model: Patient, attributes: ['id', 'uhid', 'firstName', 'lastName'] },
      { model: User, as: 'author', attributes: ['id', 'role'] },
    ],
  });
  let sent = 0;
  for (const draft of due.filter((d) => D.needsReminder(d, now))) {
    const p = draft.Patient;
    const name = p ? [p.firstName, p.lastName].filter(Boolean).join(' ') : 'a patient';
    const base = PROFILE_BASE[draft.author?.role];
    const daysLeft = Math.max(1, Math.ceil((D.expiresAt(draft.updatedAt).getTime() - now.getTime()) / DAY_MS));
    try {
      await Notification.create({
        type: 'draft_expiring',
        category: 'draft',
        title: `Draft will be deleted in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`,
        body: `Your ${draft.label || 'draft'} for ${name}${p ? ` (${p.uhid})` : ''}, last typed ${dayLabel(draft.updatedAt)}, was never saved to the record.`,
        link: base && p ? `${base}/patient-profile/${p.uhid}` : null,
        patientName: p ? name : null,
        patientUhid: p ? p.uhid : null,
        uploadedBy: 'CDC HMS',
        assignedDoctorId: draft.userId,
        isRead: false,
      });
      // `silent` — the reminder must not count as the author touching the
      // draft (that would move updatedAt and postpone the deletion).
      await draft.update({ reminderSentAt: now }, { silent: true });
      sent += 1;
    } catch (err) {
      console.error('[Drafts] reminder failed:', err.message);
    }
  }
  return sent;
};

const runAll = () => {
  runReminders().catch((err) => console.error('[Drafts] reminders failed:', err.message));
  runPurge().catch((err) => console.error('[Drafts] purge failed:', err.message));
};

const startScheduler = () => {
  if (timer) return;
  runAll();
  timer = setInterval(runAll, INTERVAL_MS);
  if (timer.unref) timer.unref();
  console.log('[Drafts] draft sweep armed (hourly).');
};

const stopScheduler = () => { if (timer) { clearInterval(timer); timer = null; } };

module.exports = { runPurge, runReminders, startScheduler, stopScheduler, PROFILE_BASE };
