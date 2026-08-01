// Public website booking sources — configuration ONLY (no database table).
//
// Each website that books into the schedule is a "source". A source decides
// which doctor a booking goes to; the browser only ever sends the source key,
// never a doctorId — so a stranger cannot target an arbitrary doctor.
//
// Two strategies:
//   'fixed'        -> every booking goes to one doctor (identified by email,
//                     which is stable across local + production).
//   'least-loaded' -> the booking is assigned to whichever doctor in `pool`
//                     is free at the chosen slot and has the fewest upcoming
//                     appointments. Empty pool = all active doctors.
//
// Keys:
//   publicKey  — sent by the browser on the read-only slots request. Safe to expose.
//   secretKey  — required on the write (booking) request. The website's own
//                server-side proxy (book.php) holds it; the browser never sees it.
//                If null, the write is allowed without a secret (fine for launch;
//                set it later to stop direct-to-API abuse). Read from env so no
//                secret is committed to git.

module.exports = {
  'thyroid-kenya': {
    label: 'Thyroid Care Kenya',
    origin: 'https://thyroidkenya.com',
    publicKey: 'thyroid-kenya',
    secretKey: process.env.TK_BOOKING_SECRET || null,
    strategy: 'fixed',
    // Dr. Ebrahim's HMS doctor account. Set TK_DOCTOR_EMAIL in backend/.env to the
    // real production doctor email; falls back to the address used on the site.
    doctorEmail: process.env.TK_DOCTOR_EMAIL || 'ebrahim@cdiabetescentre.com',
    defaults: {
      appointmentType: 'consultation',
      duration: '30 minutes',
      specialty: 'Thyroid',
      reasonFallback: 'General thyroid consultation',
    },
    dailyCap: 40, // max website bookings per day for this source (abuse guard)
  },

  // The diabetes-centre website does not exist yet. This entry is ready so the
  // site plugs in with zero backend change when built. It auto-assigns the
  // least-loaded doctor. Set `pool` to specific emails when you want to limit
  // which doctors receive web bookings; [] means all active doctors.
  'diabetes': {
    label: 'Comprehensive Diabetes Centre',
    origin: 'https://cdiabetescentre.com',
    publicKey: 'diabetes',
    secretKey: process.env.CDC_BOOKING_SECRET || null,
    strategy: 'least-loaded',
    pool: [], // e.g. ['ebrahim@cdiabetescentre.com', 'doctor2@cdiabetescentre.com']
    defaults: {
      appointmentType: 'consultation',
      duration: '30 minutes',
      specialty: null,
      reasonFallback: 'General consultation',
    },
    dailyCap: 60,
  },
};
