// ====================================
// CRITICAL VALUE REFERENCE RANGES
// ====================================
// This module defines normal and critical ranges for common lab tests.
// Used to automatically flag critical results when lab technicians enter data.

// Why do we need this?
// - Helps identify dangerous values that require immediate attention
// - Provides consistent standards across the system
// - Can be used for auto-flagging critical results

// How to use:
// const labRanges = require('../utils/labRanges');
// const hba1cRange = labRanges['HbA1c'];
// if (value > hba1cRange.criticalMax) {
//   isCritical = true;
// }

module.exports = {
  // HbA1c (Hemoglobin A1c) - measures average blood sugar over 3 months
  'HbA1c': {
    normalMax: 6.5,        // < 6.5% is normal
    criticalMin: null,     // No critical low value
    criticalMax: 10,       // > 10% is critically high
  },

  // Fasting Blood Sugar
  'Fasting Blood Sugar': {
    normalMin: 70,         // 70-100 mg/dL is normal
    normalMax: 100,
    criticalMin: 50,       // < 50 is dangerously low (hypoglycemia)
    criticalMax: 300,      // > 300 is dangerously high (hyperglycemia)
  },

  // Lipid Profile - cholesterol and fats in blood
  'Lipid Profile': {
    totalCholesterol: {
      criticalMax: 240     // > 240 mg/dL is critically high
    },
    ldl: {                 // LDL (bad cholesterol)
      criticalMax: 160     // > 160 mg/dL is critically high
    },
  },

  // Kidney Function Test
  'Kidney Function Test': {
    creatinine: {
      criticalMax: 2.0     // > 2.0 mg/dL indicates kidney problems
    },
    egfr: {                // Estimated Glomerular Filtration Rate
      criticalMin: 30      // < 30 indicates severe kidney disease
    },
  },

  // More test types can be added as needed:
  // 'Liver Function Test': { ... },
  // 'Complete Blood Count': { ... },
  // etc.
};
