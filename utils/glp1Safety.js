/**
 * Safety screening for GLP-1 / GIP agonist initiation.
 *
 * This is a hard gate: POST /api/glp1-therapies refuses to create a course
 * unless the screen has been answered. The result is stored on the therapy row
 * as it was answered at initiation and never recomputed, so the record always
 * shows what was known at the time the drug was started.
 *
 * The screen does not decide clinical suitability. It refuses to let a course be
 * recorded silently — a positive finding can still proceed, but only with a
 * named doctor and a written reason attached.
 */

// Contraindication questions that must carry an explicit true/false answer.
// true means the finding is PRESENT.
const REQUIRED_QUESTIONS = [
  { key: 'pancreatitis', label: 'History of pancreatitis' },
  { key: 'mtcMen2',      label: 'Personal or family history of medullary thyroid carcinoma / MEN2' },
  { key: 'giHistory',    label: 'Significant gastrointestinal disease (gastroparesis, IBD, prior GI surgery)' },
];

const MIN_AGE = 18;

// Ages at which a pregnancy test is expected for a female patient.
const CHILDBEARING_MIN_AGE = 12;
const CHILDBEARING_MAX_AGE = 55;

/**
 * Whole years between a date of birth and a reference date.
 * Returns null when dateOfBirth is missing or unparseable — the caller decides
 * what to do with an unknown age rather than guessing one.
 */
const ageInYears = (dateOfBirth, asOf = new Date()) => {
  if (!dateOfBirth) return null;

  const dob = new Date(dateOfBirth);
  if (Number.isNaN(dob.getTime())) return null;

  let age = asOf.getFullYear() - dob.getFullYear();
  const monthDiff = asOf.getMonth() - dob.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && asOf.getDate() < dob.getDate())) age -= 1;

  return age;
};

/**
 * Is a pregnancy test expected for this patient?
 * Unknown age errs towards asking: an unanswered question is recoverable,
 * an unasked one is not.
 */
const pregnancyTestExpected = (gender, age) => {
  if (gender !== 'Female') return false;
  if (age === null) return true;
  return age >= CHILDBEARING_MIN_AGE && age <= CHILDBEARING_MAX_AGE;
};

/**
 * Evaluates a safety screen against the patient it belongs to.
 *
 * @param {object} screen  { pancreatitis, mtcMen2, giHistory, pregnancyTest, overrideReason }
 *                         pregnancyTest: 'negative' | 'positive' | 'not applicable'
 * @param {object} patient { gender, dateOfBirth }
 *
 * @returns {{ ok: boolean, status: number, message: string|null,
 *             concerns: string[], age: number|null, overrideRequired: boolean }}
 */
const evaluateSafetyScreen = (screen, patient = {}) => {
  const age = ageInYears(patient.dateOfBirth);

  const fail = (message) => ({
    ok: false,
    status: 422,
    message,
    concerns: [],
    age,
    overrideRequired: false,
  });

  if (!screen || typeof screen !== 'object' || Array.isArray(screen)) {
    return fail('Safety screen is required before a GLP-1 therapy can be started');
  }

  // --- 1. Every contraindication question must be explicitly answered ---
  const unanswered = REQUIRED_QUESTIONS
    .filter((q) => typeof screen[q.key] !== 'boolean')
    .map((q) => q.label);

  if (unanswered.length) {
    return fail(`Safety screen incomplete — answer yes or no to: ${unanswered.join('; ')}`);
  }

  // --- 2. Pregnancy test, where applicable ---
  const needsPregnancyTest = pregnancyTestExpected(patient.gender, age);
  const pregnancyTest = screen.pregnancyTest;
  const VALID_PREGNANCY = ['negative', 'positive', 'not applicable'];

  if (needsPregnancyTest) {
    if (!VALID_PREGNANCY.includes(pregnancyTest)) {
      return fail(
        'Safety screen incomplete — a pregnancy test result is required for this patient ' +
        `(one of: ${VALID_PREGNANCY.join(', ')})`
      );
    }
  } else if (pregnancyTest !== undefined && !VALID_PREGNANCY.includes(pregnancyTest)) {
    return fail(`Pregnancy test must be one of: ${VALID_PREGNANCY.join(', ')}`);
  }

  // --- 3. Collect anything that needs a doctor to justify proceeding ---
  const concerns = [];

  REQUIRED_QUESTIONS.forEach((q) => {
    if (screen[q.key] === true) concerns.push(q.label);
  });

  if (pregnancyTest === 'positive') concerns.push('Positive pregnancy test');
  if (age !== null && age < MIN_AGE) concerns.push(`Patient is under ${MIN_AGE} (age ${age})`);

  const overrideRequired = concerns.length > 0;
  const overrideReason = typeof screen.overrideReason === 'string' ? screen.overrideReason.trim() : '';

  if (overrideRequired && !overrideReason) {
    return {
      ok: false,
      status: 422,
      message:
        'This patient has a finding that requires an explicit override reason before ' +
        `therapy can be recorded: ${concerns.join('; ')}`,
      concerns,
      age,
      overrideRequired,
    };
  }

  return { ok: true, status: 200, message: null, concerns, age, overrideRequired };
};

/**
 * Builds the JSON stored on Glp1Therapy.safetyScreen.
 * Attribution comes from the JWT, never from the client.
 */
const buildStoredScreen = (screen, evaluation, userId) => ({
  pancreatitis:   screen.pancreatitis,
  mtcMen2:        screen.mtcMen2,
  giHistory:      screen.giHistory,
  pregnancyTest:  screen.pregnancyTest ?? null,
  ageAtStart:     evaluation.age,
  concerns:       evaluation.concerns,
  overrideReason: evaluation.overrideRequired
    ? String(screen.overrideReason).trim()
    : null,
  screenedBy:     userId,
  screenedAt:     new Date().toISOString(),
});

module.exports = {
  REQUIRED_QUESTIONS,
  MIN_AGE,
  ageInYears,
  pregnancyTestExpected,
  evaluateSafetyScreen,
  buildStoredScreen,
};
