/* =========================================================================
 * Thyroid Ultrasound — calculation engine  (backend, CommonJS)
 *
 * PURE FUNCTIONS ONLY. No I/O, no DB, no Date.now() in the scored logic.
 * This file is MIRRORED in the frontend as an ESM module: everything ABOVE
 * the `// ===== EXPORT MARKER =====` line must stay byte-identical between the
 * two copies (scripts/check-thyroid-engine-sync.js enforces it). The browser
 * copy drives the live chips; THIS copy computes what gets stored. The
 * narrative/conclusion generators live BELOW the marker and are server-only.
 *
 * Every rule layer is version-stamped so a future rule change never rewrites
 * an already-signed report:
 *   tiradsVersion     ACR-2017
 *   btaVersion        BTA-2014      (engine SUGGESTS, clinician CONFIRMS)
 *   follicularVersion CDC-FNSA-1
 *   narrativeVersion  CDC-NARR-1
 * ========================================================================= */

const VERSIONS = Object.freeze({
  tirads:     'ACR-2017',
  bta:        'BTA-2014',
  follicular: 'CDC-FNSA-1',
  narrative:  'CDC-NARR-1',
});

/* ---------- volume ---------- */
// Ellipsoid volume in mL from L×H×W in cm. Null unless all three are > 0.
function volume(L, H, W) {
  const l = Number(L), h = Number(H), w = Number(W);
  if (l > 0 && h > 0 && w > 0) return round1(l * h * w * 0.52);
  return null;
}
function round1(n) { return Math.round(n * 10) / 10; }
function round2(n) { return Math.round(n * 100) / 100; }

/* ---------- ACR TI-RADS (ACR 2017) ---------- */
// Points per category. `null` means "component not scoreable" → insufficient.
const TIRADS_POINTS = {
  composition: {
    cystic: 0, spongiform: 0,
    predominantly_cystic: 1, mixed_cystic_solid: 1,
    predominantly_solid: 2, solid: 2,
    other: null, not_assessed: null,
  },
  echogenicity: {
    anechoic: 0, isoechoic: 1, hyperechoic: 1,
    hypoechoic: 2, very_hypoechoic: 3,
    heterogeneous: null,   // reader must pick the predominant component
    not_assessed: null,
  },
  shape: { wider_than_tall: 0, taller_than_wide: 3, not_assessed: null },
  margins: {
    smooth: 0, ill_defined: 0,
    lobulated: 2, irregular: 2,
    extrathyroidal_extension: 3, not_assessed: null,
  },
  // Echogenic foci are ADDITIVE booleans, summed per ACR.
  foci: {
    fociMacrocalcification: 1,
    fociRim: 2,
    fociInterruptedRim: 2,
    fociPunctate: 3,
    fociCometTail: 0,
  },
};

// nodule: { composition, echogenicity, shape, margins,
//           fociStatus: 'none'|'present'|'not_assessed', fociPunctate, fociMacrocalcification,
//           fociRim, fociInterruptedRim, fociCometTail (booleans),
//           length, height, width }
function computeTirads(nodule = {}) {
  const parts = {};
  let insufficient = false;

  const score = (key, val) => {
    const map = TIRADS_POINTS[key];
    if (val == null || val === '' || !(val in map)) { insufficient = true; parts[key] = null; return 0; }
    const p = map[val];
    if (p === null) { insufficient = true; parts[key] = null; return 0; }
    parts[key] = p;
    return p;
  };

  let pts = 0;
  pts += score('composition', nodule.composition);
  pts += score('echogenicity', nodule.echogenicity);
  pts += score('shape', nodule.shape);
  pts += score('margins', nodule.margins);

  // Foci: not_assessed → insufficient; otherwise sum the additive booleans.
  let fociPts = 0;
  if (nodule.fociStatus === 'not_assessed' || nodule.fociStatus == null) {
    insufficient = true; parts.foci = null;
  } else {
    for (const k of Object.keys(TIRADS_POINTS.foci)) {
      if (nodule[k]) fociPts += TIRADS_POINTS.foci[k];
    }
    parts.foci = fociPts;
    pts += fociPts;
  }

  if (insufficient) {
    return {
      points: null, category: null, insufficient: true, breakdown: parts,
      meetsFnaThreshold: false, meetsFollowUpThreshold: false,
      version: VERSIONS.tirads,
    };
  }

  const category = tiradsCategory(pts);
  const maxDim = maxDimensionCm(nodule);
  return {
    points: pts,
    category,
    insufficient: false,
    breakdown: parts,
    meetsFnaThreshold: meetsFna(category, maxDim),
    meetsFollowUpThreshold: meetsFollowUp(category, maxDim),
    version: VERSIONS.tirads,
  };
}

function tiradsCategory(pts) {
  if (pts >= 7) return 'TR5';
  if (pts >= 4) return 'TR4';
  if (pts === 3) return 'TR3';
  if (pts === 2) return 'TR2';
  return 'TR1';               // 0 or 1 point
}
function maxDimensionCm(n) {
  const dims = [n.length, n.height, n.width].map(Number).filter((x) => x > 0);
  return dims.length ? Math.max(...dims) : null;
}
// ACR size thresholds (cm) — INFORMATIONAL ONLY; the plan stays clinician-selected.
function meetsFna(cat, cm) {
  if (cm == null) return false;
  if (cat === 'TR5') return cm >= 1.0;
  if (cat === 'TR4') return cm >= 1.5;
  if (cat === 'TR3') return cm >= 2.5;
  return false;
}
function meetsFollowUp(cat, cm) {
  if (cm == null) return false;
  if (cat === 'TR5') return cm >= 0.5;
  if (cat === 'TR4') return cm >= 1.0;
  if (cat === 'TR3') return cm >= 1.5;
  return false;
}

/* ---------- BTA U (2014) — SUGGESTION ONLY (engine proposes, clinician confirms) ----------
 * CONSERVATIVE first pass — flagged for clinical sign-off (btaVersion BTA-2014).
 * Returns { suggested: 'U1'..'U5'|null, rationale: string }.
 */
function suggestBtaU(nodule = {}) {
  const c = nodule.composition, e = nodule.echogenicity,
        s = nodule.shape, m = nodule.margins;

  // Need the core descriptors to suggest anything.
  if (!c || !e || !m) return { suggested: null, rationale: 'Composition, echogenicity or margins not assessed — no suggestion.' };

  const solid = (c === 'solid' || c === 'predominantly_solid');
  const cysticish = (c === 'cystic' || c === 'spongiform' || c === 'predominantly_cystic');
  const hypo = (e === 'hypoechoic' || e === 'very_hypoechoic');
  const suspiciousMargin = (m === 'lobulated' || m === 'irregular' || m === 'extrathyroidal_extension');
  const taller = (s === 'taller_than_wide');
  const punctate = !!nodule.fociPunctate;
  const macro = !!nodule.fociMacrocalcification;

  // U5 — solid hypo/very-hypo with a malignant feature
  if (solid && hypo && (suspiciousMargin || punctate || taller)) {
    return { suggested: 'U5', rationale: 'Solid hypoechoic nodule with a suspicious feature (margin, punctate foci or taller-than-wide).' };
  }
  // U4 — solid hypo/very-hypo, otherwise; or interrupted-rim on a hypoechoic nodule; or lobulated
  if ((solid && hypo) || (hypo && nodule.fociInterruptedRim) || suspiciousMargin) {
    return { suggested: 'U4', rationale: 'Solid hypoechoic nodule, interrupted-rim calcification, or lobulated/irregular margin without other malignant features.' };
  }
  // U2 — cystic/spongiform/predominantly cystic; or iso/hyper solid with halo and no suspicious feature; or eggshell rim
  if (cysticish || (solid && (e === 'isoechoic' || e === 'hyperechoic') && !suspiciousMargin && !punctate)) {
    return { suggested: 'U2', rationale: 'Cystic/spongiform, or iso/hyperechoic solid without a suspicious feature.' };
  }
  if (macro && !hypo) {
    return { suggested: 'U2', rationale: 'Peripheral/coarse calcification without hypoechogenicity.' };
  }
  // Default indeterminate
  return { suggested: 'U3', rationale: 'Indeterminate appearances — solid iso/hyperechoic without halo, or mixed with internal vascularity.' };
}

/* ---------- Follicular Neoplasm Sonographic Assessment (CDC-FNSA-1) ----------
 * PROPOSED rule set — flagged for clinical sign-off.
 * fa = the follicular assessment object; nodule descriptors also consulted.
 * Returns { concern:'low'|'intermediate'|'high'|'incomplete', features:[], version }.
 */
function follicularConcern(fa = {}, nodule = {}) {
  // Incomplete unless the three anchor observations are recorded.
  if (!fa.echotexture || !fa.halo || !fa.capsularInterface) {
    return { concern: 'incomplete', features: [], version: VERSIONS.follicular };
  }

  const higher = [];
  const intermediate = [];

  // ----- higher-concern features -----
  if (nodule.margins === 'irregular' || nodule.margins === 'lobulated') higher.push('irregular/lobulated margin');
  if (fa.capsule === 'interrupted' || fa.capsularInterface === 'focally_interrupted' || fa.capsularInterface === 'suspicious_extracapsular_extension')
    higher.push('capsular interruption / suspected extracapsular extension');
  if (fa.halo === 'interrupted' || fa.halo === 'nodular_irregular') higher.push('interrupted / nodular-irregular halo');
  if (Array.isArray(fa.invasiveFeatures) && fa.invasiveFeatures.some((f) => f && f !== 'none_identified' && f !== 'indeterminate'))
    higher.push('sonographic feature of invasion');
  if (fa.satelliteNodule === 'present') higher.push('satellite nodule');
  if (fa.capsularVascularity === 'abnormal_vessels_crossing_capsule') higher.push('abnormal vessels crossing the capsule');

  // ----- intermediate-concern features -----
  if (['mildly_heterogeneous', 'markedly_heterogeneous', 'nodule_in_nodule'].includes(fa.echotexture)) intermediate.push('heterogeneous echotexture');
  if (nodule.echogenicity === 'hypoechoic' || nodule.echogenicity === 'very_hypoechoic') intermediate.push('hypoechoic');
  if (fa.vascularDistribution === 'predominantly_internal' || nodule.vascularity === 'internal' || nodule.vascularity === 'marked') intermediate.push('predominantly internal / marked vascularity');
  if (fa.halo === 'thick_complete' || fa.halo === 'thick_irregular') intermediate.push('thick halo');
  if (nodule.fociRim || nodule.fociInterruptedRim || nodule.fociMacrocalcification) intermediate.push('rim / peripheral macrocalcification');
  if (fa.capsularInterface === 'focally_irregular') intermediate.push('focally irregular capsular interface');
  if (fa.tubercleInNodule === 'present') intermediate.push('tubercle-in-nodule');
  if (Array.isArray(fa.invasiveFeatures) && fa.invasiveFeatures.includes('indeterminate')) intermediate.push('indeterminate invasive feature');

  let concern;
  if (higher.length > 0 || intermediate.length >= 3) concern = 'high';
  else if (intermediate.length >= 1) concern = 'intermediate';
  else concern = 'low';

  return { concern, features: [...higher, ...intermediate], version: VERSIONS.follicular };
}

/* ---------- Ablation planning figures ---------- */
// Cystic component volume, solid volume, %s and ratio. No recommendation.
function ablationFigures(nodule = {}) {
  const total = volume(nodule.length, nodule.height, nodule.width);
  let cysticVol = volume(nodule.cysticLength, nodule.cysticHeight, nodule.cysticWidth);

  // Fallback: a % estimate of the whole nodule.
  if (cysticVol == null && nodule.cysticPercentEstimate != null && total != null) {
    cysticVol = round2(total * (Number(nodule.cysticPercentEstimate) / 100));
  }
  if (total == null) return { total: null, cysticVolume: cysticVol, solidVolume: null, solidPercent: null, cysticPercent: null, ratio: null };

  const cv = cysticVol == null ? null : Math.min(cysticVol, total);
  const solid = cv == null ? null : round2(total - cv);
  return {
    total,
    cysticVolume: cv,
    solidVolume: solid,
    solidPercent: cv == null ? null : round1((solid / total) * 100),
    cysticPercent: cv == null ? null : round1((cv / total) * 100),
    ratio: (solid && cv) ? round2(cv / solid) : null,
  };
}

// Ablation safety gate (forced acknowledgement) — CDC-FNSA-1 §safety.
// Fires when a nodule has follicular concern intermediate/high AND previous
// cytology Bethesda III/IV AND an ablation modality is chosen in the plan.
function ablationGateRequired(nodule = {}, follicular = {}, plan = []) {
  const concern = follicular.concern;
  const bethesda34 = (nodule.previousCytology === 'bethesda_3' || nodule.previousCytology === 'bethesda_4');
  const ablationPlanned = Array.isArray(plan) && plan.some((p) => /rfa|pea|ablation/i.test(String(p)));
  return (concern === 'intermediate' || concern === 'high') && bethesda34 && ablationPlanned;
}

/* ---------- Validation ---------- */
// report: the report-level object; nodules: array of nodule objects (each already
// carrying its computed tirads/bta). Returns { errors:[], warnings:[] }.
function validateReport(report = {}, nodules = []) {
  const errors = [];
  const warnings = [];

  if (!report.indications || (Array.isArray(report.indications) && report.indications.length === 0 && !report.indicationOther))
    errors.push('At least one indication is required.');
  if (!report.examDate) errors.push('Exam date is required.');

  const hasNodules = Array.isArray(nodules) && nodules.length > 0;
  if (hasNodules && report.noNodules) errors.push('Nodules are entered but "no nodules" is also selected.');
  if (!hasNodules && !report.noNodules) errors.push('Nodules not addressed — add a nodule or tick "no discrete nodules".');

  if (!report.lymphNodeAssessment) errors.push('Cervical lymph node status is required.');
  if (!report.conclusion || (Array.isArray(report.conclusion) && report.conclusion.length === 0)) errors.push('Conclusion is empty.');
  if (!report.plan || (Array.isArray(report.plan) && report.plan.length === 0 && !report.planOther)) errors.push('Plan is empty.');

  // Lobe measurement plausibility (warnings)
  for (const side of ['right', 'left']) {
    for (const ax of ['Length', 'Height', 'Width']) {
      const v = Number(report[side + ax]);
      if (v > 8) warnings.push(`${cap(side)} lobe ${ax.toLowerCase()} > 8 cm — check.`);
      if (v > 0 && v < 0.5) warnings.push(`${cap(side)} lobe ${ax.toLowerCase()} < 0.5 cm — check.`);
    }
    const L = Number(report[side + 'Length']), H = Number(report[side + 'Height']);
    if (L > 0 && H > 0 && H > L) warnings.push(`${cap(side)} lobe height > length — likely axis swap.`);
  }

  nodules.forEach((n, i) => {
    const num = n.noduleNumber || i + 1;
    const hasDims = volume(n.length, n.height, n.width) != null;
    if (!hasDims && !n.dimensionsUnavailable) errors.push(`Nodule ${num}: dimensions missing (or tick "dimensions unavailable").`);
    if (!n.btaCategory) errors.push(`Nodule ${num}: BTA U category not confirmed.`);
    const maxDim = maxDimensionCm(n);
    if (maxDim && maxDim > 8) warnings.push(`Nodule ${num}: dimension > 8 cm — check.`);
    const t = computeTirads(n);
    if (!t.insufficient && (t.category === 'TR1' || t.category === 'TR2') && maxDim && maxDim >= 4)
      warnings.push(`Nodule ${num}: ≥ 4 cm but ${t.category} — worth a second look.`);
    if (n.fociPunctate && (n.composition === 'cystic' || n.composition === 'predominantly_cystic'))
      warnings.push(`Nodule ${num}: punctate foci in a cystic nodule — confirm.`);
  });

  return { errors, warnings };
}

function cap(s) { return String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1); }

/* ---------- vocab export (models are built from this so they can't drift) ---------- */
const VOCAB = Object.freeze({
  composition: Object.keys(TIRADS_POINTS.composition),
  echogenicity: Object.keys(TIRADS_POINTS.echogenicity),
  shape: Object.keys(TIRADS_POINTS.shape),
  margins: Object.keys(TIRADS_POINTS.margins),
  tiradsCategories: ['TR1', 'TR2', 'TR3', 'TR4', 'TR5'],
  btaCategories: ['U1', 'U2', 'U3', 'U4', 'U5'],
  follicularConcern: ['low', 'intermediate', 'high', 'incomplete'],
});

// ===== EXPORT MARKER =====  (everything BELOW is server-only, not mirrored)

/* ---------- narrative + conclusion generators (server-only) ---------- */
function generateNarrative(report = {}, nodules = []) {
  const s = [];
  // Gland paragraph
  const gland = [];
  gland.push(`The thyroid gland is ${sizeWord(report.glandSize)} in size`);
  if (report.echotexture) gland.push(`with ${report.echotexture.replace(/_/g, ' ')} echotexture`);
  if (report.vascularity && report.vascularity !== 'not_assessed') gland.push(`and ${report.vascularity.replace(/_/g, ' ')} vascularity`);
  s.push(gland.join(' ') + '.');

  // Measurements
  const r = volume(report.rightLength, report.rightHeight, report.rightWidth);
  const l = volume(report.leftLength, report.leftHeight, report.leftWidth);
  const meas = [];
  if (r != null) meas.push(`right lobe ${dimStr(report.rightLength, report.rightHeight, report.rightWidth)} cm (${r} mL)`);
  if (l != null) meas.push(`left lobe ${dimStr(report.leftLength, report.leftHeight, report.leftWidth)} cm (${l} mL)`);
  if (report.isthmusThickness) meas.push(`isthmus ${report.isthmusThickness} cm`);
  if (meas.length) s.push('Measurements: ' + meas.join(', ') + '.');

  // Nodules
  if (report.noNodules) s.push('No discrete thyroid nodules are identified.');
  else nodules.forEach((n) => {
    const t = computeTirads(n);
    s.push(`Nodule ${n.noduleNumber}: ${n.lobe || ''} ${n.pole || ''} nodule`.replace(/\s+/g, ' ').trim()
      + `${volume(n.length, n.height, n.width) ? ', ' + dimStr(n.length, n.height, n.width) + ' cm' : ''}`
      + `${t.insufficient ? ' (insufficient information for complete ACR TI-RADS)' : `, ${t.category}${n.btaCategory ? ' / ' + n.btaCategory : ''}`}.`);
  });

  // Nodes
  if (report.lymphNodeAssessment === 'normal') s.push('No suspicious cervical lymphadenopathy.');
  else if (report.lymphNodeAssessment === 'suspicious') s.push('Suspicious cervical lymph node(s) — see above.');
  else if (report.lymphNodeAssessment === 'not_assessed') s.push('Cervical lymph nodes were not assessed.');

  return s.join('\n');
}

function generateConclusion(report = {}, nodules = []) {
  const bullets = [];
  if (report.glandSize && report.glandSize !== 'normal' && report.glandSize !== 'not_assessed')
    bullets.push(`${cap(sizeWord(report.glandSize))} thyroid gland.`);

  if (report.noNodules) {
    bullets.push('No discrete thyroid nodules identified.');
  } else if (nodules.length) {
    // dominant first: highest TR points, then largest volume
    const ranked = [...nodules].sort((a, b) => {
      const pa = computeTirads(a).points || 0, pb = computeTirads(b).points || 0;
      if (pb !== pa) return pb - pa;
      return (volume(b.length, b.height, b.width) || 0) - (volume(a.length, a.height, a.width) || 0);
    });
    ranked.forEach((n, i) => {
      const t = computeTirads(n);
      const lead = i === 0 ? 'Dominant nodule' : `Nodule ${n.noduleNumber}`;
      bullets.push(`${lead} (${n.lobe || 'thyroid'}): ${t.insufficient ? 'incomplete TI-RADS' : t.category}${n.btaCategory ? ' / ' + n.btaCategory : ''}.`);
    });
  }

  if (report.lymphNodeAssessment === 'normal') bullets.push('No suspicious cervical lymphadenopathy.');
  if (report.lymphNodeAssessment === 'suspicious') bullets.push('Suspicious cervical lymph node(s).');

  return bullets;
}

function sizeWord(g) {
  return ({ normal: 'normal', enlarged: 'enlarged', small: 'small', not_assessed: 'not assessed for' }[g]) || 'normal';
}
function dimStr(L, H, W) { return `${num(L)} × ${num(H)} × ${num(W)}`; }
function num(x) { const n = Number(x); return Number.isFinite(n) ? n : '—'; }

module.exports = {
  VERSIONS, VOCAB,
  volume, computeTirads, tiradsCategory,
  suggestBtaU, follicularConcern,
  ablationFigures, ablationGateRequired,
  validateReport,
  generateNarrative, generateConclusion,
};
