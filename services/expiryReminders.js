// Expiry reminders — B27 phase 5 (decision D12; 29 Sep 2026).
//
// Once a day (first pass after 06:00 Nairobi, on the existing HR 5-minute sweep)
// this looks at every active staff member's practising licence and their
// Staff-visible documents that carry an expiry date, and sends a reminder as
// each crosses 60 / 30 / 7 / 0 days out (the thresholds are an HR setting).
// After expiry nothing more is sent — it stays on the person's to-do list until
// they renew it (no nagging).
//
// The person is told (expiry_self); holders of hr.expiry.alerts get the
// clinic-wide alert (expiry_hr). Each (item, threshold, expiry date) fires once
// — ExpiryReminders is the de-duplication log, so a renewed date starts a fresh
// set and a restart never double-sends. A licence or document name is not health
// data, so it may appear in the notice; nothing clinical does.
//
// Reuses the SAME reads as the phase-4 My-profile to-do (licence expiry on the
// StaffProfile, Staff-visible StaffDocuments with an expiry) and the pure maths
// in utils/expiry, so the to-do and the reminder never disagree.

const { Op } = require('sequelize');
const db = require('../models');
const { clinicToday } = require('../utils/clinicTime');
const { daysUntil, dueThreshold, isoDay } = require('../utils/expiry');
const { getHrConfig } = require('../utils/hrConfig');
const { PERMISSIONS } = require('../constants/permissions');
const hrNotify = require('./hrNotify');
const { isHealthDocument } = require('../utils/hrAccess');

const { User, StaffProfile, StaffDocument, ExpiryReminder } = db;

const fullName = (u) => (u ? `${u.firstName} ${u.lastName}`.trim() : 'A colleague');
const nairobiHour = (now) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Nairobi', hour: 'numeric', hour12: false }).format(now)) % 24;
const inDays = (daysLeft) => (daysLeft <= 0 ? 'today' : `in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`);

// Runs at most once per clinic day; the daily pass waits until 06:00 Nairobi.
let lastRunDate = null;

/** The user ids that should receive clinic-wide expiry alerts (hr.expiry.alerts). */
const credentialHolders = () => hrNotify.holdersOf(PERMISSIONS.HR_EXPIRY_ALERTS);

/**
 * One item due for a reminder: record it (once) and notify. Returns 1 if it
 * fired, 0 if it was already sent for this threshold and expiry date.
 */
const fireOne = async ({ kind, refId, threshold, expiryDate, daysLeft, ownerId, selfTitle, selfLink, hrTitle, hrLink, hrRecipients }) => {
  const [, created] = await ExpiryReminder.findOrCreate({
    where: { kind, refId, threshold, expiryDate },
    defaults: { kind, refId, threshold, expiryDate, sentAt: new Date() },
  });
  if (!created) return 0;   // already sent for this milestone and date

  await hrNotify.notify('expiry_self', {
    recipients: [ownerId],
    title: selfTitle,
    body: 'Open the HMS to renew it.',
    link: selfLink,
  });
  if (hrRecipients.length) {
    await hrNotify.notify('expiry_hr', {
      recipients: hrRecipients,
      title: hrTitle,
      body: `Expires ${inDays(daysLeft)}.`,
      link: hrLink,
    });
  }
  return 1;
};

/**
 * The daily pass. Idempotent within a day (ExpiryReminders de-dupes anyway).
 * @returns {Promise<{ ran:boolean, sent:number, waiting?:boolean }>}
 */
const runExpiryReminders = async (now = new Date()) => {
  const today = clinicToday(now);
  if (lastRunDate === today) return { ran: false, sent: 0 };
  if (nairobiHour(now) < 6) return { ran: false, sent: 0, waiting: true };

  const cfg = await getHrConfig();
  const thresholds = cfg.expiryThresholds && cfg.expiryThresholds.length ? cfg.expiryThresholds : [60, 30, 7, 0];
  const hrRecipients = await credentialHolders();

  let sent = 0;

  // --- Practising licences (StaffProfile.licenseExpiry) --------------------
  const profiles = await StaffProfile.findAll({
    where: { licenseExpiry: { [Op.ne]: null } },
    include: [{ model: User, attributes: ['id', 'firstName', 'lastName', 'isActive'], where: { isActive: true } }],
  });
  for (const p of profiles) {
    // licenseExpiry is a DATE (datetime) column → a Date object; isoDay copes.
    const expiryDate = isoDay(p.licenseExpiry);
    if (!expiryDate) continue;
    const daysLeft = daysUntil(p.licenseExpiry, today);
    const threshold = dueThreshold(daysLeft, thresholds);
    if (threshold === null) continue;
    sent += await fireOne({
      kind: 'licence', refId: p.UserId, threshold, expiryDate, daysLeft, ownerId: p.UserId,
      selfTitle: `Your practising licence expires ${inDays(daysLeft)}`,
      selfLink: '/hr/me?tab=credentials',
      hrTitle: `${fullName(p.User)}'s practising licence expires ${inDays(daysLeft)}`,
      hrLink: '/hr/requests',
      hrRecipients,
    });
  }

  // --- Staff documents with an expiry (Staff-visible, live) ----------------
  const docs = await StaffDocument.findAll({
    where: { isArchived: false, visibility: 'Staff', expiryDate: { [Op.ne]: null } },
    include: [{ model: User, attributes: ['id', 'firstName', 'lastName', 'isActive'], where: { isActive: true } }],
  });
  for (const d of docs) {
    const expiryDate = isoDay(d.expiryDate);
    if (!expiryDate) continue;
    const daysLeft = daysUntil(d.expiryDate, today);
    const threshold = dueThreshold(daysLeft, thresholds);
    if (threshold === null) continue;
    const label = d.category || d.fileName || 'A document';
    sent += await fireOne({
      kind: 'document', refId: d.id, threshold, expiryDate, daysLeft, ownerId: d.UserId,
      selfTitle: `Your ${label} expires ${inDays(daysLeft)}`,
      selfLink: '/hr/me?tab=documents',
      // A health document (sick note) is never named to HR recipients.
      hrTitle: `${fullName(d.User)}'s ${isHealthDocument(d) ? 'document' : label} expires ${inDays(daysLeft)}`,
      hrLink: '/hr/requests',
      hrRecipients,
    });
  }

  lastRunDate = today;
  if (sent) console.log(`[HR] expiry reminders: ${sent} sent`);
  return { ran: true, sent };
};

/** For tests — lets a fresh day be forced. */
const _resetForTests = () => { lastRunDate = null; };

module.exports = { runExpiryReminders, credentialHolders, _resetForTests };
