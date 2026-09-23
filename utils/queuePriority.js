// =====================================================================
// Queue booking-priority ordering — ONE definition, many consumers.
//
// The clinic serves patients in this order (applied to both the Awaiting
// Triage list and each doctor's Awaiting Doctor list):
//
//   1. Urgent            — clinical override, by arrival.
//   2. On-time booked    — a booked patient who checked in no more than
//                          GRACE_MIN after their slot. Ordered by slot time
//                          (earlier slot first), then arrival. An early
//                          arriver therefore only jumps walk-ins, never an
//                          earlier-slot booked patient.
//   3. Late booked       — checked in GRACE_MIN..WALKIN_MIN after their slot.
//                          Missed the slot but not yet an hour late: ranks
//                          below on-time booked, above walk-ins, by arrival.
//   4. Walk-in / lapsed  — no booking, OR a booking checked in more than
//                          WALKIN_MIN after the slot (now a walk-in). By arrival.
//
// Lateness is measured from the patient's CHECK-IN (createdAt) against their
// slot (scheduledTime), so a booked patient who arrived on time keeps their
// priority no matter how long the clinic then takes. Pure function of the row —
// no clock, no scheduler — so the order is deterministic and testable.
// =====================================================================

const { clinicMidnight } = require('./clinicTime');

const GRACE_MIN = 30;   // on-time booked window, minutes after slot start
const WALKIN_MIN = 60;  // past this many minutes late, a booking becomes a walk-in

// 'urgent' | 'booked-on-time' | 'booked-late' | 'booked-walkin' | 'walk-in'
const bookingState = (item) => {
  const q = item.dataValues || item;
  if (q.priority === 'Urgent') return 'urgent';
  if (!q.scheduledTime) return 'walk-in';
  const slot = new Date(q.scheduledTime).getTime();
  const arrived = new Date(q.createdAt).getTime();
  const lateMin = (arrived - slot) / 60000;
  if (lateMin <= GRACE_MIN) return 'booked-on-time';
  if (lateMin <= WALKIN_MIN) return 'booked-late';
  return 'booked-walkin'; // more than an hour late — treated as a walk-in
};

const TIER = {
  urgent: 0,
  'booked-on-time': 1,
  'booked-late': 2,
  'walk-in': 3,
  'booked-walkin': 3,
};

// Comparator for Array.prototype.sort — earlier = seen sooner.
const compareQueueItems = (x, y) => {
  const sx = bookingState(x);
  const sy = bookingState(y);
  if (TIER[sx] !== TIER[sy]) return TIER[sx] - TIER[sy];

  const qx = x.dataValues || x;
  const qy = y.dataValues || y;

  // On-time booked sort by slot time first (earlier appointment first)
  if (sx === 'booked-on-time') {
    const diff = new Date(qx.scheduledTime).getTime() - new Date(qy.scheduledTime).getTime();
    if (diff !== 0) return diff;
  }
  // Everyone else within a tier: first arrival first
  return new Date(qx.createdAt).getTime() - new Date(qy.createdAt).getTime();
};

// Parse a booking timeSlot ("9:00 AM", "10:30 PM") to minutes past midnight.
const parseSlotMinutes = (timeSlot) => {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(String(timeSlot || '').trim());
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ap = m[3].toUpperCase();
  if (ap === 'PM' && h !== 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
};

// The clinic-wall-clock instant a slot begins, for a DATEONLY date + timeSlot.
const slotInstant = (dateStr, timeSlot) => {
  const mins = parseSlotMinutes(timeSlot);
  if (mins == null || !dateStr) return null;
  return new Date(clinicMidnight(dateStr).getTime() + mins * 60000);
};

module.exports = {
  GRACE_MIN,
  WALKIN_MIN,
  bookingState,
  compareQueueItems,
  parseSlotMinutes,
  slotInstant,
};
