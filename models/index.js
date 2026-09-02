const sequelize = require('../config/database');
const Sequelize = require('sequelize');

// --- All model imports ---
const User                = require('./User');
// DoctorProfile and LabTechProfile are deprecated — StaffProfile is now the
// single profile table for every cadre. They are kept readable for one release
// as a rollback path and dropped by a later migration.
// See STAFF_PROFILE_DESIGN.md.
const DoctorProfile       = require('./DoctorProfile');
const StaffProfile        = require('./StaffProfile');
const LabTechProfile      = require('./LabTechProfile');
const StaffLeave          = require('./StaffLeave');
const LeaveBalance        = require('./LeaveBalance');
const StaffDocument       = require('./StaffDocument');
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
const NursingNote         = require('./NursingNote');
const MedicalDocument     = require('./MedicalDocument');
const Appointment         = require('./Appointment');
const MedicalEquipment    = require('./MedicalEquipment');
const EquipmentHistory    = require('./EquipmentHistory');
const EquipmentAuditLog   = require('./EquipmentAuditLog');
const UserLoginLog        = require('./UserLoginLog');
const PatientAccessLog    = require('./PatientAccessLog');
const UserEditLog         = require('./UserEditLog');
const CareLinkPartner     = require('./CareLinkPartner');
const DoctorBlock         = require('./DoctorBlock');
const Notification        = require('./Notification');
const Glp1Therapy            = require('./Glp1Therapy');
const Glp1Review             = require('./Glp1Review');
const Glp1SideEffectCatalog  = require('./Glp1SideEffectCatalog');
const Glp1SideEffect         = require('./Glp1SideEffect');
const Glp1Administration     = require('./Glp1Administration');
const Glp1WeekNote           = require('./Glp1WeekNote');
const CatalogItem         = require('./CatalogItem');
const Setting             = require('./Setting');
const BarcodeScan         = require('./BarcodeScan');
const PatientDiagnosis    = require('./PatientDiagnosis');
const StockItem           = require('./StockItem');
const StockLocation       = require('./StockLocation');
const StockBatch          = require('./StockBatch');
const StockMovement       = require('./StockMovement');
const StockLevel          = require('./StockLevel');
const StockParLevel       = require('./StockParLevel');
const Supplier            = require('./Supplier');

// --- HMIS V3 inpatient ---
const Ward                     = require('./Ward');
const Room                     = require('./Room');
const Bed                      = require('./Bed');
const Admission                = require('./Admission');
const BedAssignment            = require('./BedAssignment');
const InpatientObservation     = require('./InpatientObservation');
const InpatientMedicationOrder = require('./InpatientMedicationOrder');
const MedicationAdministration = require('./MedicationAdministration');
const WardRoundNote            = require('./WardRoundNote');
const DischargeSummary         = require('./DischargeSummary');
const InpatientCharge          = require('./InpatientCharge');
const RadiologyOrder           = require('./RadiologyOrder');
const FluidBalanceEntry        = require('./FluidBalanceEntry');

// --- HMIS V4 ultrasound (DICOM bridge ingest) ---
const UltrasoundImage          = require('./UltrasoundImage');
const BridgeStatus             = require('./BridgeStatus');

// --- Neuropathy Studio (in-portal Vibrotherm Dx assessment) ---
const NeuropathyStudy          = require('./NeuropathyStudy');
const NeuropathyReading        = require('./NeuropathyReading');

// --- Lab request form: test bundles ---
const LabPackage               = require('./LabPackage');
const LabPackageItem           = require('./LabPackageItem');

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

// --- Staff leave, entitlement and HR documents ---
// onDelete is left at the Sequelize default: staff accounts are archived rather
// than destroyed, so cascade behaviour should never come into play.
User.hasMany(StaffLeave);
StaffLeave.belongsTo(User);
StaffLeave.belongsTo(User, { as: 'approvedBy', foreignKey: 'approvedById' });

User.hasMany(LeaveBalance);
LeaveBalance.belongsTo(User);

User.hasMany(StaffDocument);
StaffDocument.belongsTo(User);
StaffDocument.belongsTo(User, { as: 'uploader',    foreignKey: 'uploadedById' });
StaffDocument.belongsTo(User, { as: 'lastEditor',  foreignKey: 'updatedById'  });

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
// Who took the vitals — from the JWT at write time (see recordVitals). Aliased
// camelCase key, ID not name, so the display name follows the user record.
PatientVital.belongsTo(User, { as: 'recordedByUser', foreignKey: 'recordedById' });

// Patient diagnoses — tracked list on the consultation summary panel
Patient.hasMany(PatientDiagnosis);
PatientDiagnosis.belongsTo(Patient);
PatientDiagnosis.belongsTo(User, { as: 'addedBy',    foreignKey: 'addedById'    });
PatientDiagnosis.belongsTo(User, { as: 'resolvedBy', foreignKey: 'resolvedById' });

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
// Nurse-raised requests name the doctor they are for; null for doctor-raised.
LabTest.belongsTo(User, { as: 'onBehalfOfDoctor', foreignKey: 'onBehalfOfDoctorId' });

// Lab packages (bundles) ↔ their member labTest catalogue entries.
LabPackage.belongsToMany(CatalogItem, { through: LabPackageItem, foreignKey: 'LabPackageId', otherKey: 'CatalogItemId', as: 'tests' });
CatalogItem.belongsToMany(LabPackage, { through: LabPackageItem, foreignKey: 'CatalogItemId', otherKey: 'LabPackageId', as: 'packages' });
LabPackage.hasMany(LabPackageItem, { foreignKey: 'LabPackageId' });
LabPackageItem.belongsTo(LabPackage, { foreignKey: 'LabPackageId' });
LabPackageItem.belongsTo(CatalogItem, { foreignKey: 'CatalogItemId' });

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

Patient.hasMany(NursingNote);
NursingNote.belongsTo(Patient);
NursingNote.belongsTo(User, { as: 'author',        foreignKey: 'authorId'  });
NursingNote.belongsTo(User, { as: 'deletedByUser', foreignKey: 'deletedBy' });

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

// Per-week notes — the nurse's injection note and the doctor's clinical note,
// both shown against the same week. Separate from an administration's
// missed/omitted reason. Soft-deleted, never overwritten.
Glp1Therapy.hasMany(Glp1WeekNote);
Glp1WeekNote.belongsTo(Glp1Therapy);
Patient.hasMany(Glp1WeekNote);                                                // PatientId denormalised
Glp1WeekNote.belongsTo(Patient);                                              //   for merge-aware reads
Glp1WeekNote.belongsTo(User, { as: 'author',        foreignKey: 'authorId'  }); // from the JWT
Glp1WeekNote.belongsTo(User, { as: 'deletedByUser', foreignKey: 'deletedBy' });

// --- Stock management ---
// StockMovement is the append-only ledger (source of truth); StockLevel is a
// materialized per-batch-per-location quantity rebuilt from it on demand.
// All FKs explicitly aliased camelCase except PatientId (association-generated
// PascalCase, per convention).
StockItem.belongsTo(CatalogItem, { as: 'catalogItem', foreignKey: 'catalogItemId' });
CatalogItem.hasMany(StockItem,   { foreignKey: 'catalogItemId' });
StockItem.belongsTo(User, { as: 'addedByUser',   foreignKey: 'addedById' });
StockItem.belongsTo(User, { as: 'updatedByUser', foreignKey: 'lastUpdatedById' });

StockLocation.belongsTo(User, { as: 'addedByUser',   foreignKey: 'addedById' });
StockLocation.belongsTo(User, { as: 'updatedByUser', foreignKey: 'lastUpdatedById' });

Supplier.belongsTo(User, { as: 'addedByUser',   foreignKey: 'addedById' });
Supplier.belongsTo(User, { as: 'updatedByUser', foreignKey: 'lastUpdatedById' });

StockBatch.belongsTo(StockItem, { as: 'item',     foreignKey: 'stockItemId' });
StockItem.hasMany(StockBatch,   { as: 'batches',  foreignKey: 'stockItemId' });
StockBatch.belongsTo(Supplier,  { as: 'supplier', foreignKey: 'supplierId' });
StockBatch.belongsTo(User,      { as: 'receivedByUser', foreignKey: 'receivedById' });

StockMovement.belongsTo(StockItem,     { as: 'item',         foreignKey: 'stockItemId' });
StockItem.hasMany(StockMovement,       { as: 'movements',    foreignKey: 'stockItemId' });
StockMovement.belongsTo(StockBatch,    { as: 'batch',        foreignKey: 'stockBatchId' });
StockBatch.hasMany(StockMovement,      { as: 'movements',    foreignKey: 'stockBatchId' });
StockMovement.belongsTo(StockLocation, { as: 'fromLocation', foreignKey: 'fromLocationId' });
StockMovement.belongsTo(StockLocation, { as: 'toLocation',   foreignKey: 'toLocationId' });
StockMovement.belongsTo(User,          { as: 'performedByUser', foreignKey: 'performedById' });
StockMovement.belongsTo(Prescription,  { as: 'prescription', foreignKey: 'prescriptionId' });
StockMovement.belongsTo(StockMovement, { as: 'reverses',     foreignKey: 'reversesMovementId' });
Patient.hasMany(StockMovement);        // generates PatientId — nullable until
StockMovement.belongsTo(Patient);      //   the patient-linking phase activates

// generates QueueId — the visit a checkout dispense belongs to. Null on every
// other movement type. It exists so a repeated discharge cannot dispense the
// same supplies twice; see checkoutDispense.
Queue.hasMany(StockMovement);
StockMovement.belongsTo(Queue);

StockLevel.belongsTo(StockBatch,    { as: 'batch',    foreignKey: 'stockBatchId' });
StockBatch.hasMany(StockLevel,      { as: 'levels',   foreignKey: 'stockBatchId' });
StockLevel.belongsTo(StockLocation, { as: 'location', foreignKey: 'locationId' });
StockLocation.hasMany(StockLevel,   { as: 'levels',   foreignKey: 'locationId' });

StockParLevel.belongsTo(StockItem,     { as: 'item',     foreignKey: 'stockItemId' });
StockParLevel.belongsTo(StockLocation, { as: 'location', foreignKey: 'locationId' });
StockParLevel.belongsTo(User,          { as: 'updatedByUser', foreignKey: 'lastUpdatedById' });

// --- Barcode scan audit (append-only) ---
Patient.hasMany(BarcodeScan);
BarcodeScan.belongsTo(Patient);
User.hasMany(BarcodeScan, { foreignKey: 'scannedBy', as: 'barcodeScans' });
BarcodeScan.belongsTo(User, { foreignKey: 'scannedBy', as: 'scannedByUser' });

// =============================================
// EXPORTS
// =============================================
// =============================================
// HMIS V3 — INPATIENT ASSOCIATIONS
// =============================================
Ward.hasMany(Room);   Room.belongsTo(Ward);
Room.hasMany(Bed);    Bed.belongsTo(Room);
Ward.hasMany(Bed);    Bed.belongsTo(Ward);

Patient.hasMany(Admission);   Admission.belongsTo(Patient);
Admission.belongsTo(User, { as: 'admittingDoctor', foreignKey: 'admittingDoctorId' });
Admission.belongsTo(User, { as: 'attendingDoctor', foreignKey: 'attendingDoctorId' });
Admission.belongsTo(User, { as: 'admittedByUser',  foreignKey: 'admittedById' });
Admission.belongsTo(User, { as: 'dischargedByUser', foreignKey: 'dischargedById' });
Admission.belongsTo(Ward);
Admission.belongsTo(Room);
Admission.belongsTo(Bed);

Admission.hasMany(BedAssignment);   BedAssignment.belongsTo(Admission);
BedAssignment.belongsTo(Bed);
BedAssignment.belongsTo(Ward);
BedAssignment.belongsTo(User, { as: 'movedByUser', foreignKey: 'movedById' });

Queue.belongsTo(Admission, { as: 'convertedAdmission', foreignKey: 'admissionConvertedToId' });

Admission.hasMany(InpatientObservation);   InpatientObservation.belongsTo(Admission);
Patient.hasMany(InpatientObservation);     InpatientObservation.belongsTo(Patient);
InpatientObservation.belongsTo(User, { as: 'recordedByUser', foreignKey: 'recordedById' });

Admission.hasMany(InpatientMedicationOrder);   InpatientMedicationOrder.belongsTo(Admission);
Patient.hasMany(InpatientMedicationOrder);     InpatientMedicationOrder.belongsTo(Patient);
InpatientMedicationOrder.belongsTo(CatalogItem, { foreignKey: 'catalogItemId' });
InpatientMedicationOrder.belongsTo(User, { as: 'prescribedByUser', foreignKey: 'prescribedById' });
InpatientMedicationOrder.hasMany(MedicationAdministration);
MedicationAdministration.belongsTo(InpatientMedicationOrder);
Admission.hasMany(MedicationAdministration);   MedicationAdministration.belongsTo(Admission);
Patient.hasMany(MedicationAdministration);     MedicationAdministration.belongsTo(Patient);
MedicationAdministration.belongsTo(User, { as: 'administeredByUser', foreignKey: 'administeredById' });
MedicationAdministration.belongsTo(User, { as: 'witnessedByUser',    foreignKey: 'witnessedById' });

Admission.hasMany(WardRoundNote);   WardRoundNote.belongsTo(Admission);
Patient.hasMany(WardRoundNote);     WardRoundNote.belongsTo(Patient);
WardRoundNote.belongsTo(User, { as: 'doctor', foreignKey: 'doctorId' });

Admission.hasOne(DischargeSummary);   DischargeSummary.belongsTo(Admission);
Patient.hasMany(DischargeSummary);    DischargeSummary.belongsTo(Patient);
DischargeSummary.belongsTo(User, { as: 'signedByUser', foreignKey: 'signedById' });

Admission.hasMany(InpatientCharge);   InpatientCharge.belongsTo(Admission);
Patient.hasMany(InpatientCharge);     InpatientCharge.belongsTo(Patient);
InpatientCharge.belongsTo(User, { as: 'addedByUser', foreignKey: 'addedById' });

Admission.hasMany(RadiologyOrder);   RadiologyOrder.belongsTo(Admission);
Patient.hasMany(RadiologyOrder);     RadiologyOrder.belongsTo(Patient);
RadiologyOrder.belongsTo(User, { as: 'orderedByUser', foreignKey: 'orderedById' });
RadiologyOrder.belongsTo(User, { as: 'reportedByUser', foreignKey: 'reportedById' });

// --- HMIS V4 ultrasound images (machine-ingested; PatientId nullable ⇒ Unassigned) ---
Patient.hasMany(UltrasoundImage);    UltrasoundImage.belongsTo(Patient);

// --- DICOM bridge status: who requested the last restart (nullable) ---
BridgeStatus.belongsTo(User, { as: 'restartRequestedBy', foreignKey: 'restartRequestedById' });

// --- Neuropathy Studio: study → patient (required), clinician attribution,
//     readings normalised one-row-per-site (cascade with the study) ---
Patient.hasMany(NeuropathyStudy);    NeuropathyStudy.belongsTo(Patient);
NeuropathyStudy.belongsTo(User, { as: 'performedBy', foreignKey: 'performedById' });
NeuropathyStudy.belongsTo(User, { as: 'cancelledBy', foreignKey: 'cancelledById' });
NeuropathyStudy.hasMany(NeuropathyReading, { onDelete: 'CASCADE' });
NeuropathyReading.belongsTo(NeuropathyStudy);

Admission.hasMany(FluidBalanceEntry);   FluidBalanceEntry.belongsTo(Admission);
Patient.hasMany(FluidBalanceEntry);     FluidBalanceEntry.belongsTo(Patient);
FluidBalanceEntry.belongsTo(User, { as: 'recordedByUser', foreignKey: 'recordedById' });

const db = {
  sequelize,
  Sequelize,
  User,
  DoctorProfile,
  StaffProfile,
  LabTechProfile,
  StaffLeave,
  LeaveBalance,
  StaffDocument,
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
  NursingNote,
  MedicalDocument,
  Appointment,
  MedicalEquipment,
  EquipmentHistory,
  EquipmentAuditLog,
  UserLoginLog,
  PatientAccessLog,
  UserEditLog,
  CareLinkPartner,
  DoctorBlock,
  Notification,
  Glp1Therapy,
  Glp1Review,
  Glp1SideEffectCatalog,
  Glp1SideEffect,
  Glp1Administration,
  Glp1WeekNote,
  CatalogItem,
  LabPackage,
  LabPackageItem,
  Setting,
  BarcodeScan,
  PatientDiagnosis,
  StockItem,
  StockLocation,
  StockBatch,
  StockMovement,
  StockLevel,
  StockParLevel,
  Supplier,
  // --- HMIS V3 inpatient ---
  Ward,
  Room,
  Bed,
  Admission,
  BedAssignment,
  InpatientObservation,
  InpatientMedicationOrder,
  MedicationAdministration,
  WardRoundNote,
  DischargeSummary,
  InpatientCharge,
  RadiologyOrder,
  FluidBalanceEntry,
  // --- HMIS V4 ultrasound ---
  UltrasoundImage,
  BridgeStatus,
  // --- Neuropathy Studio ---
  NeuropathyStudy,
  NeuropathyReading,
};

module.exports = db;
