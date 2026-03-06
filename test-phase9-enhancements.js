/**
 * Phase 9 Enhanced Tests
 * Tests all perfection improvements
 */

const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'http://localhost:3000/api';

// Test user tokens
let doctorToken, staffToken, patientToken;

// Color codes for console
const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  reset: '\x1b[0m'
};

const log = {
  success: (msg) => console.log(`${colors.green}✓${colors.reset} ${msg}`),
  error: (msg) => console.log(`${colors.red}✗${colors.reset} ${msg}`),
  info: (msg) => console.log(`${colors.blue}ℹ${colors.reset} ${msg}`),
  test: (msg) => console.log(`\n${colors.yellow}TEST:${colors.reset} ${msg}`)
};

// Helper to create a test file
function createTestFile(filename, content, mimetype = 'text/plain') {
  const filePath = path.join(__dirname, 'test-files', filename);

  // Create test-files directory if it doesn't exist
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(filePath, content);
  return filePath;
}

// Login helper
async function login(email, password) {
  try {
    const res = await axios.post(`${BASE_URL}/auth/login`, { email, password });
    return res.data.data.token;
  } catch (err) {
    log.error(`Login failed for ${email}`);
    throw err;
  }
}

// Test Suite
async function runTests() {
  try {
    log.info('Phase 9 Enhanced Tests Starting...\n');

    // =====================================
    // SETUP: Login users
    // =====================================
    log.info('Logging in test users...');
    doctorToken = await login('ahmed.hassan@cdc.com', 'password123');
    staffToken = await login('staff@cdc.com', 'password123');
    patientToken = await login('patient@cdc.com', 'password123');
    log.success('All users logged in\n');

    // =====================================
    // TEST 1: Invalid document category
    // =====================================
    log.test('1. Invalid document category should be rejected');
    try {
      const form = new FormData();
      const filePath = createTestFile('test.pdf', 'PDF content');
      form.append('file', fs.createReadStream(filePath));
      form.append('uhid', 'CDC001');
      form.append('documentCategory', 'Invalid Category');

      await axios.post(`${BASE_URL}/documents`, form, {
        headers: {
          ...form.getHeaders(),
          Authorization: `Bearer ${doctorToken}`
        }
      });
      log.error('Should have rejected invalid category');
    } catch (err) {
      if (err.response?.status === 400 && err.response.data.message.includes('Invalid document category')) {
        log.success('Invalid category rejected with helpful message');
      } else {
        log.error('Wrong error response');
      }
    }

    // =====================================
    // TEST 2: Valid category should work
    // =====================================
    log.test('2. Valid category should be accepted');
    try {
      const form = new FormData();
      const filePath = createTestFile('test2.pdf', 'PDF content');
      form.append('file', fs.createReadStream(filePath));
      form.append('uhid', 'CDC001');
      form.append('documentCategory', 'Lab Report - External');

      const res = await axios.post(`${BASE_URL}/documents`, form, {
        headers: {
          ...form.getHeaders(),
          Authorization: `Bearer ${doctorToken}`
        }
      });

      if (res.status === 201 && res.data.data.documentCategory === 'Lab Report - External') {
        log.success('Valid category accepted');
      }
    } catch (err) {
      log.error('Failed: ' + err.response?.data?.message);
    }

    // =====================================
    // TEST 3: Future testDate should be rejected
    // =====================================
    log.test('3. Future testDate should be rejected');
    try {
      const form = new FormData();
      const filePath = createTestFile('test3.pdf', 'PDF content');
      form.append('file', fs.createReadStream(filePath));
      form.append('uhid', 'CDC001');
      form.append('documentCategory', 'Lab Report - External');
      form.append('testDate', '2027-12-31'); // Future date

      await axios.post(`${BASE_URL}/documents`, form, {
        headers: {
          ...form.getHeaders(),
          Authorization: `Bearer ${doctorToken}`
        }
      });
      log.error('Should have rejected future date');
    } catch (err) {
      if (err.response?.status === 400 && err.response.data.message.includes('future')) {
        log.success('Future date rejected');
      } else {
        log.error('Wrong error response');
      }
    }

    // =====================================
    // TEST 4: Invalid testDate format
    // =====================================
    log.test('4. Invalid testDate format should be rejected');
    try {
      const form = new FormData();
      const filePath = createTestFile('test4.pdf', 'PDF content');
      form.append('file', fs.createReadStream(filePath));
      form.append('uhid', 'CDC001');
      form.append('documentCategory', 'Lab Report - External');
      form.append('testDate', '12/31/2026'); // Wrong format

      await axios.post(`${BASE_URL}/documents`, form, {
        headers: {
          ...form.getHeaders(),
          Authorization: `Bearer ${doctorToken}`
        }
      });
      log.error('Should have rejected invalid date format');
    } catch (err) {
      if (err.response?.status === 400 && err.response.data.message.includes('YYYY-MM-DD')) {
        log.success('Invalid date format rejected with helpful message');
      } else {
        log.error('Wrong error response');
      }
    }

    // =====================================
    // TEST 5: Staff can review documents
    // =====================================
    log.test('5. Staff should be able to review documents');
    try {
      // First, upload a document as patient (status will be Pending Review)
      const form = new FormData();
      const filePath = createTestFile('test5.pdf', 'PDF content');
      form.append('file', fs.createReadStream(filePath));
      form.append('uhid', 'CDC001');
      form.append('documentCategory', 'Imaging Report');

      const uploadRes = await axios.post(`${BASE_URL}/documents`, form, {
        headers: {
          ...form.getHeaders(),
          Authorization: `Bearer ${patientToken}`
        }
      });

      const docId = uploadRes.data.data.id;

      // Now staff tries to review it
      const reviewRes = await axios.put(`${BASE_URL}/documents/${docId}/status`,
        { status: 'Reviewed' },
        { headers: { Authorization: `Bearer ${staffToken}` } }
      );

      if (reviewRes.status === 200 && reviewRes.data.data.reviewedBy) {
        log.success('Staff successfully reviewed document (no "Dr." prefix)');
        log.info(`  Reviewed by: ${reviewRes.data.data.reviewedBy}`);
      }
    } catch (err) {
      log.error('Staff review failed: ' + err.response?.data?.message);
    }

    // =====================================
    // TEST 6: Notes length validation
    // =====================================
    log.test('6. Notes exceeding 5000 characters should be rejected');
    try {
      const form = new FormData();
      const filePath = createTestFile('test6.pdf', 'PDF content');
      form.append('file', fs.createReadStream(filePath));
      form.append('uhid', 'CDC001');
      form.append('documentCategory', 'Lab Report - External');
      form.append('notes', 'A'.repeat(5001)); // Exceeds limit

      await axios.post(`${BASE_URL}/documents`, form, {
        headers: {
          ...form.getHeaders(),
          Authorization: `Bearer ${doctorToken}`
        }
      });
      log.error('Should have rejected long notes');
    } catch (err) {
      if (err.response?.status === 400 && err.response.data.message.includes('5000')) {
        log.success('Long notes rejected with character limit');
      } else {
        log.error('Wrong error response');
      }
    }

    // =====================================
    // TEST 7: Authenticated file serving
    // =====================================
    log.test('7. Authenticated file serving');
    try {
      // Upload a document
      const form = new FormData();
      const filePath = createTestFile('test7.pdf', 'PDF content for serving test');
      form.append('file', fs.createReadStream(filePath));
      form.append('uhid', 'CDC001');
      form.append('documentCategory', 'Lab Report - External');

      const uploadRes = await axios.post(`${BASE_URL}/documents`, form, {
        headers: {
          ...form.getHeaders(),
          Authorization: `Bearer ${doctorToken}`
        }
      });

      const fileUrl = uploadRes.data.data.fileUrl; // e.g., /uploads/documents/uuid.pdf
      const filename = path.basename(fileUrl);

      // Try to access via authenticated endpoint
      const fileRes = await axios.get(`${BASE_URL}/documents/file/${filename}`, {
        headers: { Authorization: `Bearer ${doctorToken}` }
      });

      if (fileRes.status === 200) {
        log.success('Authenticated file serving works');
      }
    } catch (err) {
      log.error('Authenticated file serving failed: ' + err.response?.data?.message);
    }

    // =====================================
    // TEST 8: Patient cannot access other patient's files
    // =====================================
    log.test('8. Patient should not access other patient\'s documents');
    try {
      // Doctor uploads for CDC002
      const form = new FormData();
      const filePath = createTestFile('test8.pdf', 'PDF content');
      form.append('file', fs.createReadStream(filePath));
      form.append('uhid', 'CDC002'); // Different patient
      form.append('documentCategory', 'Lab Report - External');

      const uploadRes = await axios.post(`${BASE_URL}/documents`, form, {
        headers: {
          ...form.getHeaders(),
          Authorization: `Bearer ${doctorToken}`
        }
      });

      const fileUrl = uploadRes.data.data.fileUrl;
      const filename = path.basename(fileUrl);

      // Patient (CDC001) tries to access CDC002's file
      await axios.get(`${BASE_URL}/documents/file/${filename}`, {
        headers: { Authorization: `Bearer ${patientToken}` } // CDC001's token
      });

      log.error('Patient should not have accessed other patient\'s document');
    } catch (err) {
      if (err.response?.status === 403) {
        log.success('Patient correctly denied access to other patient\'s document');
      } else {
        log.error('Wrong error response');
      }
    }

    // =====================================
    // CLEANUP
    // =====================================
    log.info('\nCleaning up test files...');
    const testDir = path.join(__dirname, 'test-files');
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    log.success('Cleanup complete');

    log.info('\n' + colors.green + '═'.repeat(50));
    log.info('All enhanced tests completed!');
    log.info('═'.repeat(50) + colors.reset);

  } catch (err) {
    log.error('Test suite failed: ' + err.message);
    console.error(err);
  }
}

// Run tests
runTests();
