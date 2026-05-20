const { Op } = require('sequelize');
const { success, error } = require('../utils/response');
const db = require('../models');

const { DoctorBlock } = db;

const FULL_DAY = 'ALL_DAY';

/**
 * POST /api/doctor-blocks
 * Block a time slot or an entire day.
 *
 * Body:
 * - date: YYYY-MM-DD (required)
 * - timeSlot: e.g. "9:00 AM" (optional — omit to block the whole day)
 *
 * Authorization: Doctor only (blocks their own schedule)
 */
const block = async (req, res) => {
  const { date, timeSlot, reason } = req.body;
  const doctorId = req.user.id;

  if (!date) return error(res, 'Date is required', 400);

  const slot = timeSlot || FULL_DAY;

  const [, created] = await DoctorBlock.findOrCreate({
    where:    { doctorId, date, timeSlot: slot },
    defaults: { blockedBy: req.user.name, reason: reason || null },
  });

  if (!created) {
    const msg = slot === FULL_DAY
      ? 'This day is already blocked'
      : 'This time slot is already blocked';
    return error(res, msg, 409);
  }

  const msg = slot === FULL_DAY
    ? 'Day blocked successfully'
    : `Slot ${slot} blocked successfully`;
  return success(res, { blocked: true, date, timeSlot: slot }, 201, msg);
};

/**
 * DELETE /api/doctor-blocks
 * Unblock a time slot or an entire day.
 *
 * Body:
 * - date: YYYY-MM-DD (required)
 * - timeSlot: e.g. "9:00 AM" (optional — omit to unblock the whole day)
 *
 * Authorization: Doctor only
 */
const unblock = async (req, res) => {
  const { date, timeSlot } = req.body;
  const doctorId = req.user.id;

  if (!date) return error(res, 'Date is required', 400);

  const slot = timeSlot || FULL_DAY;

  const deleted = await DoctorBlock.destroy({
    where: { doctorId, date, timeSlot: slot },
  });

  if (!deleted) {
    const msg = slot === FULL_DAY
      ? 'No full-day block found for this date'
      : 'No block found for this slot';
    return error(res, msg, 404);
  }

  const msg = slot === FULL_DAY
    ? 'Day unblocked successfully'
    : `Slot ${slot} unblocked successfully`;
  return success(res, { unblocked: true, date, timeSlot: slot }, 200, msg);
};

/**
 * GET /api/doctor-blocks?doctorId=X&date=YYYY-MM-DD
 * Returns all blocked slots/days for a doctor on a date.
 * Returns an array of blocked timeSlot strings (including 'ALL_DAY').
 *
 * Authorization: Doctor, staff, admin, patient (read-only)
 */
const getBlocks = async (req, res) => {
  const { doctorId, date } = req.query;

  if (!doctorId || !date) return error(res, 'doctorId and date are required', 400);

  const blocks = await DoctorBlock.findAll({
    where: { doctorId, date },
    attributes: ['timeSlot'],
  });

  const blockedSlots = blocks.map(b => b.timeSlot);
  const dayBlocked   = blockedSlots.includes(FULL_DAY);

  return success(res, { doctorId: parseInt(doctorId), date, blockedSlots, dayBlocked });
};

/**
 * POST /api/doctor-blocks/range
 * Block multiple consecutive time slots in one request.
 *
 * Body:
 * - date: YYYY-MM-DD (required)
 * - timeSlots: string[] — array of slot strings to block (required, min 2)
 *
 * Authorization: Doctor only
 */
const blockRange = async (req, res) => {
  const { date, timeSlots, reason } = req.body;
  const doctorId = req.user.id;

  if (!date) return error(res, 'Date is required', 400);
  if (!Array.isArray(timeSlots) || timeSlots.length < 2) {
    return error(res, 'At least 2 time slots are required for a range block', 400);
  }

  await DoctorBlock.bulkCreate(
    timeSlots.map(timeSlot => ({ doctorId, date, timeSlot, blockedBy: req.user.name, reason: reason || null })),
    { ignoreDuplicates: true }
  );

  return success(
    res,
    { blocked: true, count: timeSlots.length, date, timeSlots },
    201,
    `${timeSlots.length} slot(s) blocked successfully`
  );
};

/**
 * POST /api/doctor-blocks/recurring
 * Block a time range across multiple days in a date range.
 *
 * Body:
 * - fromDate:  YYYY-MM-DD — start of date range (required)
 * - toDate:    YYYY-MM-DD — end of date range (required, max 90 days from fromDate)
 * - timeSlots: string[]  — slots to block; pass ['ALL_DAY'] to block entire days (required)
 * - weekdays:  number[]  — JS day numbers to apply to (0=Sun … 6=Sat); omit = every day
 *
 * Authorization: Doctor only
 */
const blockRecurring = async (req, res) => {
  const { fromDate, toDate, timeSlots, weekdays, reason } = req.body;
  const doctorId = req.user.id;

  if (!fromDate || !toDate)            return error(res, 'fromDate and toDate are required', 400);
  if (!Array.isArray(timeSlots) || !timeSlots.length) return error(res, 'timeSlots array is required', 400);

  const [fy, fm, fd] = fromDate.split('-').map(Number);
  const [ty, tm, td] = toDate.split('-').map(Number);
  const start = new Date(fy, fm - 1, fd);
  const end   = new Date(ty, tm - 1, td);

  if (end < start) return error(res, 'toDate must be on or after fromDate', 400);

  const diffDays = Math.round((end - start) / (1000 * 60 * 60 * 24));
  if (diffDays > 90) return error(res, 'Date range cannot exceed 90 days', 400);

  const dayFilter = Array.isArray(weekdays) && weekdays.length ? new Set(weekdays) : null;

  const records = [];
  const cursor  = new Date(start);
  while (cursor <= end) {
    if (!dayFilter || dayFilter.has(cursor.getDay())) {
      const dateStr = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`;
      timeSlots.forEach(timeSlot => records.push({ doctorId, date: dateStr, timeSlot, blockedBy: req.user.name, reason: reason || null }));
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  if (!records.length) return error(res, 'No matching days found for the selected weekdays in this date range', 400);

  await DoctorBlock.bulkCreate(records, { ignoreDuplicates: true });

  return success(
    res,
    { blocked: true, count: records.length, fromDate, toDate },
    201,
    `${records.length} slot block(s) created across the selected dates`
  );
};

/**
 * GET /api/doctor-blocks/upcoming
 * Returns all upcoming (today onwards) blocks for the requesting doctor,
 * grouped by date. Used to power the unblock list on the frontend.
 *
 * Authorization: Doctor only
 */
const getUpcoming = async (req, res) => {
  // Admin can query any doctor; doctor always sees their own blocks
  const doctorId = req.user.role === 'admin' && req.query.doctorId
    ? parseInt(req.query.doctorId)
    : req.user.id;

  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  const blocks = await DoctorBlock.findAll({
    where: { doctorId, date: { [Op.gte]: todayStr } },
    order: [['date', 'ASC'], ['timeSlot', 'ASC']],
    attributes: ['date', 'timeSlot', 'blockedBy', 'reason', 'createdAt'],
  });

  // Group by date — reason is the same for all slots on a date (set once per block action)
  const grouped = {};
  blocks.forEach(b => {
    if (!grouped[b.date]) {
      grouped[b.date] = { date: b.date, isFullDay: false, slots: [], blockedBy: b.blockedBy, reason: b.reason, blockedAt: b.createdAt };
    }
    if (b.timeSlot === FULL_DAY) {
      grouped[b.date].isFullDay = true;
    } else {
      grouped[b.date].slots.push(b.timeSlot);
    }
  });

  return success(res, { blocks: Object.values(grouped) });
};

/**
 * DELETE /api/doctor-blocks/date
 * Removes ALL blocks for a specific date — used by the unblock list.
 *
 * Body: { date: YYYY-MM-DD }
 *
 * Authorization: Doctor only
 */
const clearDate = async (req, res) => {
  const { date } = req.body;
  const doctorId = req.user.id;

  if (!date) return error(res, 'Date is required', 400);

  const deleted = await DoctorBlock.destroy({ where: { doctorId, date } });

  if (!deleted) return error(res, 'No blocks found for this date', 404);

  return success(res, { unblocked: true, count: deleted, date }, 200, 'All blocks removed for this date');
};

/**
 * DELETE /api/doctor-blocks/range
 * Unblock multiple slots on a single date.
 *
 * Body:
 * - date: YYYY-MM-DD (required)
 * - timeSlots: string[] (required)
 *
 * Authorization: Doctor only
 */
const unblockRange = async (req, res) => {
  const { date, timeSlots } = req.body;
  const doctorId = req.user.id;

  if (!date) return error(res, 'Date is required', 400);
  if (!Array.isArray(timeSlots) || !timeSlots.length) return error(res, 'timeSlots array is required', 400);

  const deleted = await DoctorBlock.destroy({
    where: { doctorId, date, timeSlot: { [Op.in]: timeSlots } },
  });

  return success(res, { unblocked: true, count: deleted }, 200, `${deleted} slot(s) unblocked`);
};

/**
 * DELETE /api/doctor-blocks/recurring
 * Unblock a time range across multiple days — symmetric to blockRecurring.
 *
 * Body:
 * - fromDate:  YYYY-MM-DD (required)
 * - toDate:    YYYY-MM-DD (required)
 * - timeSlots: string[]  (required)
 * - weekdays:  number[]  (optional — omit = every day)
 *
 * Authorization: Doctor only
 */
const unblockRecurring = async (req, res) => {
  const { fromDate, toDate, timeSlots, weekdays } = req.body;
  const doctorId = req.user.id;

  if (!fromDate || !toDate) return error(res, 'fromDate and toDate are required', 400);
  if (!Array.isArray(timeSlots) || !timeSlots.length) return error(res, 'timeSlots array is required', 400);

  const [fy, fm, fd] = fromDate.split('-').map(Number);
  const [ty, tm, td] = toDate.split('-').map(Number);
  const start = new Date(fy, fm - 1, fd);
  const end   = new Date(ty, tm - 1, td);

  if (end < start) return error(res, 'toDate must be on or after fromDate', 400);

  const dayFilter = Array.isArray(weekdays) && weekdays.length ? new Set(weekdays) : null;

  const dates = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    if (!dayFilter || dayFilter.has(cursor.getDay())) {
      dates.push(
        `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`
      );
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  if (!dates.length) return error(res, 'No matching days found for the selected weekdays', 400);

  const deleted = await DoctorBlock.destroy({
    where: {
      doctorId,
      date:     { [Op.in]: dates },
      timeSlot: { [Op.in]: timeSlots },
    },
  });

  return success(
    res,
    { unblocked: true, count: deleted, fromDate, toDate },
    200,
    `${deleted} block(s) removed across the selected dates`
  );
};

module.exports = { block, unblock, getBlocks, blockRange, blockRecurring, unblockRange, unblockRecurring, getUpcoming, clearDate };
