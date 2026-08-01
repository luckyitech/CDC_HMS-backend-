// Single source of truth for the clinic's bookable slot grid.
//
// Extracted from appointmentController so the internal booking path and the
// public (website) booking path share ONE definition of the grid, the seat
// capacity, and the full-day-block sentinel. Nothing here is patient-specific,
// so it is safe to reuse from an unauthenticated controller.
//
// The labels must match AppointmentContext.jsx on the frontend exactly.
// Lunch break 12:30 PM–1:30 PM is excluded.

const SLOT_LABELS = [
  '8:00 AM', '8:30 AM', '9:00 AM', '9:30 AM', '10:00 AM', '10:30 AM',
  '11:00 AM', '11:30 AM', '12:00 PM',
  '2:00 PM', '2:30 PM', '3:00 PM', '3:30 PM', '4:00 PM', '4:30 PM', '5:00 PM',
];

// Each 30-minute slot holds up to this many patients.
const SEATS_PER_SLOT = 2;

// DoctorBlock.timeSlot === FULL_DAY means the whole date is blocked.
const FULL_DAY = 'ALL_DAY';

// "9:00 AM" -> "9:00 am"  (used for human-readable email/confirmation text)
const prettyTime = (label) => String(label || '').replace('AM', 'am').replace('PM', 'pm');

module.exports = { SLOT_LABELS, SEATS_PER_SLOT, FULL_DAY, prettyTime };
