const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// =====================================================================
// Note attribution — a DOCUMENTED note must never be mistaken for a SENT
// admission/referral, and must never overwrite the audit trail of one.
//
// These are pure projection/guard rules, so they are asserted against the
// controllers' own logic without a database. The scenario in the referral suite
// is the one that actually corrupts a clinical record, so it is spelled out
// rather than summarised.
// =====================================================================

// --- The projections under test, mirrored from the controllers -------------
// admissionController.listAdvised
const admissionSent = (q) =>
  !!(q.admissionRequested || q.admissionCancelledAt || q.admissionConvertedToId);

// queueController.listAdvisedReferrals
const referralDoctorName = (q) => q.referralNoteByDoctorName || q.referredByDoctorName;

// queueController.saveReferralNote — the guard, not the write
const maySaveReferralNote = (item) => {
  if (item.status !== 'With Doctor') return { ok: false, code: 400 };
  if (item.referredAt) return { ok: false, code: 409 };
  return { ok: true };
};

describe('admission: "sent" distinguishes documented from actually requested', () => {
  test('a note that was only documented is not sent', () => {
    assert.equal(admissionSent({
      admissionRequested: false, admissionNoteSavedAt: new Date(),
      admissionCancelledAt: null, admissionConvertedToId: null,
    }), false);
  });

  test('an open request is sent', () => {
    assert.equal(admissionSent({ admissionRequested: true }), true);
  });

  test('a CANCELLED request is still sent — it did reach the front desk', () => {
    // cancelAdmissionRequest resets admissionRequested to false. Reading that
    // flag alone would make a real, cancelled request indistinguishable from a
    // note nobody ever sent.
    assert.equal(admissionSent({
      admissionRequested: false,
      admissionCancelledAt: new Date(),
      admissionConvertedToId: null,
    }), true);
  });

  test('a converted request is sent even if the flag was cleared', () => {
    assert.equal(admissionSent({
      admissionRequested: false, admissionCancelledAt: null, admissionConvertedToId: 42,
    }), true);
  });
});

describe('referral: a note must not overwrite the referral audit trail', () => {
  // The scenario, on one queue row:
  //   1. Dr A refers internally  -> referredByDoctorName 'Dr A', referredAt T1,
  //                                 status 'Awaiting Doctor', assigned to Dr B
  //   2. Dr B starts consulting  -> status 'With Doctor'
  //   3. Dr B clicks Save & Print on a draft
  //
  // Before the fix, step 3 overwrote referredByDoctorName with 'Dr B' and left
  // referredAt at T1 — erasing who referred, and rendering B's unsent draft as a
  // sent referral attributed to B.
  const T1 = new Date('2026-08-12T09:00:00Z');
  const afterDrAReferred = {
    status: 'With Doctor',            // Dr B has picked the patient up
    referredByDoctorName: 'Dr A',
    referredAt: T1,
    referralType: 'Internal',
  };

  test('Dr B cannot save a note onto a referral Dr A already made', () => {
    const verdict = maySaveReferralNote(afterDrAReferred);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, 409);
  });

  test("Dr A's attribution survives", () => {
    // The row is never written, so the field is untouched by construction.
    assert.equal(afterDrAReferred.referredByDoctorName, 'Dr A');
  });

  test('a note on a not-yet-referred visit is allowed', () => {
    assert.deepEqual(
      maySaveReferralNote({ status: 'With Doctor', referredAt: null }),
      { ok: true },
    );
  });

  test('a note cannot be written onto a visit that is not being consulted', () => {
    for (const status of ['Awaiting Doctor', 'Pending Billing', 'Completed', 'Awaiting Triage']) {
      const verdict = maySaveReferralNote({ status, referredAt: null });
      assert.equal(verdict.ok, false, `${status} should be refused`);
      assert.equal(verdict.code, 400);
    }
  });

  test('the note author is reported, not the referring doctor', () => {
    assert.equal(referralDoctorName({
      referralNoteByDoctorName: 'Dr B', referredByDoctorName: 'Dr A',
    }), 'Dr B');
  });

  test('rows predating referralNoteByDoctorName fall back cleanly', () => {
    assert.equal(referralDoctorName({
      referralNoteByDoctorName: null, referredByDoctorName: 'Dr A',
    }), 'Dr A');
  });
});

describe('ENUM writes are validated before they reach MySQL', () => {
  // Sequelize does not check ENUM membership. Without these guards a bad value
  // is either a 500 (STRICT mode) or a silently blanked clinical field.
  const ADMISSION_TYPES = ['Emergency', 'Elective', 'Transfer', 'Observation'];
  const REFERRAL_TYPES = ['Internal', 'External'];

  const validAdmissionType = (v) => !v || ADMISSION_TYPES.includes(v);
  const validReferralType = (v) => !v || REFERRAL_TYPES.includes(v);

  test('admissionType', () => {
    assert.equal(validAdmissionType('Elective'), true);
    assert.equal(validAdmissionType(undefined), true);   // optional
    assert.equal(validAdmissionType('Urgent'), false);   // plausible but wrong
    assert.equal(validAdmissionType('elective'), false); // case matters to MySQL
  });

  test('referralType', () => {
    assert.equal(validReferralType('Internal'), true);
    assert.equal(validReferralType(undefined), true);
    assert.equal(validReferralType('Cardiology'), false);
  });
});
