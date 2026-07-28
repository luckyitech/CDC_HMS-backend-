const { defineModel, DataTypes } = require('../utils/defineModel');

// Append-only audit of barcode scans. One row per successful resolution.
// Never updated or deleted.
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

  // How the scan arrived. 'camera' reserved for the future in-app camera path.
  source: {
    type: DataTypes.ENUM('usb', 'camera'),
    allowNull: false,
    defaultValue: 'usb',
  },
});

module.exports = BarcodeScan;
