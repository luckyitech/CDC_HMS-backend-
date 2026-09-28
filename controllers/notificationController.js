const { Op } = require('sequelize');
const { success, error } = require('../utils/response');
const db = require('../models');

const { Notification } = db;

// Whether all doctors see every notification or only the assigned doctor.
// Set NOTIFY_ALL_DOCTORS=true in .env to broadcast to all doctors.
const NOTIFY_ALL_DOCTORS = process.env.NOTIFY_ALL_DOCTORS === 'true';

// Read notifications older than this many days are hidden from the bell dropdown.
// Unread notifications are always shown regardless of age.
const READ_EXPIRY_DAYS = 7;

// Which rows this user's bell may see or change.
//
// Document notifications keep their old rule: with NOTIFY_ALL_DOCTORS every
// DOCTOR sees every patient-document row. Everything else (B27: HR alerts —
// leave to approve, a decision, an expiry) is only ever for its own
// recipient, whatever the flag says: a leave request naming a colleague's
// sick leave must never reach every doctor's bell. Rows written before B27
// have category 'document' (migration 20260928000004's default).
const bellScope = (user) => {
  const own = { assignedDoctorId: user.id };
  if (NOTIFY_ALL_DOCTORS && user.role === 'doctor') {
    return { [Op.or]: [{ category: 'document' }, own] };
  }
  return own;
};

/**
 * GET /api/notifications
 * Returns notifications for the logged-in doctor.
 * - NOTIFY_ALL_DOCTORS=true  → all notifications regardless of assignedDoctorId
 * - NOTIFY_ALL_DOCTORS=false → only notifications where assignedDoctorId matches
 * - Read notifications older than READ_EXPIRY_DAYS are excluded automatically.
 */
const getAll = async (req, res) => {
  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - READ_EXPIRY_DAYS);

    const baseWhere = bellScope(req.user);

    // Show all unread OR read notifications created within the last READ_EXPIRY_DAYS days
    const where = {
      [Op.and]: [
        baseWhere,
        { [Op.or]: [{ isRead: false }, { createdAt: { [Op.gte]: cutoff } }] },
      ],
    };

    const notifications = await Notification.findAll({
      where,
      order: [['createdAt', 'DESC']],
      limit: 50,
    });

    const unreadCount = await Notification.count({
      where: { [Op.and]: [baseWhere, { isRead: false }] },
    });

    return success(res, { notifications, unreadCount });
  } catch (err) {
    console.error('Get notifications error:', err.message);
    return error(res, 'Failed to load notifications', 500);
  }
};

/**
 * PATCH /api/notifications/:id/read
 * Marks a single notification as read.
 */
const markAsRead = async (req, res) => {
  try {
    const where = { [Op.and]: [{ id: req.params.id }, bellScope(req.user)] };

    const notification = await Notification.findOne({ where });
    if (!notification) return error(res, 'Notification not found', 404);

    await notification.update({ isRead: true });
    return success(res, { id: notification.id, isRead: true });
  } catch (err) {
    console.error('Mark as read error:', err.message);
    return error(res, 'Failed to mark notification as read', 500);
  }
};

/**
 * PATCH /api/notifications/read-all
 * Marks all notifications as read for the logged-in doctor.
 */
const markAllAsRead = async (req, res) => {
  try {
    const where = { [Op.and]: [bellScope(req.user), { isRead: false }] };

    await Notification.update({ isRead: true }, { where });
    return success(res, { marked: true });
  } catch (err) {
    console.error('Mark all as read error:', err.message);
    return error(res, 'Failed to mark all notifications as read', 500);
  }
};

module.exports = { getAll, markAsRead, markAllAsRead, bellScope };
