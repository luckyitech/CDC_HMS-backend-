// HR Suite notifications — the one place an HR event becomes a bell entry,
// an email, or (later) a WhatsApp message. B27 spec §7, decision D9.
//
//   notify(event, { recipients, title, body, link, data })
//
//   - event        one of hrConfig.ALERT_EVENTS ('leave_to_approve', …)
//   - recipients   user ids; duplicates and inactive/archived accounts dropped
//   - title/body   what the person reads. NEVER a sick-leave type, a leave
//                  reason, or a document's contents — say "Leave request from
//                  Ahmed Hassan — action needed" and let the HMS show the rest
//                  behind a login. (Health data, spec §11.)
//   - link         in-app path the bell and the email button open
//
// Which channels fire is HR's choice per event (hr.alerts, utils/hrConfig).
// Best-effort by design: a failed channel is logged and never fails the
// request that caused it. WhatsApp is a logged no-op until the HMS WhatsApp
// number is registered (B18). Nothing here is ever written to the logs except
// the event name and a count.

const { Op } = require('sequelize');
const db = require('../models');
const { getHrConfig, ALERT_EVENTS } = require('../utils/hrConfig');
const { sendHrNoticeEmail } = require('../utils/emailService');
const { passesAdminGate, INTERNAL_ROLES } = require('../constants/permissions');

const { Notification, User } = db;

const clip = (value, max) => (value == null ? null : String(value).slice(0, max));

const notify = async (event, { recipients = [], title, body = null, link = null, actorName = 'CDC HMS' } = {}) => {
  const result = { bell: 0, email: 0, whatsapp: 0 };
  if (!ALERT_EVENTS.includes(event)) {
    console.error('hrNotify error: unknown event', event);
    return result;
  }
  const ids = [...new Set(recipients.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length || !title) return result;

  let channels;
  let people;
  try {
    const cfg = await getHrConfig();
    channels = cfg.alerts[event];
    people = await User.findAll({
      where: { id: { [Op.in]: ids }, isActive: true },
      attributes: ['id', 'firstName', 'lastName', 'email', 'role'],
    });
  } catch (err) {
    console.error('hrNotify.load error:', err);
    return result;
  }
  // Patients never receive HR alerts, whatever id was passed.
  people = people.filter((p) => p.role !== 'patient');

  if (channels.bell) {
    try {
      await Notification.bulkCreate(people.map((p) => ({
        type: event,
        category: 'hr',
        title: clip(title, 255),
        body: clip(body, 5000),
        link: clip(link, 255),
        uploadedBy: clip(actorName, 255) || 'CDC HMS',
        assignedDoctorId: p.id,
        isRead: false,
      })));
      result.bell = people.length;
    } catch (err) {
      console.error('hrNotify.bell error:', err);
    }
  }

  if (channels.email) {
    for (const p of people) {
      if (!p.email) continue;
      try {
        await sendHrNoticeEmail({ to: p.email, name: p.firstName, title, body, link });
        result.email += 1;
      } catch (err) {
        console.error('hrNotify.email error:', err);
      }
    }
  }

  if (channels.whatsapp) {
    // Not wired until the HMS WhatsApp number is registered (B18).
    console.warn(`hrNotify.whatsapp: channel not configured — ${event} to ${people.length} recipient(s) not sent`);
  }

  return result;
};

/**
 * The active internal staff who hold a capability (admin.access bypass and
 * withdrawals honoured, exactly as the route gate decides). ONE lookup for
 * every "tell whoever handles X" alert: clinic-wide expiry (hr.credentials),
 * new profile change requests (hr.profile.approve).
 */
const holdersOf = async (capability) => {
  const staff = await User.findAll({
    where: { isActive: true, role: { [Op.in]: INTERNAL_ROLES } },
    attributes: ['id', 'role', 'permissions', 'deniedPermissions', 'staffType'],
  });
  return staff.filter((u) => passesAdminGate(u, capability)).map((u) => u.id);
};

module.exports = { notify, holdersOf };
