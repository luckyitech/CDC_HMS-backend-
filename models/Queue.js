const { defineModel, DataTypes } = require('../utils/defineModel');

const Queue = defineModel('Queue', {
  // patientId       — added by Patient.hasMany(Queue)
  // assignedDoctorId — added by Queue.belongsTo(User, { as: 'assignedDoctor' }) — nullable

  status: {
    // 'Pending Injection' — consultation done, patient is with the nurse for a
    // GLP-1 injection, not yet billed. Kept as a real status so injection
    // visits are countable in SQL.
    type: DataTypes.ENUM('Awaiting Triage', 'In Triage', 'Awaiting Doctor', 'With Doctor', 'Pending Injection', 'Pending Billing', 'Completed', 'Removed'),
    allowNull: false,
    defaultValue: 'Awaiting Triage',
  },
  priority: {
    type: DataTypes.ENUM('Normal', 'Urgent'),
    allowNull: false,
    defaultValue: 'Normal',
  },
  reason: {
    type: DataTypes.TEXT,
  },

  // Where this visit is headed. Drives which portal/dashboard picks it up.
  // Backfilled to 'Outpatient' by 20260901000002 so existing rows are unchanged.
  // (A walk-in inpatient admission creates an Admission directly, not a Queue
  // row, so in practice this is Outpatient | Radiology | Pharmacy.)
  destination: {
    type: DataTypes.ENUM('Outpatient', 'Inpatient', 'Radiology', 'Pharmacy'),
    allowNull: false,
    defaultValue: 'Outpatient',
  },
  // Sub-type within a destination — e.g. Radiology -> 'Neuropathy' | 'Ultrasound'.
  // Queryable (unlike stuffing it in reason). Nullable; only radiology uses it.
  service: {
    type: DataTypes.STRING,
    defaultValue: null,
  },

  // Set by the controller when triage starts / ends. Start = the row moves to
  // 'In Triage' (the nurse opens the vitals form); end = vitals are saved for
  // this visit (patientController.recordVitals), or, failing that, the row
  // leaves 'In Triage'. Neither is overwritten once set.
  triageStartTime: {
    type: DataTypes.DATE,
    defaultValue: null,
  },
  triageEndTime: {
    type: DataTypes.DATE,
    defaultValue: null,
  },
  // When the nurse routed the patient to a doctor — the transition from a
  // nurse-facing status to 'Awaiting Doctor'. Distinct from triageEndTime:
  // vitals can be saved well before the patient is actually sent on.
  sentToDoctorAt: {
    type: DataTypes.DATE,
    defaultValue: null,
  },

  // Set by the controller when consultation starts / ends
  consultationStartTime: {
    type: DataTypes.DATE,
    defaultValue: null,
  },
  consultationEndTime: {
    type: DataTypes.DATE,
    defaultValue: null,
  },
  // Array of { doctorId, doctorName, startTime, endTime } — one entry per doctor.
  // Accurate per-doctor timing even when referrals occur across multiple doctors.
  consultationSessions: {
    type: DataTypes.JSON,
    defaultValue: null,
  },

  // Set by doctor when completing consultation — stored as JSON arrays of strings
  selectedCharges: {
    type: DataTypes.JSON,
    defaultValue: null,
  },
  selectedProcedures: {
    type: DataTypes.JSON,
    defaultValue: null,
  },
  doctorNotes: {
    type: DataTypes.TEXT,
    defaultValue: null,
  },

  // --- Accountability ---
  addedBy: {
    type: DataTypes.STRING,
    defaultValue: null,
  },
  triagedBy: {
    type: DataTypes.STRING,
    defaultValue: null,
  },

  // Set by receptionist at discharge
  dischargedAt: {
    type: DataTypes.DATE,
    defaultValue: null,
  },
  finalCharges: {
    type: DataTypes.JSON,
    defaultValue: null,
  },
  finalProcedures: {
    type: DataTypes.JSON,
    defaultValue: null,
  },
  // Itemised supplies scanned at the checkout desk and billed to the visit:
  // [{ name, quantity, labelCode, stockBatchId }]. Labels + quantities only,
  // no prices. The stock ledger holds the inventory truth; this is the bill.
  finalSupplies: {
    type: DataTypes.JSON,
    defaultValue: null,
  },
  dischargeComment: {
    type: DataTypes.TEXT,
    defaultValue: null,
  },
  dischargedBy: {
    type: DataTypes.STRING,
    defaultValue: null,
  },

  // Set when a patient is removed before discharge
  removedBy: {
    type: DataTypes.STRING,
    defaultValue: null,
  },
  removalReason: {
    type: DataTypes.TEXT,
    defaultValue: null,
  },

  // --- Referral tracking (all nullable — only set when a referral occurs) ---
  // Gives a permanent, queryable audit trail: who referred, to whom, why, and when.

  referralType: {
    type: DataTypes.ENUM('Internal', 'External'),
    defaultValue: null,
  },
  referralReason: {
    type: DataTypes.TEXT,
    defaultValue: null,
  },
  // Stored as a name string (not FK) so the record survives future reassignments
  referredByDoctorName: {
    type: DataTypes.STRING,
    defaultValue: null,
  },
  // Exact moment the referral was made — updatedAt is not reliable (changes on every update)
  referredAt: {
    type: DataTypes.DATE,
    defaultValue: null,
  },
  // Internal only: name of the doctor the patient is being sent to
  referredToDoctorName: {
    type: DataTypes.STRING,
    defaultValue: null,
  },
  // External only: name of the hospital, clinic, or specialist
  externalReferralTarget: {
    type: DataTypes.STRING,
    defaultValue: null,
  },
  // The full referral NOTE documented during the consultation ("Save & Print"),
  // independent of referralReason (the short reason captured at final submit).
  // Added by 20260811000006. Feeds the Visit History Actions tab and letterhead
  // print, mirroring admissionReason.
  referralNote: {
    type: DataTypes.TEXT,
    defaultValue: null,
  },
  referralNoteSavedAt: {
    type: DataTypes.DATE,
    defaultValue: null,
  },
  // Who wrote the note. Separate from referredByDoctorName on purpose: after an
  // INTERNAL referral that field holds the referring doctor, and the receiving
  // doctor may write their own note on the same queue row. Writing the note
  // author into referredByDoctorName would erase who actually made the referral.
  // Added by 20260812000002.
  referralNoteByDoctorName: {
    type: DataTypes.STRING,
    defaultValue: null,
  },

  // --- Admission request (HMIS V3) — mirrors the referral* block above ---
  // These columns are added by 20260807000007. They MUST be declared here:
  // Sequelize silently drops any attribute a model does not know about, so
  // without them requestAdmission's update wrote 'Pending Billing' but threw
  // away admissionRequested, and the front desk's "Admissions awaiting bed"
  // list — which filters on that flag — was always empty.

  admissionRequested: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
  admissionReason: {
    type: DataTypes.TEXT,
    defaultValue: null,
  },
  // When the admission NOTE was documented via "Save & Print", as distinct from
  // admissionRequestedAt (when it was actually sent for admission). Added by
  // 20260812000002. Mirrors referralNoteSavedAt. Documenting a note must not
  // look like a request — admissionRequested/admissionRequestedAt stay untouched
  // until requestAdmission runs.
  admissionNoteSavedAt: {
    type: DataTypes.DATE,
    defaultValue: null,
  },
  admissionType: {
    type: DataTypes.ENUM('Emergency', 'Elective', 'Transfer', 'Observation'),
    defaultValue: null,
  },
  admissionWardPreference: {
    type: DataTypes.STRING,
    defaultValue: null,
  },
  // Stored as a name string (not FK), same reasoning as referredByDoctorName
  admissionRequestedByDoctorName: {
    type: DataTypes.STRING,
    defaultValue: null,
  },
  admissionRequestedAt: {
    type: DataTypes.DATE,
    defaultValue: null,
  },
  // Set once the front desk converts this visit — the Admission it became.
  // Also what stops a visit being converted twice.
  admissionConvertedToId: {
    type: DataTypes.INTEGER,
    defaultValue: null,
  },
  admissionCancelledAt: {
    type: DataTypes.DATE,
    defaultValue: null,
  },
  admissionCancelReason: {
    type: DataTypes.TEXT,
    defaultValue: null,
  },
});

module.exports = Queue;
