const { defineModel, DataTypes } = require('../utils/defineModel');

// Append-only audit of barcode events — scans AND generations (prints, emails).
// One row per event. Never updated or deleted. Feeds the admin Activity Log
// via activityController.getBarcodeEvents.
// PatientId is association-generated (Patient.hasMany(BarcodeScan) in models/index.js)
// and points at the RESOLVED canonical patient for patient scans — see
// redirectedFromUhid for the raw code when it belonged to a merged-away record.
// PatientId is nullable and resolvedType is a plain string so this same table
// serves future lab, pharmacy, asset and stock scans without a migration.
const BarcodeScan = defineModel('BarcodeScan', {
  // The signed-in user who performed the scan — from the JWT (req.user.id), never the client.
  scannedBy: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },

  // Exactly what the scanner sent, uppercased/trimmed (e.g. "CDC042").
  rawPayload: {
    type: DataTypes.STRING,
    allowNull: false,
  },

  // What the payload resolved to: 'patient' now; 'labTest', 'prescription',
  // 'asset', 'stock' when those services go live. STRING (not ENUM) so new
  // types need no schema change.
  resolvedType: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'patient',
  },

  // Set only when a merged-away UHID was scanned and we redirected to the
  // canonical record. null on a normal scan.
  redirectedFromUhid: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: null,
  },

  // What happened: 'scan' | 'print_card' | 'print_label' | 'email'.
  // Plain STRING (not ENUM) so new event kinds need no schema change.
  action: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'scan',
  },

  // How a scan arrived ('camera' reserved for the future in-app camera path).
  // null for generation events (prints, emails).
  source: {
    type: DataTypes.ENUM('usb', 'camera'),
    allowNull: true,
    defaultValue: null,
  },
});

module.exports = BarcodeScan;
