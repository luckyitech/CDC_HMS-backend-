// Fingerprint scanner, 1 Nov 2026 — a scanner ID is proposed for a staff member
// only when the number AND the first name fit. The clinic's K40 held old
// enrolments whose numbers matched staff IDs by chance (scanner 2 "Mildred"
// was proposed as EMP002 Ahmed Hassan), so a number alone is not enough.
const test = require('node:test');
const assert = require('node:assert/strict');
const { nameFits } = require('../services/scannerService');

test('the same first name fits, whatever the case or surname', () => {
  assert.equal(nameFits('Mildred', 'Mildred'), true);
  assert.equal(nameFits('BRIDGIT', 'Bridgit'), true);
  assert.equal(nameFits('Gaman Ali', 'Gaman'), true);
});

test('a name the scanner cut short still fits', () => {
  assert.equal(nameFits('Halim', 'Halima'), true);
  assert.equal(nameFits('Abdulrahman', 'Abdul'), true);
});

test('old enrolments whose number matched by chance do not fit', () => {
  assert.equal(nameFits('Mildred', 'Ahmed'), false);
  assert.equal(nameFits('Abdul', 'James'), false);
  assert.equal(nameFits('Kim', 'FARAH'), false);
  assert.equal(nameFits('Paullet', 'Halima'), false);
  assert.equal(nameFits('SUPPORT', 'Sarah'), false);
});

test('no name, a number for a name, or a stub is never enough', () => {
  assert.equal(nameFits('', 'Sarah'), false);
  assert.equal(nameFits(null, 'Sarah'), false);
  assert.equal(nameFits('38228102', 'Ebrahim'), false);
  assert.equal(nameFits('no name', 'Nora'), false);
  assert.equal(nameFits('Ed', 'Edward'), false);
});
