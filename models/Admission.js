const { defineModel, DataTypes } = require('../utils/defineModel');

// The inpatient spine. One row per hospital stay. Everything inpatient
// (observations, medication orders, ward-round notes, discharge summary,
// charges) hangs off an Admission. Merge-aware: PatientId is the resolved
// canonical patient (association-generated).
const Admission = defineModel('Admission', {
  // PatientId               — association-generated (canonical, merge-aware)
  // WardId, RoomId, BedId   — current location, denormalised for board reads
  admittingDoctorId: { type: DataTypes.INTEGER, allowNull: true },   // advising doctor (carried from request)
  attendingDoctorId: { type: DataTypes.INTEGER, allowNull: true },   // reassignable mid-stay

  admissionDateTime:    { type: DataTypes.DATE, allowNull: false },
  admissionReason:      { type: DataTypes.TEXT, allowNull: true },
  provisionalDiagnosis: { type: DataTypes.TEXT, allowNull: true },
  admissionType: {
    type: DataTypes.ENUM('Emergency', 'Elective', 'Transfer', 'Observation'),
    allowNull: false,
    defaultValue: 'Elective',
  },
  admissionSource: {
    type: DataTypes.ENUM('OPD', 'Referral', 'Walk-in', 'Transfer-in'),
    allowNull: false,
    defaultValue: 'OPD',
  },

  status: {
    type: DataTypes.ENUM('Admitted', 'OnLeave', 'Transferred', 'Discharged', 'Deceased', 'Absconded'),
    allowNull: false,
    defaultValue: 'Admitted',
  },

  dischargeDateTime: { type: DataTypes.DATE, allowNull: true },
  dischargeType: {
    type: DataTypes.ENUM('Routine', 'AgainstAdvice', 'Referred', 'Deceased', 'Absconded'),
    allowNull: true,
  },
  lengthOfStayHours: { type: DataTypes.INTEGER, allowNull: true },   // derived on discharge

  // Linkage + accountability
  fromQueueId:    { type: DataTypes.INTEGER, allowNull: true },   // OPD visit this admission came from
  admittedById:   { type: DataTypes.INTEGER, allowNull: true },   // front desk user who converted (JWT)
  dischargedById: { type: DataTypes.INTEGER, allowNull: true },

  // Billing intent captured at conversion ('clear' = OPD bill settled now,
  // 'merge' = OPD charges rolled into the inpatient account). Phase 5 accrual.
  opdBillingMode: {
    type: DataTypes.ENUM('clear', 'merge'),
    allowNull: true,
  },
});

module.exports = Admission;
