const db = require('../models');
const { Op } = require('sequelize');
const { clinicToday } = require('./clinicTime');

const { StockBatch, Setting } = db;

// Daily expired-batch sweep. The app has no job scheduler (adding one means a
// new dependency), so this runs on the first stock-dashboard load of each day
// — a Setting row remembers the last run date. Idempotent and cheap.
//
// Flips still-'active' batches whose expiry has passed to 'expired' (the
// ledger engine already hard-blocks dispensing them regardless — this keeps
// the status column and screens honest) and reports what changed so the
// dashboard can show a "N batches expired this week" banner.
//
// Trade-off, named: the build plan wanted in-app Notifications here, but the
// Notification table is patient-document shaped (patientName/documentName
// required) and the bell renders for doctors only — stock users who are staff
// would never see it. Alerts therefore live on the stock dashboard itself;
// wiring a general-purpose notification channel is its own small project.

const SWEEP_KEY = 'stockExpirySweepDate';

const runExpirySweepIfDue = async () => {
  // Clinic-local date, matching the ledger's isExpired(). These two used to
  // disagree — the sweep used the UTC date and the ledger used local midnight —
  // so a batch could be blocked from dispensing on a different day than it was
  // marked expired.
  const today = clinicToday();

  const [setting] = await Setting.findOrCreate({
    where: { key: SWEEP_KEY },
    defaults: { key: SWEEP_KEY, value: '1970-01-01' },
  });
  if (setting.value === today) return { ran: false, newlyExpired: 0 };

  // Claim the run before working — a concurrent second request sees today's
  // date and skips. (Two racing first-loads at worst both flip the same rows
  // to the same value; harmless.)
  await setting.update({ value: today });

  const [newlyExpired] = await StockBatch.update(
    { status: 'expired' },
    { where: { status: 'active', expiryDate: { [Op.ne]: null, [Op.lt]: today } } }
  );

  return { ran: true, newlyExpired };
};

module.exports = { runExpirySweepIfDue };
