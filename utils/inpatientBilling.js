// ============================================================
// Inpatient billing helpers.
// Bed-day charging is PER MIDNIGHT CROSSED (owner decision): each time the
// clock passes midnight between admission and discharge counts as one bed-day.
// ============================================================

const db = require('../models');
const { InpatientCharge } = db;

// Count midnights crossed between two datetimes (date-only difference).
// admit Mon 14:00 -> discharge Wed 10:00 crosses Tue 00:00 and Wed 00:00 = 2.
const bedDaysBetween = (start, end) => {
  const s = new Date(start); s.setHours(0, 0, 0, 0);
  const e = new Date(end);   e.setHours(0, 0, 0, 0);
  const ms = e - s;
  const days = Math.round(ms / (1000 * 60 * 60 * 24));
  return Math.max(days, 0);
};

// Post bed-day charges for an admission up to `end`. Idempotent-ish: skips
// bed-days already posted (by counting existing BedDay charge quantity).
// unitAmount defaults to 0 — the clinic sets per-ward bed rates later; the
// mechanism (counting midnights) is what matters here.
const accrueBedDays = async (admission, end, addedById, transaction, unitAmount = 0) => {
  const total = bedDaysBetween(admission.admissionDateTime, end);

  const existing = await InpatientCharge.findAll({
    where: { AdmissionId: admission.id, category: 'BedDay', status: 'active' },
    transaction,
  });
  const alreadyPosted = existing.reduce((sum, c) => sum + (c.quantity || 0), 0);
  const toPost = total - alreadyPosted;
  if (toPost <= 0) return null;

  return InpatientCharge.create({
    AdmissionId: admission.id,
    PatientId: admission.PatientId,
    chargeDate: new Date(end),
    category: 'BedDay',
    description: `Bed charge (${toPost} day${toPost === 1 ? '' : 's'})`,
    quantity: toPost,
    unitAmount,
    amount: toPost * unitAmount,
    sourceType: 'Admission',
    sourceId: admission.id,
    addedById,
  }, { transaction });
};

module.exports = { bedDaysBetween, accrueBedDays };
