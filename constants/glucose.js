// =====================================================================
// Glucose Management Centre — single source of truth for the clinical rules.
//
// Everything that decides how a glucose reading is classified, summarised or
// judged lives here, exactly as constants/neuropathy.js does for the PNS
// studio: the import controller, the summary endpoint and (via the API) the
// frontend all read the same numbers, so the doctor's screen, the patient's
// screen and any printed summary cannot disagree.
//
// Units: the HMS stores glucose in mg/dL and displays mmol/L (÷ 18), the same
// factor GlycemicChartPanel and BloodSugarReading already use. The Accu-Chek
// Instant sends kg/L whose SFLOAT mantissa IS an exact integer mg/dL (verified
// 12 Sep 2026), so meter values arrive with no rounding at all.
//
// Targets follow the International Consensus on Time in Range (Battelino et
// al., Diabetes Care 2019) for adults with T1/T2 diabetes. A per-patient
// override (PatientGlucoseTargets) replaces any of them; the summary always
// reports which set was used.
// =====================================================================

const MGDL_PER_MMOL = 18;

const mgdlToMmol = (mgdl) => (mgdl === null || mgdl === undefined ? null : Math.round((mgdl / MGDL_PER_MMOL) * 10) / 10);
const mmolToMgdl = (mmol) => (mmol === null || mmol === undefined ? null : Math.round(mmol * MGDL_PER_MMOL));

// Consensus targets, in mg/dL. Keys match PatientGlucoseTargets columns so an
// override row can be spread straight over these defaults.
const CONSENSUS_TARGETS = Object.freeze({
  tirLowMgdl:      72,   // 4.0 mmol/L  — in-range floor (clinic default; consensus is 3.9)
  tirHighMgdl:     180,  // 10.0 mmol/L — in-range ceiling
  tbrLevel2Mgdl:   54,   // 3.0 mmol/L  — level-2 hypoglycaemia
  tarLevel2Mgdl:   250,  // 13.9 mmol/L — level-2 hyperglycaemia
  fastingLowMgdl:  72,   // 4.0 mmol/L  — the clinic's own pre-meal band
  fastingHighMgdl: 126,  // 7.0 mmol/L
  cvTargetPct:     36,
  // Goals (% of readings) — reported beside each metric, never enforced.
  tirGoalPct:      70,   // > 70 % in range
  tbrGoalPct:      4,    // < 4 % below range (level 1 + 2)
  tbr2GoalPct:     1,    // < 1 % below 54
  tarGoalPct:      25,   // < 25 % above range (level 1 + 2)
  tar2GoalPct:     5,    // < 5 % above 250
});

// A named preset the doctor can pick when setting an individual target. The
// values are the consensus recommendations for those groups; a rationale is
// still required so the record says why.
const TARGET_PRESETS = Object.freeze({
  standard:  { label: 'Standard adult (T1/T2)', values: {} },
  olderHighRisk: {
    label: 'Older / high-risk adult',
    values: { tirGoalPct: 50, tbrGoalPct: 1, tarGoalPct: 50 },
  },
  pregnancy: {
    label: 'Pregnancy (T1)',
    values: { tirLowMgdl: 63, tirHighMgdl: 140, tarLevel2Mgdl: 140, tirGoalPct: 70, tbrGoalPct: 4, tarGoalPct: 25 },
  },
});

// Data-sufficiency rule for the consensus metrics. Below this the numbers are
// still returned but flagged `sufficient: false` so the UI fades them and a
// print never quotes a 5-reading GMI as if it were an HbA1c.
const SUFFICIENCY = Object.freeze({
  minDays: 14,
  minReadingsPerDay: 3,
});

// Estimated GMI from mean glucose (Bergenstal et al., 2018). Derived for CGM;
// applied to SMBG here it is an estimate and is always labelled as such.
const gmiFromMeanMgdl = (meanMgdl) => (meanMgdl > 0 ? 3.31 + 0.02392 * meanMgdl : null);

// Plausibility bounds. A bad or expired strip can produce a numeric result
// with clean status bits (the 12 Sep spike read 16 mg/dL from an expired
// strip, sensorStatus 0), so the import preview flags these for the clinician
// regardless of what the meter says about itself. They are still stored.
const PLAUSIBLE = Object.freeze({ minMgdl: 20, maxMgdl: 600 });
const isPlausible = (mgdl) => mgdl >= PLAUSIBLE.minMgdl && mgdl <= PLAUSIBLE.maxMgdl;

// Meter clock drift (host time − meter time, seconds). Above WARN the preview
// says so and the series is annotated; above NO_MATCH the (future) diary
// matcher stays off for that batch. Import itself is never blocked — the
// readings are valid, only their timing is suspect.
const CLOCK_DRIFT = Object.freeze({ warnSec: 10 * 60, noMatchSec: 30 * 60 });

// Bluetooth SIG Glucose Measurement sensor-status bits (0x2A18). Bit 5 and bit
// 9 are the only ones the Accu-Chek Instant declares in its Feature
// characteristic (0x0220); the rest are kept for other meters.
const SENSOR_STATUS_BITS = Object.freeze({
  batteryLow:         1 << 0,
  sensorMalfunction:  1 << 1,
  sampleInsufficient: 1 << 2,
  stripInsertion:     1 << 3,
  stripType:          1 << 4,
  resultTooHighOrLow: 1 << 5,   // HI / LO
  temperatureHigh:    1 << 6,
  temperatureLow:     1 << 7,
  readInterrupted:    1 << 8,
  generalFault:       1 << 9,   // the Instant labels this "time fault"
  timeFault:          1 << 10,
});

// Bits that make a reading unusable for analytics (kept, shown, not counted).
const EXCLUDING_STATUS_MASK =
  SENSOR_STATUS_BITS.sensorMalfunction |
  SENSOR_STATUS_BITS.sampleInsufficient |
  SENSOR_STATUS_BITS.stripInsertion |
  SENSOR_STATUS_BITS.stripType |
  SENSOR_STATUS_BITS.resultTooHighOrLow |
  SENSOR_STATUS_BITS.readInterrupted |
  SENSOR_STATUS_BITS.generalFault;

const statusFlags = (status) => Object.entries(SENSOR_STATUS_BITS)
  .filter(([, bit]) => (status & bit) !== 0)
  .map(([name]) => name);

// SIG sample type 10 = control solution — stored, never counted.
const SAMPLE_TYPE_CONTROL_SOLUTION = 10;

// Meter models by the DIS model string the device reports. Anything unknown
// is stored as reported and shown verbatim.
const METER_MODELS = Object.freeze({
  '973': 'Accu-Chek Instant',
});
const meterModelName = (dis) => METER_MODELS[String(dis || '').trim()] || (dis ? `Meter ${dis}` : 'Unknown meter');

// Advertised-name → serial. The Instant advertises as `meter+<serial>`.
const serialFromAdvertisedName = (name) => {
  const m = /^meter\+(\d+)$/i.exec(String(name || '').trim());
  return m ? m[1] : null;
};

// ---------------------------------------------------------------------
// Time-of-day buckets, by clock hour. The Instant has no meal marker, so until
// the patient diary (Phase 2) time-matches readings to meals these buckets —
// labelled "by clock" everywhere they appear — are the only tagging there is.
// Logbook rows carry an explicit slot and map onto the same buckets.
// ---------------------------------------------------------------------
const TIME_OF_DAY = Object.freeze([
  { key: 'overnight', label: 'Overnight',  fromHour: 0,  toHour: 5  },
  { key: 'fasting',   label: 'Fasting',    fromHour: 5,  toHour: 9  },
  { key: 'morning',   label: 'Morning',    fromHour: 9,  toHour: 12 },
  { key: 'midday',    label: 'Midday',     fromHour: 12, toHour: 15 },
  { key: 'afternoon', label: 'Afternoon',  fromHour: 15, toHour: 18 },
  { key: 'evening',   label: 'Evening',    fromHour: 18, toHour: 21 },
  { key: 'bedtime',   label: 'Bedtime',    fromHour: 21, toHour: 24 },
]);
const bucketForHour = (h) => TIME_OF_DAY.find((b) => h >= b.fromHour && h < b.toHour)?.key || 'overnight';

// BloodSugarReading.timeSlot → a representative clock hour + bucket, so the
// manual logbook and the meter share one time axis.
const LOGBOOK_SLOTS = Object.freeze({
  fasting:      { hour: 6,  minute: 30, bucket: 'fasting',   label: 'Fasting (morning)' },
  breakfast:    { hour: 9,  minute: 30, bucket: 'morning',   label: 'After breakfast' },
  beforeLunch:  { hour: 12, minute: 30, bucket: 'midday',    label: 'Before lunch' },
  afterLunch:   { hour: 14, minute: 30, bucket: 'midday',    label: 'After lunch' },
  beforeDinner: { hour: 18, minute: 30, bucket: 'evening',   label: 'Before dinner' },
  afterDinner:  { hour: 20, minute: 30, bucket: 'evening',   label: 'After dinner' },
  bedtime:      { hour: 22, minute: 0,  bucket: 'bedtime',   label: 'Bedtime' },
});

// ---------------------------------------------------------------------
// Diary time-matching (Phase 2). A meter reading is tagged pre-/post-meal
// against the patient's diary within these windows (utils/glucoseMatching.js);
// activity and dose events are shown alongside on the chart, not written onto
// the reading. All in minutes.
// ---------------------------------------------------------------------
const MATCH = Object.freeze({
  preMealMin: 60, postMealMinLow: 60, postMealMinHigh: 180, activityMin: 90, doseMin: 30,
});

// A reading's tag -> its meal relation ('pre' | 'post' | null), for the
// meal-relative glucose breakdown in summarise(). Covers both the matched
// tags (pre-<meal> / post-<meal>) and the manual logbook slots.
const mealRelationForTag = (tag) => {
  const s = String(tag || '').toLowerCase();
  if (/^pre-/.test(s) || s === 'fasting' || s === 'beforelunch' || s === 'beforedinner') return 'pre';
  if (/^post-/.test(s) || s === 'breakfast' || s === 'afterlunch' || s === 'afterdinner') return 'post';
  return null;
};

// ---------------------------------------------------------------------
// Summary maths. Pure: takes the unified reading list the controller builds
// (every row { mgdl, hour, dayKey, countable }) plus the effective targets, and
// returns the §6 metrics. Nothing here touches the database.
// ---------------------------------------------------------------------
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const sd = (xs) => {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};
const pct = (part, whole) => (whole ? Math.round((1000 * part) / whole) / 10 : 0);
const round1 = (v) => (v === null || v === undefined ? null : Math.round(v * 10) / 10);

const summarise = (rows, targets) => {
  const t = { ...CONSENSUS_TARGETS, ...(targets || {}) };
  const counted = rows.filter((r) => r.countable);
  const mg = counted.map((r) => r.mgdl);
  const n = mg.length;
  const days = new Set(counted.map((r) => r.dayKey)).size;
  const perDay = days ? n / days : 0;
  const m = mean(mg);
  const s = sd(mg);

  const nVeryLow  = mg.filter((x) => x < t.tbrLevel2Mgdl).length;
  const nLow      = mg.filter((x) => x >= t.tbrLevel2Mgdl && x < t.tirLowMgdl).length;
  const nInRange  = mg.filter((x) => x >= t.tirLowMgdl && x <= t.tirHighMgdl).length;
  const nHigh     = mg.filter((x) => x > t.tirHighMgdl && x <= t.tarLevel2Mgdl).length;
  const nVeryHigh = mg.filter((x) => x > t.tarLevel2Mgdl).length;

  const fasting = counted.filter((r) => r.bucket === 'fasting');
  const fastingInBand = fasting.filter((r) => r.mgdl >= t.fastingLowMgdl && r.mgdl <= t.fastingHighMgdl).length;

  const byBucket = TIME_OF_DAY.map((b) => {
    const xs = counted.filter((r) => r.bucket === b.key).map((r) => r.mgdl);
    return { key: b.key, label: b.label, n: xs.length, meanMgdl: round1(mean(xs)), sdMgdl: round1(sd(xs)) };
  });

  const hypos = counted
    .filter((r) => r.mgdl < t.tirLowMgdl)
    .map((r) => ({ at: r.at, mgdl: r.mgdl, level: r.mgdl < t.tbrLevel2Mgdl ? 2 : 1, source: r.source }));

  // Meal-relative glucose (from matched meter tags + the manual logbook slots).
  const inRangePctOf = (xs) => (xs.length ? pct(xs.filter((x) => x >= t.tirLowMgdl && x <= t.tirHighMgdl).length, xs.length) : null);
  const preMeal  = counted.filter((r) => mealRelationForTag(r.tag) === 'pre').map((r) => r.mgdl);
  const postMeal = counted.filter((r) => mealRelationForTag(r.tag) === 'post').map((r) => r.mgdl);
  const mealTags = {
    matched: counted.filter((r) => r.tagSource === 'matched').length,
    pre:  { n: preMeal.length,  meanMgdl: round1(mean(preMeal)),  inRangePct: inRangePctOf(preMeal) },
    post: { n: postMeal.length, meanMgdl: round1(mean(postMeal)), inRangePct: inRangePctOf(postMeal) },
  };

  return {
    readings: n,
    days,
    readingsPerDay: round1(perDay),
    sufficient: days >= SUFFICIENCY.minDays && perDay >= SUFFICIENCY.minReadingsPerDay,
    sufficiency: SUFFICIENCY,
    meanMgdl: round1(m),
    sdMgdl: round1(s),
    cvPct: m && s ? round1((100 * s) / m) : null,
    gmiPct: m ? round1(gmiFromMeanMgdl(m)) : null,
    tir: {
      veryLowPct: pct(nVeryLow, n), lowPct: pct(nLow, n), inRangePct: pct(nInRange, n),
      highPct: pct(nHigh, n), veryHighPct: pct(nVeryHigh, n),
      belowPct: pct(nVeryLow + nLow, n), abovePct: pct(nHigh + nVeryHigh, n),
    },
    hypoCount: hypos.length,
    hypoLevel2Count: hypos.filter((h) => h.level === 2).length,
    hypos,
    fasting: { n: fasting.length, inBandPct: fasting.length ? pct(fastingInBand, fasting.length) : null },
    mealTags,
    timeOfDay: byBucket,
    targets: t,
  };
};

module.exports = {
  MGDL_PER_MMOL, mgdlToMmol, mmolToMgdl,
  CONSENSUS_TARGETS, TARGET_PRESETS, SUFFICIENCY, gmiFromMeanMgdl,
  PLAUSIBLE, isPlausible, CLOCK_DRIFT,
  SENSOR_STATUS_BITS, EXCLUDING_STATUS_MASK, statusFlags, SAMPLE_TYPE_CONTROL_SOLUTION,
  METER_MODELS, meterModelName, serialFromAdvertisedName,
  TIME_OF_DAY, bucketForHour, LOGBOOK_SLOTS,
  MATCH, mealRelationForTag,
  summarise,
};
