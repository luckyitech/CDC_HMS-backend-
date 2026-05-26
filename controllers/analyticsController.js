const { Op, fn, col } = require('sequelize');
const { success, error } = require('../utils/response');
const { getDateRange, formatDoctorName, calculateAverage } = require('../utils/formatters');
const db = require('../models');

const { Queue, User } = db;

// ── Shared helpers ────────────────────────────────────────────────────────────

const minutesDiff = (start, end) => {
  if (!start || !end) return null;
  return Math.round((new Date(end) - new Date(start)) / 60000);
};

// Returns a Sequelize WHERE clause scoping `field` to the chosen period.
// Accepts explicit startDate/endDate query params; falls back to the period string.
const buildDateFilter = (req, field = 'createdAt') => {
  const { startDate, endDate, period = '30days' } = req.query;
  if (startDate && endDate) {
    return { [field]: { [Op.between]: [new Date(startDate), new Date(`${endDate}T23:59:59`)] } };
  }
  const range = getDateRange(period);
  return { [field]: { [Op.between]: [new Date(range.startDate), new Date(`${range.endDate}T23:59:59`)] } };
};

// ── Doctor Performance ────────────────────────────────────────────────────────

const getDoctorPerformance = async (req, res) => {
  try {
    const rows = await Queue.findAll({
      where: {
        status: 'Completed',
        ...buildDateFilter(req),
      },
      include: [{ model: User, as: 'assignedDoctor', attributes: ['id', 'firstName', 'lastName'] }],
      attributes: ['assignedDoctorId', 'consultationStartTime', 'consultationEndTime', 'consultationSessions'],
    });

    const byDoctor = {};

    const addDoctor = (id, name) => {
      if (!byDoctor[id]) byDoctor[id] = { doctorId: id, doctorName: name, patientsSeen: 0, durations: [] };
    };

    rows.forEach(row => {
      const sessions = Array.isArray(row.consultationSessions) ? row.consultationSessions : [];

      if (sessions.length > 0) {
        // New path: use per-doctor session data — accurate even for referred patients
        const seenDoctors = new Set();
        sessions.forEach(s => {
          if (!s.doctorId || !s.doctorName) return;
          addDoctor(s.doctorId, s.doctorName);
          // Count each patient once per doctor even if multiple sessions exist
          if (!seenDoctors.has(s.doctorId)) {
            byDoctor[s.doctorId].patientsSeen++;
            seenDoctors.add(s.doctorId);
          }
          const dur = minutesDiff(s.startTime, s.endTime);
          if (dur !== null && dur > 0) byDoctor[s.doctorId].durations.push(dur);
        });
      } else if (row.assignedDoctorId) {
        // Legacy path: no sessions recorded — fall back to single start/end timestamps
        const name = formatDoctorName(row.assignedDoctor);
        addDoctor(row.assignedDoctorId, name);
        byDoctor[row.assignedDoctorId].patientsSeen++;
        const dur = minutesDiff(row.consultationStartTime, row.consultationEndTime);
        if (dur !== null && dur > 0) byDoctor[row.assignedDoctorId].durations.push(dur);
      }
    });

    const doctors = Object.values(byDoctor)
      .map(d => ({
        doctorId:               d.doctorId,
        doctorName:             d.doctorName,
        patientsSeen:           d.patientsSeen,
        avgConsultationMinutes: d.durations.length
          ? Math.round(calculateAverage(d.durations))
          : null,
      }))
      .sort((a, b) => b.patientsSeen - a.patientsSeen);

    return success(res, { doctors });
  } catch (err) {
    console.error('Analytics.getDoctorPerformance error:', err);
    return error(res, 'Failed to get doctor performance analytics', 500);
  }
};

// ── Triage Metrics ────────────────────────────────────────────────────────────

const getTriageMetrics = async (req, res) => {
  try {
    // Use triagedBy IS NOT NULL to count all triages — this covers historical records
    // (before triageStartTime/triageEndTime columns existed) and new records alike.
    const allTriaged = await Queue.findAll({
      where: {
        triagedBy: { [Op.not]: null },
        ...buildDateFilter(req),
      },
      attributes: ['triageStartTime', 'triageEndTime', 'createdAt'],
    });

    // Duration is only calculated from records that have the timestamp columns
    // (captured after the migration). Historical records show in count/volume only.
    const durations = allTriaged
      .filter(r => r.triageStartTime && r.triageEndTime)
      .map(r => minutesDiff(r.triageStartTime, r.triageEndTime))
      .filter(d => d !== null && d >= 0);

    // Group triage count by calendar date using all triaged records
    const volumeByDate = {};
    allTriaged.forEach(r => {
      const date = new Date(r.createdAt).toISOString().split('T')[0];
      volumeByDate[date] = (volumeByDate[date] || 0) + 1;
    });
    const dailyVolume = Object.entries(volumeByDate)
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date));

    return success(res, {
      totalTriages:     allTriaged.length,
      avgTriageMinutes: durations.length ? Math.round(calculateAverage(durations)) : null,
      minTriageMinutes: durations.length ? durations.reduce((a, b) => (b < a ? b : a)) : null,
      maxTriageMinutes: durations.length ? durations.reduce((a, b) => (b > a ? b : a)) : null,
      dailyVolume,
    });
  } catch (err) {
    console.error('Analytics.getTriageMetrics error:', err);
    return error(res, 'Failed to get triage metrics', 500);
  }
};

// ── Consultation Timing ───────────────────────────────────────────────────────

const getConsultationTiming = async (req, res) => {
  try {
    const rows = await Queue.findAll({
      where: {
        consultationStartTime: { [Op.not]: null },
        consultationEndTime:   { [Op.not]: null },
        ...buildDateFilter(req),
      },
      attributes: ['consultationStartTime', 'consultationEndTime'],
    });

    const hourlyDistribution = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: 0 }));
    const buckets = { '0–10 min': 0, '11–20 min': 0, '21–30 min': 0, '31+ min': 0 };
    const durations = [];

    rows.forEach(r => {
      hourlyDistribution[new Date(r.consultationStartTime).getHours()].count++;

      const dur = minutesDiff(r.consultationStartTime, r.consultationEndTime);
      if (dur !== null && dur >= 0) {
        durations.push(dur);
        if (dur <= 10)      buckets['0–10 min']++;
        else if (dur <= 20) buckets['11–20 min']++;
        else if (dur <= 30) buckets['21–30 min']++;
        else                buckets['31+ min']++;
      }
    });

    return success(res, {
      totalConsultations:     rows.length,
      avgConsultationMinutes: durations.length ? Math.round(calculateAverage(durations)) : null,
      hourlyDistribution,
      durationBuckets: Object.entries(buckets).map(([label, count]) => ({ label, count })),
    });
  } catch (err) {
    console.error('Analytics.getConsultationTiming error:', err);
    return error(res, 'Failed to get consultation timing analytics', 500);
  }
};

// ── Staff Triage Performance ──────────────────────────────────────────────────

const getStaffTriagePerformance = async (req, res) => {
  try {
    const rows = await Queue.findAll({
      where: {
        triagedBy: { [Op.not]: null },
        ...buildDateFilter(req),
      },
      attributes: ['triagedBy', 'triageStartTime', 'triageEndTime'],
    });

    // Group by staff member name
    const byStaff = {};
    rows.forEach(r => {
      const name = r.triagedBy;
      if (!byStaff[name]) byStaff[name] = { staffName: name, triageCount: 0, durations: [] };
      byStaff[name].triageCount++;
      const dur = minutesDiff(r.triageStartTime, r.triageEndTime);
      if (dur !== null && dur > 0) byStaff[name].durations.push(dur);
    });

    const staff = Object.values(byStaff)
      .map(s => ({
        staffName:        s.staffName,
        triageCount:      s.triageCount,
        avgTriageMinutes: s.durations.length
          ? Math.round(calculateAverage(s.durations))
          : null,
      }))
      .sort((a, b) => b.triageCount - a.triageCount);

    return success(res, { staff });
  } catch (err) {
    console.error('Analytics.getStaffTriagePerformance error:', err);
    return error(res, 'Failed to get staff triage performance', 500);
  }
};

// ── Length of Stay ────────────────────────────────────────────────────────────

const getLengthOfStay = async (req, res) => {
  try {
    const rows = await Queue.findAll({
      where: {
        status: { [Op.in]: ['Completed', 'Removed'] },
        ...buildDateFilter(req),
      },
      attributes: ['createdAt', 'updatedAt', 'dischargedAt', 'status'],
      raw: true,
    });

    const buckets = {
      '< 30 min':   0,
      '30–60 min':  0,
      '1–2 hrs':    0,
      '2–4 hrs':    0,
      '4+ hrs':     0,
    };

    let totalMinutes = 0;
    let count = 0;

    rows.forEach(r => {
      // New records have dischargedAt; legacy records fall back to updatedAt
      const exitTime = r.dischargedAt ? new Date(r.dischargedAt) : new Date(r.updatedAt);
      const dur = minutesDiff(r.createdAt, exitTime);
      if (dur === null || dur < 0) return;

      totalMinutes += dur;
      count++;

      if      (dur < 30)   buckets['< 30 min']++;
      else if (dur < 60)   buckets['30–60 min']++;
      else if (dur < 120)  buckets['1–2 hrs']++;
      else if (dur < 240)  buckets['2–4 hrs']++;
      else                 buckets['4+ hrs']++;
    });

    const distribution = Object.entries(buckets).map(([label, count]) => ({ label, count }));

    return success(res, {
      totalPatients:      count,
      avgMinutes:         count ? Math.round(totalMinutes / count) : null,
      distribution,
    });
  } catch (err) {
    console.error('Analytics.getLengthOfStay error:', err);
    return error(res, 'Failed to get length of stay', 500);
  }
};

// ── Shared wait-time aggregator ───────────────────────────────────────────────
// startField / endField: row field names for the two timestamps to diff.
// dateField: row field used to group daily averages.

const computeWaitStats = (rows, startField, endField, dateField) => {
  const buckets    = { '0–5 min': 0, '6–15 min': 0, '16–30 min': 0, '31–60 min': 0, '60+ min': 0 };
  const byDate     = {};
  const byPriority = {};
  const durations  = [];

  rows.forEach(r => {
    const wait = minutesDiff(r[startField], r[endField]);
    if (wait === null || wait < 0) return;

    durations.push(wait);

    if      (wait <= 5)  buckets['0–5 min']++;
    else if (wait <= 15) buckets['6–15 min']++;
    else if (wait <= 30) buckets['16–30 min']++;
    else if (wait <= 60) buckets['31–60 min']++;
    else                 buckets['60+ min']++;

    const date = new Date(r[dateField]).toISOString().split('T')[0];
    if (!byDate[date]) byDate[date] = { date, durations: [] };
    byDate[date].durations.push(wait);

    const p = r.priority || 'Normal';
    if (!byPriority[p]) byPriority[p] = { priority: p, count: 0, durations: [] };
    byPriority[p].count++;
    byPriority[p].durations.push(wait);
  });

  const n = durations.length;
  // Use reduce instead of spread to avoid call-stack overflow on large arrays
  const minWait = n ? durations.reduce((a, b) => (b < a ? b : a)) : null;
  const maxWait = n ? durations.reduce((a, b) => (b > a ? b : a)) : null;

  const dailyAvg = Object.values(byDate)
    .map(d => ({ date: d.date, avgWait: Math.round(calculateAverage(d.durations)) }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const waitByPriority = Object.values(byPriority).map(p => ({
    priority: p.priority,
    count:    p.count,
    avgWait:  Math.round(calculateAverage(p.durations)),
  }));

  return {
    totalRecords:   n,
    avgWaitMinutes: n ? Math.round(calculateAverage(durations)) : null,
    minWaitMinutes: minWait,
    maxWaitMinutes: maxWait,
    distribution:   Object.entries(buckets).map(([label, count]) => ({ label, count })),
    dailyAvg,
    waitByPriority,
  };
};

// ── Wait Time Before Triage ───────────────────────────────────────────────────

const getWaitTimeBeforeTriage = async (req, res) => {
  try {
    const rows = await Queue.findAll({
      where: { triageStartTime: { [Op.not]: null }, ...buildDateFilter(req) },
      attributes: ['createdAt', 'triageStartTime', 'priority'],
      raw: true,
    });
    return success(res, computeWaitStats(rows, 'createdAt', 'triageStartTime', 'createdAt'));
  } catch (err) {
    console.error('Analytics.getWaitTimeBeforeTriage error:', err);
    return error(res, 'Failed to get wait time before triage analytics', 500);
  }
};

// ── Wait Time Between Triage and Consultation ─────────────────────────────────

const getWaitTimeBetweenTriageAndConsultation = async (req, res) => {
  try {
    const rows = await Queue.findAll({
      where: {
        triageEndTime:         { [Op.not]: null },
        consultationStartTime: { [Op.not]: null },
        ...buildDateFilter(req),
      },
      attributes: ['triageEndTime', 'consultationStartTime', 'priority'],
      raw: true,
    });
    return success(res, computeWaitStats(rows, 'triageEndTime', 'consultationStartTime', 'triageEndTime'));
  } catch (err) {
    console.error('Analytics.getWaitTimeBetweenTriageAndConsultation error:', err);
    return error(res, 'Failed to get triage-to-consultation wait time analytics', 500);
  }
};

// ── Wait Time: Consultation to Billing ───────────────────────────────────────

const getWaitTimeConsultationToBilling = async (req, res) => {
  try {
    const rows = await Queue.findAll({
      where: {
        status:              'Completed',
        consultationEndTime: { [Op.not]: null },
        dischargedAt:        { [Op.not]: null },
        ...buildDateFilter(req),
      },
      attributes: ['consultationEndTime', 'dischargedAt', 'priority'],
      raw: true,
    });
    return success(res, computeWaitStats(rows, 'consultationEndTime', 'dischargedAt', 'consultationEndTime'));
  } catch (err) {
    console.error('Analytics.getWaitTimeConsultationToBilling error:', err);
    return error(res, 'Failed to get consultation-to-billing wait time analytics', 500);
  }
};

// ── Active Years ──────────────────────────────────────────────────────────────

const getActiveYears = async (req, res) => {
  try {
    const rows = await Queue.findAll({
      attributes: [[fn('YEAR', col('createdAt')), 'year']],
      group:      [fn('YEAR', col('createdAt'))],
      order:      [[fn('YEAR', col('createdAt')), 'DESC']],
      raw: true,
    });
    const years = rows.map(r => r.year).filter(Boolean);
    return success(res, { years });
  } catch (err) {
    console.error('Analytics.getActiveYears error:', err);
    return error(res, 'Failed to get active years', 500);
  }
};

// ── Triage by Priority ────────────────────────────────────────────────────────

const getTriageByPriority = async (req, res) => {
  try {
    const rows = await Queue.findAll({
      where: {
        triagedBy: { [Op.not]: null },
        ...buildDateFilter(req),
      },
      attributes: [
        'priority',
        [fn('COUNT', col('id')), 'count'],
      ],
      group: ['priority'],
      raw: true,
    });

    const priorities = rows.map(r => ({ priority: r.priority, count: Number(r.count) }));
    const total = priorities.reduce((s, p) => s + p.count, 0);
    return success(res, { priorities, total });
  } catch (err) {
    console.error('Analytics.getTriageByPriority error:', err);
    return error(res, 'Failed to get triage by priority', 500);
  }
};

// ── Patient Volume by Hour ────────────────────────────────────────────────────

const getPatientVolumeByHour = async (req, res) => {
  try {
    const rows = await Queue.findAll({
      where:      { ...buildDateFilter(req) },
      attributes: ['createdAt'],
      raw: true,
    });

    // Use JS Date.getHours() so the hour reflects the server's local timezone,
    // consistent with how getConsultationTiming computes hourly distribution.
    const hourlyVolume = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: 0 }));
    rows.forEach(r => {
      hourlyVolume[new Date(r.createdAt).getHours()].count++;
    });

    return success(res, { hourlyVolume });
  } catch (err) {
    console.error('Analytics.getPatientVolumeByHour error:', err);
    return error(res, 'Failed to get patient volume by hour', 500);
  }
};

// ── Removal Reasons ───────────────────────────────────────────────────────────

const getRemovalReasons = async (req, res) => {
  try {
    const rows = await Queue.findAll({
      where: {
        status:        'Removed',
        removalReason: { [Op.not]: null },
        ...buildDateFilter(req),
      },
      attributes: [
        'removalReason',
        [fn('COUNT', col('id')), 'count'],
      ],
      group: ['removalReason'],
      order: [[fn('COUNT', col('id')), 'DESC']],
      raw: true,
    });

    const reasons = rows.map(r => ({ reason: r.removalReason, count: Number(r.count) }));
    return success(res, { reasons, totalRemoved: reasons.reduce((s, r) => s + r.count, 0) });
  } catch (err) {
    console.error('Analytics.getRemovalReasons error:', err);
    return error(res, 'Failed to get removal reasons', 500);
  }
};

module.exports = {
  getDoctorPerformance,
  getTriageMetrics,
  getConsultationTiming,
  getStaffTriagePerformance,
  getActiveYears,
  getTriageByPriority,
  getPatientVolumeByHour,
  getRemovalReasons,
  getLengthOfStay,
  getWaitTimeBeforeTriage,
  getWaitTimeBetweenTriageAndConsultation,
  getWaitTimeConsultationToBilling,
};
