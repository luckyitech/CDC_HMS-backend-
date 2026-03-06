const sequelize = require('../config/database');
const Sequelize = require('sequelize');

// --- All model imports ---
const User                = require('./User');
const DoctorProfile       = require('./DoctorProfile');
const StaffProfile        = require('./StaffProfile');
const LabTechProfile      = require('./LabTechProfile');
const Patient             = require('./Patient');
const PatientVital        = require('./PatientVital');
const BloodSugarReading   = require('./BloodSugarReading');
const Queue               = require('./Queue');
const Prescription        = require('./Prescription');
const LabTest             = require('./LabTest');
const TreatmentPlan       = require('./TreatmentPlan');
const PhysicalExamination = require('./PhysicalExamination');
const InitialAssessment   = require('./InitialAssessment');
const ConsultationNote    = require('./ConsultationNote');
const MedicalDocument     = require('./MedicalDocument');
const Appointment         = require('./Appointment');
const MedicalEquipment    = require('./MedicalEquipment');
const EquipmentHistory    = require('./EquipmentHistory');

// =============================================
// ASSOCIATIONS
// =============================================

// --- Role profiles (one-to-one with User) ---
User.hasOne(DoctorProfile);
DoctorProfile.belongsTo(User);

User.hasOne(StaffProfile);
StaffProfile.belongsTo(User);

User.hasOne(LabTechProfile);
LabTechProfile.belongsTo(User);

// --- Patient ↔ User (two links, aliases required) ---
User.hasOne(Patient);                                                          // patient's own login
Patient.belongsTo(User);
Patient.belongsTo(User, { as: 'primaryDoctor', foreignKey: 'primaryDoctorId' }); // assigned doctor

// --- Patient children (one-to-many) ---
Patient.hasMany(PatientVital);
PatientVital.belongsTo(Patient);

Patient.hasMany(BloodSugarReading);
BloodSugarReading.belongsTo(Patient);

Patient.hasMany(Queue);
Queue.belongsTo(Patient);
Queue.belongsTo(User, { as: 'assignedDoctor', foreignKey: 'assignedDoctorId' });

Patient.hasMany(Prescription);
Prescription.belongsTo(Patient);
Prescription.belongsTo(User, { as: 'doctor', foreignKey: 'doctorId' });

Patient.hasMany(LabTest);
LabTest.belongsTo(Patient);
LabTest.belongsTo(User, { as: 'orderedBy', foreignKey: 'orderedById' });

Patient.hasMany(TreatmentPlan);
TreatmentPlan.belongsTo(Patient);
TreatmentPlan.belongsTo(User, { as: 'doctor', foreignKey: 'doctorId' });

Patient.hasMany(PhysicalExamination);
PhysicalExamination.belongsTo(Patient);
PhysicalExamination.belongsTo(User, { as: 'doctor', foreignKey: 'doctorId' });

Patient.hasMany(InitialAssessment);
InitialAssessment.belongsTo(Patient);
InitialAssessment.belongsTo(User, { as: 'doctor', foreignKey: 'doctorId' });

Patient.hasMany(ConsultationNote);
ConsultationNote.belongsTo(Patient);
ConsultationNote.belongsTo(User, { as: 'doctor', foreignKey: 'doctorId' });

Patient.hasMany(MedicalDocument);
MedicalDocument.belongsTo(Patient);
MedicalDocument.belongsTo(User, { as: 'uploader', foreignKey: 'uploadedById' });

Patient.hasMany(Appointment);
Appointment.belongsTo(Patient);
Appointment.belongsTo(User, { as: 'doctor', foreignKey: 'doctorId' });

Patient.hasMany(MedicalEquipment);
MedicalEquipment.belongsTo(Patient);

Patient.hasMany(EquipmentHistory);
EquipmentHistory.belongsTo(Patient);

// --- Equipment history links back to the equipment record it archived ---
MedicalEquipment.hasMany(EquipmentHistory);
EquipmentHistory.belongsTo(MedicalEquipment);

// --- User associations for equipment tracking ---
User.hasMany(MedicalEquipment, { foreignKey: 'addedBy', as: 'addedEquipment' });
MedicalEquipment.belongsTo(User, { foreignKey: 'addedBy', as: 'addedByUser' });

User.hasMany(MedicalEquipment, { foreignKey: 'lastUpdatedBy', as: 'updatedEquipment' });
MedicalEquipment.belongsTo(User, { foreignKey: 'lastUpdatedBy', as: 'updatedByUser' });

User.hasMany(EquipmentHistory, { foreignKey: 'archivedBy', as: 'archivedEquipment' });
EquipmentHistory.belongsTo(User, { foreignKey: 'archivedBy', as: 'archivedByUser' });

// =============================================
// EXPORTS
// =============================================
const db = {
  sequelize,
  Sequelize,
  User,
  DoctorProfile,
  StaffProfile,
  LabTechProfile,
  Patient,
  PatientVital,
  BloodSugarReading,
  Queue,
  Prescription,
  LabTest,
  TreatmentPlan,
  PhysicalExamination,
  InitialAssessment,
  ConsultationNote,
  MedicalDocument,
  Appointment,
  MedicalEquipment,
  EquipmentHistory,
};

module.exports = db;
