
// ====================================
// MEDICAL THRESHOLD CONSTANTS
// ====================================
// Centralized medical constants for diabetes management.
// Used across report generation and risk assessment.

const BLOOD_SUGAR = {
  // Blood Sugar Thresholds (mg/dL)
  HYPOGLYCEMIA: 70,
  HYPERGLYCEMIA: 180,
  SEVERE_HYPERGLYCEMIA: 250,
  TARGET_MIN: 70,
  TARGET_MAX: 180,
  FASTING_TARGET: 130,
};

const HBA1C = {
  // HbA1c Thresholds (%)
  NORMAL: 5.7,
  PREDIABETES: 6.5,
  WELL_CONTROLLED: 7.0,
  MODERATE: 8.0,
  POOR: 9.0,
};

const RISK = {
  // Risk Assessment Thresholds
  AGE_HIGH: 65,
  AGE_MODERATE: 50,
  COMORBIDITY_HIGH: 2,
  SCORE_HIGH: 6,
  SCORE_MEDIUM: 3,
  TIME_IN_RANGE_TARGET: 70,
};

// Combined export for convenience
const THRESHOLDS = {
  ...BLOOD_SUGAR,
  TARGET_RANGE: { min: BLOOD_SUGAR.TARGET_MIN, max: BLOOD_SUGAR.TARGET_MAX },
  HBA1C_NORMAL: HBA1C.NORMAL,
  HBA1C_PREDIABETES: HBA1C.PREDIABETES,
  HBA1C_WELL_CONTROLLED: HBA1C.WELL_CONTROLLED,
  HBA1C_MODERATE: HBA1C.MODERATE,
  HBA1C_POOR: HBA1C.POOR,
  AGE_HIGH_RISK: RISK.AGE_HIGH,
  AGE_MODERATE_RISK: RISK.AGE_MODERATE,
  COMORBIDITY_HIGH: RISK.COMORBIDITY_HIGH,
  RISK_SCORE_HIGH: RISK.SCORE_HIGH,
  RISK_SCORE_MEDIUM: RISK.SCORE_MEDIUM,
  TIME_IN_RANGE_TARGET: RISK.TIME_IN_RANGE_TARGET,
};

// ====================================
// CLASSIFICATION FUNCTIONS
// ====================================

/**
 * Classify HbA1c value into control level
 * @param {number|string} value - HbA1c value
 * @returns {string} Classification: 'Normal', 'Prediabetes', 'Well Controlled', 'Moderately Controlled', 'Poorly Controlled', or 'Unknown'
 */
const classifyHbA1c = (value) => {
  if (!value) return 'Unknown';
  const numValue = parseFloat(value);
  if (numValue < HBA1C.NORMAL) return 'Normal';
  if (numValue < HBA1C.PREDIABETES) return 'Prediabetes';
  if (numValue < HBA1C.WELL_CONTROLLED) return 'Well Controlled';
  if (numValue < HBA1C.MODERATE) return 'Moderately Controlled';
  return 'Poorly Controlled';
};

/**
 * Calculate risk level based on patient data
 * @param {Object} patient - Patient object with age, comorbidities
 * @param {number[]} recentBloodSugar - Array of recent blood sugar values
 * @param {number} recentHbA1c - Recent HbA1c value
 * @returns {string} Risk level: 'High', 'Medium', or 'Low'
 */
const calculateRiskLevel = (patient, recentBloodSugar, recentHbA1c) => {
  let riskScore = 0;

  // Age factor
  if (patient.age > RISK.AGE_HIGH) riskScore += 2;
  else if (patient.age > RISK.AGE_MODERATE) riskScore += 1;

  // HbA1c factor
  if (recentHbA1c >= HBA1C.POOR) riskScore += 3;
  else if (recentHbA1c >= HBA1C.MODERATE) riskScore += 2;
  else if (recentHbA1c >= HBA1C.WELL_CONTROLLED) riskScore += 1;

  // Blood sugar variability
  if (recentBloodSugar.some(bs => bs > BLOOD_SUGAR.SEVERE_HYPERGLYCEMIA || bs < BLOOD_SUGAR.HYPOGLYCEMIA)) {
    riskScore += 2;
  }

  // Comorbidities
  const comorbidities = patient.comorbidities || [];
  if (comorbidities.length > RISK.COMORBIDITY_HIGH) riskScore += 2;
  else if (comorbidities.length > 0) riskScore += 1;

  // Determine level
  if (riskScore >= RISK.SCORE_HIGH) return 'High';
  if (riskScore >= RISK.SCORE_MEDIUM) return 'Medium';
  return 'Low';
};

/**
 * Get risk factors for a patient
 * @param {Object} patient - Patient object
 * @param {number[]} bloodSugarValues - Array of blood sugar values
 * @returns {string[]} Array of risk factor descriptions
 */
const getRiskFactors = (patient, bloodSugarValues) => {
  const riskFactors = [];
  const hba1c = parseFloat(patient.hba1c);

  if (hba1c >= HBA1C.POOR) riskFactors.push('Very high HbA1c');
  else if (hba1c >= HBA1C.MODERATE) riskFactors.push('High HbA1c');

  if (bloodSugarValues.some(v => v > BLOOD_SUGAR.SEVERE_HYPERGLYCEMIA)) {
    riskFactors.push('Recent severe hyperglycemia');
  }
  if (bloodSugarValues.some(v => v < BLOOD_SUGAR.HYPOGLYCEMIA)) {
    riskFactors.push('Recent hypoglycemia');
  }
  if ((patient.comorbidities || []).length > RISK.COMORBIDITY_HIGH) {
    riskFactors.push('Multiple comorbidities');
  }
  if (patient.age > RISK.AGE_HIGH) {
    riskFactors.push('Advanced age');
  }

  return riskFactors;
};

/**
 * Calculate blood sugar statistics from readings
 * @param {Object[]} bloodSugarReadings - Array of blood sugar reading objects with value, timeSlot
 * @returns {Object} Statistics object
 */
const calculateBloodSugarStats = (bloodSugarReadings) => {
  const { calculateAverage } = require('./formatters');

  const readings = bloodSugarReadings.map(bs => parseFloat(bs.value));
  const fastingReadings = bloodSugarReadings
    .filter(bs => bs.timeSlot === 'fasting')
    .map(bs => parseFloat(bs.value));
  const postMealReadings = bloodSugarReadings
    .filter(bs => ['afterBreakfast', 'afterLunch', 'afterDinner'].includes(bs.timeSlot))
    .map(bs => parseFloat(bs.value));

  const inRange = readings.filter(r => r >= BLOOD_SUGAR.TARGET_MIN && r <= BLOOD_SUGAR.TARGET_MAX);

  return {
    totalReadings: readings.length,
    averageBloodSugar: Math.round(calculateAverage(readings)),
    averageFasting: Math.round(calculateAverage(fastingReadings)),
    averagePostMeal: Math.round(calculateAverage(postMealReadings)),
    minReading: readings.length ? Math.min(...readings) : 0,
    maxReading: readings.length ? Math.max(...readings) : 0,
    hypoglycemiaEvents: readings.filter(r => r < BLOOD_SUGAR.HYPOGLYCEMIA).length,
    hyperglycemiaEvents: readings.filter(r => r > BLOOD_SUGAR.HYPERGLYCEMIA).length,
    inTargetRange: inRange.length,
    timeInRange: readings.length ? Math.round((inRange.length / readings.length) * 100) : 0,
  };
};

// ====================================
// EXPORTS
// ====================================
module.exports = {
  // Constants
  BLOOD_SUGAR,
  HBA1C,
  RISK,
  THRESHOLDS,
  // Functions
  classifyHbA1c,
  calculateRiskLevel,
  getRiskFactors,
  calculateBloodSugarStats,
};
