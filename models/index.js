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
const EquipmentAuditLog   = require('./EquipmentAuditLog');
const UserLoginLog        = require('./UserLoginLog');
const UserEditLog         = require('./UserEditLog');
const CareLinkPartner     = require('./CareLinkPartner');
const DoctorBlock         = require('./DoctorBlock');
const Notification        = require('./Notification');
const Glp1Therapy            = require('./Glp1Therapy');
const Glp1Review             = require('./Glp1Review');
const Glp1SideEffectCatalog  = require('./Glp1SideEffectCatalog');
const Glp1SideEffect         = require('./Glp1SideEffect');
const Glp1Administration     = require('./Glp1Administration');
const CatalogItem         = require('./CatalogItem');
const Setting             = require('./Setting');

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

// --- Patient self-referential merge link ---
Patient.belongsTo(Patient, { as: 'mergedInto',    foreignKey: 'mergedIntoId' });
Patient.hasMany  (Patient, { as: 'mergedPatients', foreignKey: 'mergedIntoId' });

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

User.hasMany(EquipmentHistory, { foreignKey: 'addedBy',    as: 'historyAddedEquipment' });
EquipmentHistory.belongsTo(User, { foreignKey: 'addedBy',    as: 'historyAddedByUser' });

User.hasMany(EquipmentHistory, { foreignKey: 'archivedBy', as: 'archivedEquipment' });
EquipmentHistory.belongsTo(User, { foreignKey: 'archivedBy', as: 'archivedByUser' });

// --- Equipment audit log ---
Patient.hasMany(EquipmentAuditLog);
EquipmentAuditLog.belongsTo(Patient);

User.hasMany(EquipmentAuditLog, { foreignKey: 'changedBy', as: 'equipmentAuditChanges' });
EquipmentAuditLog.belongsTo(User, { foreignKey: 'changedBy', as: 'changedByUser' });

// --- User edit audit log ---
User.hasMany(UserEditLog, { foreignKey: 'targetUserId', as: 'editLogs' });
UserEditLog.belongsTo(User, { foreignKey: 'targetUserId', as: 'targetUser' });

// --- CareLink partners ---
Patient.hasMany(CareLinkPartner);
CareLinkPartner.belongsTo(Patient);

User.hasMany(CareLinkPartner, { foreignKey: 'addedBy', as: 'addedCareLinkPartners' });
CareLinkPartner.belongsTo(User, { foreignKey: 'addedBy', as: 'addedByUser' });

// --- Doctor blocks ---
User.hasMany(DoctorBlock, { foreignKey: 'doctorId', as: 'blocks' });
DoctorBlock.belongsTo(User, { foreignKey: 'doctorId', as: 'doctor' });

// --- In-app notifications ---
Notification.belongsTo(User, { foreignKey: 'assignedDoctorId', as: 'assignedDoctor' });

// --- GLP-1 / GIP agonist monitoring ---
// Agents come from the clinic catalogue (CatalogItem tagged GLP-1/GIP); the
// therapy records the agent name directly. therapy (one per patient course) →
// review (one per monitoring visit) → side effect (one per symptom per review).
Patient.hasMany(Glp1Therapy);
Glp1Therapy.belongsTo(Patient);
Glp1Therapy.belongsTo(User, { as: 'doctor',    foreignKey: 'doctorId'  });    // the prescriber
Glp1Therapy.belongsTo(User, { as: 'stoppedByUser', foreignKey: 'stoppedBy' });

Glp1Therapy.hasMany(Glp1Review);
Glp1Review.belongsTo(Glp1Therapy);
Patient.hasMany(Glp1Review);                                                  // PatientId denormalised
Glp1Review.belongsTo(Patient);                                                //   for merge-aware reads
Glp1Review.belongsTo(User, { as: 'doctor',        foreignKey: 'doctorId'   }); // the Doctor column
Glp1Review.belongsTo(User, { as: 'amendedByUser', foreignKey: 'amendedBy'  });
Glp1Review.belongsTo(User, { as: 'deletedByUser', foreignKey: 'deletedBy'  });

Glp1Review.hasMany(Glp1SideEffect);
Glp1SideEffect.belongsTo(Glp1Review);
Glp1Therapy.hasMany(Glp1SideEffect);                                          // Glp1TherapyId denormalised
Glp1SideEffect.belongsTo(Glp1Therapy);
Glp1SideEffect.belongsTo(Glp1SideEffectCatalog, { as: 'symptom', foreignKey: 'symptomId' });
Glp1SideEffectCatalog.hasMany(Glp1SideEffect, { foreignKey: 'symptomId' });

User.hasMany(Glp1SideEffectCatalog, { foreignKey: 'addedBy', as: 'addedGlp1Symptoms' });
Glp1SideEffectCatalog.belongsTo(User, { foreignKey: 'addedBy', as: 'addedByUser' });

// Weekly injections — separate from reviews: the ladder is the plan, this is
// what happened. Usually recorded by a nurse in triage.
Glp1Therapy.hasMany(Glp1Administration);
Glp1Administration.belongsTo(Glp1Therapy);
Patient.hasMany(Glp1Administration);                                          // PatientId denormalised
Glp1Administration.belongsTo(Patient);
Glp1Administration.belongsTo(User, { as: 'administeredByUser', foreignKey: 'administeredBy' });

// A course switch links the new course back to the one it replaced
Glp1Therapy.belongsTo(Glp1Therapy, { as: 'switchedFrom', foreignKey: 'switchedFromTherapyId' });
Glp1Therapy.hasOne  (Glp1Therapy, { as: 'switchedTo',   foreignKey: 'switchedFromTherapyId' });

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
  EquipmentAuditLog,
  UserLoginLog,
  UserEditLog,
  CareLinkPartner,
  DoctorBlock,
  Notification,
  Glp1Therapy,
  Glp1Review,
  Glp1SideEffectCatalog,
  Glp1SideEffect,
  Glp1Administration,
  CatalogItem,
  Setting,
};

module.exports = db;
