// ====================================
// SHARED FORMATTING UTILITIES
// ====================================
// Centralized helpers used across multiple controllers
// to eliminate code duplication and ensure consistency.

// ====================================
// NAME FORMATTERS
// ====================================

/**
 * Format a full name from first and last name
 * @param {string} firstName
 * @param {string} lastName
 * @returns {string} "FirstName LastName"
 */
const formatName = (firstName, lastName) => {
  return `${firstName} ${lastName}`;
};

/**
 * Format patient name from a patient object
 * @param {Object} patient - Patient object with firstName, lastName
 * @returns {string|null} "FirstName LastName" or null if no patient
 */
const formatPatientName = (patient) => {
  if (!patient) return null;
  return `${patient.firstName} ${patient.lastName}`;
};

/**
 * Format doctor name with "Dr." prefix
 * @param {Object} doctor - Doctor/User object with firstName, lastName
 * @returns {string|null} "Dr. FirstName LastName" or null if no doctor
 */
const formatDoctorName = (doctor) => {
  if (!doctor) return null;
  return `Dr. ${doctor.firstName} ${doctor.lastName}`;
};

/**
 * Format user name from a user object
 * @param {Object} user - User object with firstName, lastName
 * @returns {string|null} "FirstName LastName" or null if no user
 */
const formatUserName = (user) => {
  if (!user) return null;
  return `${user.firstName} ${user.lastName}`;
};

// ====================================
// DATE UTILITIES
// ====================================

/**
 * Get today's date as ISO string (YYYY-MM-DD)
 * @returns {string} Today's date in ISO format
 */
const getTodayISO = () => {
  return new Date().toISOString().split('T')[0];
};

/**
 * Get date N days ago as ISO string (YYYY-MM-DD)
 * @param {number} days - Number of days to go back
 * @returns {string} Date N days ago in ISO format
 */
const getDaysAgo = (days) => {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().split('T')[0];
};

/**
 * Get date range for a given period
 * @param {string} period - Period string: '7days', '30days', '90days', '6months', '1year'
 * @returns {Object} { startDate: string, endDate: string }
 */
const getDateRange = (period) => {
  const periodMap = {
    '7days': 7,
    '30days': 30,
    '90days': 90,
    '6months': 180,
    '1year': 365,
  };

  const days = periodMap[period] || 30;

  return {
    startDate: getDaysAgo(days),
    endDate: getTodayISO(),
  };
};

// ====================================
// MATH UTILITIES
// ====================================

/**
 * Calculate average from an array of numbers
 * @param {number[]} arr - Array of numbers
 * @returns {number} Average value (0 if empty)
 */
const calculateAverage = (arr) => {
  if (!arr || arr.length === 0) return 0;
  return arr.reduce((sum, val) => sum + val, 0) / arr.length;
};

// ====================================
// EXPORTS
// ====================================
module.exports = {
  // Name formatters
  formatName,
  formatPatientName,
  formatDoctorName,
  formatUserName,
  // Date utilities
  getTodayISO,
  getDaysAgo,
  getDateRange,
  // Math utilities
  calculateAverage,
};
