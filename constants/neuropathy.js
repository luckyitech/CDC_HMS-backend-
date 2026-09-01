// Neuropathy Studio — the clinical vocabulary and grading rules for the
// in-portal Vibrotherm Dx assessment (biothesiometry + thermal perception +
// 10 g monofilament).
//
// This file is the SINGLE SOURCE OF TRUTH for sites, modalities and grade
// bands. The backend grades server-side on `complete`; the frontend mirrors
// these values for live display only and never decides the stored grade.
//
// Thresholds are lifted verbatim from the clinic's Vibrotherm Dx configuration
// (its INTERPRETATION table) so a study graded here matches what the vendor
// software would have printed. Change them here, not in the controller.

const FEET = ['R', 'L'];

// Full plantar site set the device supports. The clinic's working protocol
// tests FOUR of these (PLANTAR_PROTOCOL_SITES) and omits MTH 3 + the instep —
// that is what 744/752 historical studies did. The other two remain valid so a
// study can include them if a clinician chooses.
const SITES = ['greatToe', 'mth1', 'mth3', 'mth5', 'midfoot', 'heel'];
const PLANTAR_PROTOCOL_SITES = ['greatToe', 'mth1', 'mth5', 'heel'];

const SITE_LABELS = {
  greatToe: 'Great toe',
  mth1:     'Metatarsal head 1',
  mth3:     'Metatarsal head 3',
  mth5:     'Metatarsal head 5',
  midfoot:  'Mid-foot (instep)',
  heel:     'Heel',
};

// VPT  — vibration perception threshold, volts (0–50), integer.
// HOT  — hot perception threshold, °C.   COLD — cold perception threshold, °C.
// MONO — 10 g monofilament: 1 = felt (protective sensation intact), 0 = not felt.
//        MONO is a separate physical test the clinician performs and ticks per
//        site; it does not come from the probe.
const MODALITIES = ['VPT', 'HOT', 'COLD', 'MONO'];

const GRADES = ['Normal', 'Mild', 'Moderate', 'Severe'];

// Band edges. Higher voltage / higher hot threshold / LOWER cold threshold all
// mean worse sensation, so COLD is inverted.
const THRESHOLDS = {
  VPT:  { normalMax: 15,   mildMax: 20,   moderateMax: 25 },   // ≥26 → Severe
  HOT:  { normalMax: 42.0, mildMax: 45.0, moderateMax: 48.0 }, // ≥48.1 → Severe
  COLD: { normalMin: 20.0, mildMin: 15.0, moderateMin: 10.0 }, // <10 → Severe
};

const PROTOCOLS = ['plantar'];
const STUDY_STATUSES = ['Draft', 'Completed', 'Cancelled'];

/** Grade a per-foot average for a numeric modality. Returns null for no data. */
const gradeValue = (modality, avg) => {
  if (avg === null || avg === undefined || Number.isNaN(Number(avg))) return null;
  const v = Number(avg);
  if (modality === 'VPT') {
    const t = THRESHOLDS.VPT;
    if (v <= t.normalMax) return 'Normal';
    if (v <= t.mildMax) return 'Mild';
    if (v <= t.moderateMax) return 'Moderate';
    return 'Severe';
  }
  if (modality === 'HOT') {
    const t = THRESHOLDS.HOT;
    if (v <= t.normalMax) return 'Normal';
    if (v <= t.mildMax) return 'Mild';
    if (v <= t.moderateMax) return 'Moderate';
    return 'Severe';
  }
  if (modality === 'COLD') {
    const t = THRESHOLDS.COLD;
    if (v >= t.normalMin) return 'Normal';
    if (v >= t.mildMin) return 'Mild';
    if (v >= t.moderateMin) return 'Moderate';
    return 'Severe';
  }
  return null;
};

/**
 * Per-foot average — the mean of the TESTED sites only (non-null, not omitted),
 * which is exactly how the vendor software computes it (verified against
 * 737/752 historical rows). VPT rounds to a whole volt; thermal to 0.1 °C.
 */
const averageReadings = (modality, values) => {
  const tested = values.filter((v) => v !== null && v !== undefined && !Number.isNaN(Number(v))).map(Number);
  if (!tested.length) return null;
  const mean = tested.reduce((a, b) => a + b, 0) / tested.length;
  return modality === 'VPT' ? Math.round(mean) : Math.round(mean * 10) / 10;
};

/** Monofilament per-foot summary: how many tested sites were insensate (0). */
const monoSummary = (values) => {
  const tested = values.filter((v) => v === 0 || v === 1 || v === '0' || v === '1').map(Number);
  return { tested: tested.length, insensate: tested.filter((v) => v === 0).length };
};

module.exports = {
  FEET,
  SITES,
  PLANTAR_PROTOCOL_SITES,
  SITE_LABELS,
  MODALITIES,
  GRADES,
  THRESHOLDS,
  PROTOCOLS,
  STUDY_STATUSES,
  gradeValue,
  averageReadings,
  monoSummary,
};
