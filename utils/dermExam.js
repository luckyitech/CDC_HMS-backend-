// =====================================================================
// Dermatology — the structured skin examination (9 Oct 2026, Emu).
// Pure: no database, unit-tested in tests/dermExam.test.js.
//
// Two levels (decision S1):
//   LOOK_SECTIONS   recorded per FINDING per clinic day, on DermObservations:
//                   primary lesion(s), morphology, secondary changes,
//                   quantification, dermoscopy (if performed).
//   EXAM_SECTIONS   recorded per PATIENT per clinic day, on DermSkinExams
//                   ("Today's whole-skin exam"): hair, nails, lymph nodes,
//                   mucosa. Each part is "not examined" until switched on.
// Photography is never typed: it is written from the day's photos (S10).
//
// Every choice field takes "Other…" (Emu, 9 Oct) — except Status today and
// Measured by, which drive the trend and size comparison. A typed word is
// stored in the SAME column as the fixed words, so a report reads one place:
// a fixed word is a lowercase token ("well_defined"); anything else is the
// doctor's own term ("Koebnerised"). Typed words are offered again later
// (GET /api/derm/vocabulary → terms).
//
// Blank = not recorded; "none" / "absent" / "normal" are explicit choices (S6).
// Multi-choice fields are comma lists in a VARCHAR (same answer on MariaDB and
// MySQL 8, searchable with LIKE), never JSON.
//
// The frontend mirrors this file in cdc-hms/src/components/doctor/derm/dermExam.js.
// =====================================================================

const o = (...pairs) => pairs;   // readability: [[token, label], …]

// kind: one | many (choices, Other allowed) · int · mm · pct · text · flag
const LOOK_SECTIONS = [
  {
    id: 'primary', title: 'Primary lesion(s)', fields: [
      { key: 'distribution', label: 'Distribution', kind: 'one', options: o(['localized', 'Localized'], ['regional', 'Regional'], ['generalized', 'Generalized']) },
      { key: 'symmetry', label: 'Symmetry', kind: 'one', options: o(['symmetric', 'Symmetric'], ['asymmetric', 'Asymmetric']) },
      { key: 'pattern', label: 'Pattern', kind: 'many', options: o(['dermatomal', 'Dermatomal'], ['follicular', 'Follicular'], ['acral', 'Acral'],
        ['photo_exposed', 'Photo-exposed'], ['intertriginous', 'Intertriginous'], ['flexural', 'Flexural'], ['extensor', 'Extensor'],
        ['seborrhoeic', 'Seborrhoeic'], ['blaschkoid', 'Blaschkoid'], ['koebner', 'Koebner']) },
      { key: 'configuration', label: 'Configuration', kind: 'many', options: o(['discrete', 'Discrete'], ['grouped', 'Grouped'], ['linear', 'Linear'],
        ['annular', 'Annular'], ['arcuate', 'Arcuate'], ['reticular', 'Reticular'], ['targetoid', 'Targetoid'], ['serpiginous', 'Serpiginous']) },
    ],
  },
  {
    id: 'morphology', title: 'Morphology', fields: [
      { key: 'morphology', label: 'Type', kind: 'many', options: o(['macule', 'Macule'], ['patch', 'Patch'], ['papule', 'Papule'], ['plaque', 'Plaque'],
        ['nodule', 'Nodule'], ['tumour', 'Tumor'], ['vesicle', 'Vesicle'], ['bulla', 'Bulla'], ['pustule', 'Pustule'], ['cyst', 'Cyst'],
        ['wheal', 'Wheal'], ['comedone', 'Comedone']) },
      // Size (L × W × D, measured by, range) is handled by dermRules — listed here for the note only.
      { key: 'shape', label: 'Shape', kind: 'one', options: o(['round', 'Round'], ['oval', 'Oval'], ['irregular', 'Irregular'], ['polygonal', 'Polygonal']) },
      { key: 'border', label: 'Border', kind: 'many', options: o(['well_defined', 'Well-defined'], ['ill_defined', 'Ill-defined'], ['raised', 'Raised'], ['flat', 'Flat']) },
      { key: 'colours', label: 'Colour', kind: 'many', options: o(['erythematous', 'Erythematous'], ['hyperpigmented', 'Hyperpigmented'],
        ['hypopigmented', 'Hypopigmented'], ['violaceous', 'Violaceous'], ['brown', 'Brown'], ['black', 'Black'], ['blue_grey', 'Blue-grey'],
        ['skin_coloured', 'Flesh-coloured'], ['yellow', 'Yellow'], ['variegated', 'Variegated']) },
      { key: 'surface', label: 'Surface', kind: 'many', options: o(['smooth', 'Smooth'], ['rough', 'Rough'], ['verrucous', 'Verrucous'], ['scaly', 'Scaly'],
        ['crusted', 'Crusted'], ['ulcerated', 'Ulcerated'], ['excoriated', 'Excoriated']) },
      { key: 'texture', label: 'Texture', kind: 'one', options: o(['soft', 'Soft'], ['firm', 'Firm'], ['hard', 'Hard'], ['fluctuant', 'Fluctuant']) },
    ],
  },
  {
    id: 'secondary', title: 'Secondary changes', fields: [
      { key: 'scale', label: 'Scale', kind: 'one', options: o(['none', 'None'], ['fine', 'Fine'], ['thick', 'Thick'], ['silvery', 'Silvery'], ['greasy', 'Greasy'], ['adherent', 'Adherent']) },
      { key: 'crust', label: 'Crust', kind: 'one', options: o(['none', 'None'], ['serous', 'Serous'], ['haemorrhagic', 'Haemorrhagic'], ['honey', 'Honey-coloured']) },
      { key: 'erosion', label: 'Erosion', kind: 'one', options: o(['none', 'None'], ['present', 'Present']) },
      { key: 'ulceration', label: 'Ulceration', kind: 'one', options: o(['none', 'None'], ['present', 'Present']) },
      { key: 'ulcerBase', label: 'Ulcer base', kind: 'one', options: o(['clean', 'Clean'], ['necrotic', 'Necrotic'], ['granulating', 'Granulating'], ['sloughy', 'Sloughy']) },
      { key: 'excoriation', label: 'Excoriation', kind: 'one', options: o(['none', 'None'], ['present', 'Present']) },
      { key: 'lichenification', label: 'Lichenification', kind: 'one', options: o(['none', 'None'], ['present', 'Present']) },
      { key: 'atrophy', label: 'Atrophy', kind: 'one', options: o(['none', 'None'], ['epidermal', 'Epidermal'], ['dermal', 'Dermal']) },
      { key: 'scarring', label: 'Scarring', kind: 'one', options: o(['none', 'None'], ['atrophic', 'Atrophic'], ['hypertrophic', 'Hypertrophic'], ['keloid', 'Keloid'], ['cribriform', 'Cribriform']) },
    ],
  },
  {
    id: 'quantification', title: 'Quantification', fields: [
      { key: 'lesionCount', label: 'Number of lesions', kind: 'int', max: 9999 },
      { key: 'lesionCountKind', label: 'Number of lesions', kind: 'one', options: o(['innumerable', 'Innumerable'], ['confluent', 'Confluent']) },
      { key: 'bsaPercent', label: 'Percent BSA involved', kind: 'pct' },
    ],
  },
  {
    id: 'dermoscopy', title: 'Dermoscopy', switch: 'dermoscopy', fields: [
      { key: 'dsGlobal', label: 'Global pattern', kind: 'one', options: o(['reticular', 'Reticular'], ['globular', 'Globular'], ['homogeneous', 'Homogeneous'],
        ['starburst', 'Starburst'], ['multicomponent', 'Multicomponent'], ['nonspecific', 'Nonspecific']) },
      { key: 'dsNetwork', label: 'Pigment network', kind: 'one', options: o(['none', 'None'], ['regular', 'Regular'], ['irregular', 'Irregular'], ['atypical', 'Atypical']) },
      { key: 'dsDots', label: 'Dots / globules', kind: 'one', options: o(['none', 'None'], ['regular', 'Regular'], ['irregular', 'Irregular']) },
      { key: 'dsStreaks', label: 'Streaks', kind: 'one', options: o(['none', 'None'], ['regular', 'Regular'], ['irregular', 'Irregular'], ['pseudopods', 'Pseudopods']) },
      { key: 'dsBlueWhite', label: 'Blue-white structures', kind: 'one', options: o(['none', 'None'], ['present', 'Present']) },
      { key: 'dsVascular', label: 'Vascular pattern', kind: 'many', options: o(['comma', 'Comma vessels'], ['hairpin', 'Hairpin vessels'], ['dotted', 'Dotted vessels'],
        ['arborizing', 'Arborizing vessels'], ['glomerular', 'Glomerular vessels'], ['polymorphous', 'Polymorphous']) },
      { key: 'dsRegression', label: 'Regression structures', kind: 'one', options: o(['none', 'None'], ['peppering', 'Peppering'], ['scar_like', 'Scar-like']) },
      { key: 'dsOther', label: 'Other features', kind: 'many', options: o(['milia_like_cysts', 'Milia-like cysts'], ['comedo_like_openings', 'Comedo-like openings'],
        ['leaf_like', 'Leaf-like structures'], ['spoke_wheel', 'Spoke-wheel'], ['blue_grey_ovoid_nests', 'Blue-grey ovoid nests']) },
    ],
  },
  {
    id: 'plan', title: 'Symptoms & plan', fields: [
      { key: 'symptoms', label: 'Symptoms', kind: 'many', options: o(['itch', 'Itch'], ['pain', 'Pain'], ['bleeding', 'Bleeding'], ['none', 'None']) },
      { key: 'plan', label: 'Plan', kind: 'one', options: o(['monitor', 'Monitor'], ['treat', 'Treat'], ['biopsy', 'Biopsy'], ['excise', 'Excise'], ['refer', 'Refer'], ['discharge', 'Discharge']) },
    ],
  },
];

const NAILS = ['all'];
for (const side of ['l', 'r']) for (const limb of ['f', 't']) for (let n = 1; n <= 5; n += 1) NAILS.push(`${side}${limb}${n}`);
const nailLabel = (t) => {
  if (t === 'all') return 'All nails';
  const m = /^([lr])([ft])([1-5])$/.exec(t);
  if (!m) return t;
  const digit = m[2] === 'f' ? ['thumb', 'index', 'middle', 'ring', 'little'][Number(m[3]) - 1] : ['great toe', '2nd toe', '3rd toe', '4th toe', '5th toe'][Number(m[3]) - 1];
  return `${m[1] === 'l' ? 'left' : 'right'} ${digit}`;
};

const EXAM_SECTIONS = [
  {
    id: 'hair', title: 'Hair', switch: 'hairExamined', fields: [
      { key: 'scalp', label: 'Scalp', kind: 'text', max: 500 },
      { key: 'hairDensity', label: 'Hair density', kind: 'one', options: o(['normal', 'Normal'], ['decreased', 'Decreased']) },
      { key: 'hairDensityPattern', label: 'Pattern', kind: 'many', options: o(['diffuse', 'Diffuse'], ['patchy', 'Patchy'], ['androgenetic', 'Androgenetic'], ['frontotemporal', 'Frontal / temporal']) },
      { key: 'hairCalibre', label: 'Hair calibre', kind: 'one', options: o(['normal', 'Normal'], ['fine', 'Fine'], ['varied', 'Varied']) },
      { key: 'pullTest', label: 'Pull test', kind: 'one', options: o(['negative', 'Negative'], ['positive', 'Positive']) },
      { key: 'pullTestSite', label: 'Pull test location', kind: 'text', max: 100 },
      { key: 'pullTestCount', label: 'Hairs pulled', kind: 'int', max: 999 },
      { key: 'exclamationHairs', label: 'Exclamation-point hairs', kind: 'one', options: o(['absent', 'Absent'], ['present', 'Present']) },
      { key: 'brokenHairs', label: 'Broken hairs', kind: 'one', options: o(['absent', 'Absent'], ['present', 'Present']) },
    ],
  },
  {
    id: 'nails', title: 'Nails', switch: 'nailsExamined', fields: [
      { key: 'nailsAffected', label: 'Nails affected', kind: 'many', options: NAILS.map((t) => [t, nailLabel(t)]) },
      { key: 'nailPlate', label: 'Nail plate', kind: 'many', options: o(['normal', 'Normal'], ['pitting', 'Pitting'], ['ridging', 'Ridging'], ['dystrophy', 'Dystrophy'],
        ['discolouration', 'Discolouration'], ['thickening', 'Thickening']) },
      { key: 'nailBed', label: 'Nail bed', kind: 'many', options: o(['normal', 'Normal'], ['onycholysis', 'Onycholysis'], ['oil_spots', 'Oil spots'],
        ['subungual_debris', 'Subungual debris'], ['splinter_haemorrhages', 'Splinter haemorrhages']) },
      { key: 'periungual', label: 'Periungual', kind: 'many', options: o(['normal', 'Normal'], ['paronychia', 'Paronychia'], ['pterygium', 'Pterygium']) },
    ],
  },
  {
    id: 'nodes', title: 'Lymph nodes', switch: 'nodesExamined', fields: [
      { key: 'lymphadenopathy', label: 'Regional lymphadenopathy', kind: 'one', options: o(['absent', 'Absent'], ['present', 'Present']) },
      { key: 'nodesNote', label: 'Location and characteristics', kind: 'text', max: 500 },
    ],
  },
  {
    id: 'mucosa', title: 'Mucosa', switch: 'mucosaExamined', fields: [
      { key: 'oral', label: 'Oral', kind: 'one', options: o(['normal', 'Normal'], ['findings', 'Findings']) },
      { key: 'oralNote', label: 'Oral findings', kind: 'text', max: 500 },
      { key: 'genital', label: 'Genital', kind: 'one', options: o(['normal', 'Normal'], ['findings', 'Findings'], ['declined', 'Declined']) },
      { key: 'genitalNote', label: 'Genital findings', kind: 'text', max: 500 },
    ],
  },
];

const fieldsOf = (sections) => sections.flatMap((s) => s.fields);
const LOOK_FIELDS = fieldsOf(LOOK_SECTIONS);
const EXAM_FIELDS = fieldsOf(EXAM_SECTIONS);
const EXAM_SWITCHES = EXAM_SECTIONS.map((s) => s.switch);
/** Every field that takes a typed "Other" word, by key → its token list. */
const CHOICE_FIELDS = Object.fromEntries([...LOOK_FIELDS, ...EXAM_FIELDS]
  .filter((f) => f.kind === 'one' || f.kind === 'many').map((f) => [f.key, f.options.map(([t]) => t)]));

// Words from earlier versions of the form that a saved look may still hold.
const LEGACY_LABELS = { regular: 'Regular', irregular: 'Irregular', bleeding: 'Bleeding', erosion: 'Erosion', ulcer: 'Ulcer', other: 'Other' };

const MAX_TERM = 40;
const COLUMN_MAX = { one: 60, many: 300 };

/**
 * A typed "Other" word: trimmed, single-spaced, ≤ 40 characters, at least one
 * letter, no comma (commas separate list items). Returns null for empty,
 * undefined when unusable.
 */
const cleanTerm = (v) => {
  if (v === undefined || v === null) return null;
  const t = String(v).replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (t.length > MAX_TERM || t.includes(',') || !/\p{L}/u.test(t)) return undefined;
  return t;
};

/** Match a typed word to a fixed one by its label or token, case-insensitively. */
const tokenFor = (field, word) => {
  const w = word.toLowerCase();
  const spec = [...LOOK_FIELDS, ...EXAM_FIELDS].find((f) => f.key === field);
  const hit = (spec?.options || []).find(([t, l]) => t === w || l.toLowerCase() === w || t.replace(/_/g, ' ') === w);
  return hit ? hit[0] : null;
};

const fail = (message, field) => ({ ok: false, message, field });

/** One choice value (fixed word or typed term). */
const cleanOne = (field, v) => {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') return undefined;
  if (CHOICE_FIELDS[field].includes(v) || LEGACY_LABELS[v]) return v;
  const term = cleanTerm(v);
  if (!term) return term;               // null or undefined
  return tokenFor(field, term) || term;
};

/** A multi-choice value → comma list (or null). */
const cleanMany = (field, v) => {
  if (v === undefined || v === null || v === '') return null;
  const arr = Array.isArray(v) ? v : String(v).split(',');
  const out = [];
  for (const x of arr) {
    const c = cleanOne(field, typeof x === 'string' ? x : String(x));
    if (c === undefined) return undefined;
    if (c && !out.some((y) => y.toLowerCase() === c.toLowerCase())) out.push(c);
  }
  if (!out.length) return null;
  const joined = out.join(',');
  return joined.length > COLUMN_MAX.many ? undefined : joined;
};

const cleanNumber = (v, { min, max, integer }) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) return undefined;
  if (integer && !Number.isInteger(n)) return undefined;
  return integer ? n : Math.round(n * 10) / 10;
};

const cleanFieldValue = (f, v) => {
  switch (f.kind) {
    case 'one': return cleanOne(f.key, v);
    case 'many': return cleanMany(f.key, v);
    case 'int': return cleanNumber(v, { min: 1, max: f.max || 9999, integer: true });
    case 'pct': return cleanNumber(v, { min: 0.1, max: 100 });
    case 'text': {
      if (v === undefined || v === null) return null;
      if (typeof v !== 'string') return undefined;
      const t = v.trim();
      if (!t) return null;
      return t.length > (f.max || 500) ? undefined : t;
    }
    default: return undefined;
  }
};

const problem = (f) => {
  if (f.kind === 'one' || f.kind === 'many') return `${f.label}: choose from the list or type a word under Other (up to ${MAX_TERM} characters, no commas)`;
  if (f.kind === 'int') return `${f.label} must be a whole number from 1 to ${f.max || 9999}`;
  if (f.kind === 'pct') return `${f.label} must be a percentage from 0.1 to 100`;
  return `${f.label} is too long (up to ${f.max || 500} characters)`;
};

const flag = (v) => v === true || v === 'true' || v === 1 || v === '1';

/**
 * The structured part of one day's look (everything above except symptoms and
 * plan, which dermRules already owns). Returns { ok, value } with every key
 * present (null when blank) — a save writes the whole look.
 */
const cleanLookExam = (body = {}) => {
  const out = {};
  for (const f of LOOK_FIELDS) {
    if (f.key === 'symptoms' || f.key === 'plan' || f.key === 'morphology' || f.key === 'colours') continue;
    const v = cleanFieldValue(f, body[f.key]);
    if (v === undefined) return fail(problem(f), f.key);
    out[f.key] = v;
  }
  // An ulcer base only means something when ulceration is present.
  if (!out.ulceration || out.ulceration === 'none') out.ulcerBase = null;
  // "Number of lesions": a count OR innumerable / confluent, not both.
  if (out.lesionCountKind) out.lesionCount = null;
  // Dermoscopy: nothing recorded unless performed.
  out.dermoscopy = flag(body.dermoscopy);
  if (!out.dermoscopy) {
    for (const f of LOOK_SECTIONS.find((s) => s.id === 'dermoscopy').fields) out[f.key] = null;
  }
  return { ok: true, value: out };
};

/** Today's whole-skin exam. A part not examined keeps none of its fields. */
const cleanSkinExam = (body = {}) => {
  const out = {};
  for (const s of EXAM_SECTIONS) {
    const on = flag(body[s.switch]);
    out[s.switch] = on;
    for (const f of s.fields) {
      if (!on) { out[f.key] = null; continue; }
      const v = cleanFieldValue(f, body[f.key]);
      if (v === undefined) return fail(problem(f), f.key);
      out[f.key] = v;
    }
  }
  if (out.pullTest !== 'positive') { out.pullTestSite = null; out.pullTestCount = null; }
  if (out.hairDensity !== 'decreased') out.hairDensityPattern = null;
  if (out.oral !== 'findings') out.oralNote = null;
  if (out.genital !== 'findings') out.genitalNote = null;
  if (out.lymphadenopathy !== 'present') out.nodesNote = null;
  const notes = cleanFieldValue({ kind: 'text', max: 1000 }, body.notes);
  if (notes === undefined) return fail('Notes are too long (up to 1000 characters)', 'notes');
  out.notes = notes;
  if (!EXAM_SWITCHES.some((k) => out[k]) && !out.notes) return fail('Switch on at least one part you examined', 'hairExamined');
  return { ok: true, value: out };
};

const SKIN_EXAM_KEYS = [...EXAM_SWITCHES, ...EXAM_FIELDS.map((f) => f.key), 'notes'];
const LOOK_EXAM_KEYS = ['dermoscopy', ...LOOK_FIELDS.map((f) => f.key)
  .filter((k) => !['symptoms', 'plan', 'morphology', 'colours'].includes(k))];

/** A comma list back into an array. */
const listOf = (v) => (Array.isArray(v) ? v : (v ? String(v).split(',').filter(Boolean) : []));

const specOf = (key) => [...LOOK_FIELDS, ...EXAM_FIELDS].find((f) => f.key === key);
/** The label a doctor reads for a stored value — fixed word, legacy word, or their own typed term. */
const labelOf = (key, value) => {
  const hit = (specOf(key)?.options || []).find(([t]) => t === value);
  if (hit) return hit[1];
  return LEGACY_LABELS[value] || value;
};
const lower = (s) => (s && !/^[A-Z]{2,}/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);
const isFixed = (key, value) => (specOf(key)?.options || []).some(([t]) => t === value) || !!LEGACY_LABELS[value];
/** Fixed words read in lower case inside a sentence; a doctor's typed word stays exactly as typed. */
const phrase = (key, v) => listOf(v).map((x) => (isFixed(key, x) ? lower(labelOf(key, x)) : x)).join(', ');

/**
 * Typed words in stored values (not one of the fixed words) — what the
 * vocabulary offers back. rows: plain objects with any of the choice keys.
 * Returns { field: [{ name, uses }] } most used first.
 */
const typedTerms = (rows) => {
  const counts = {};
  for (const r of rows) {
    for (const [key, tokens] of Object.entries(CHOICE_FIELDS)) {
      for (const v of listOf(r[key])) {
        if (tokens.includes(v) || LEGACY_LABELS[v]) continue;
        counts[key] = counts[key] || new Map();
        const k = v.toLowerCase();
        const cur = counts[key].get(k);
        counts[key].set(k, { name: cur ? cur.name : v, uses: (cur ? cur.uses : 0) + 1 });
      }
    }
  }
  const out = {};
  for (const [key, m] of Object.entries(counts)) {
    out[key] = [...m.values()].sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name)).slice(0, 30);
  }
  return out;
};

// ---------------------------------------------------------------------
// Reading it back — the headings Emu gave (9 Oct). Each returns lines of
// plain text; a blank section returns nothing (S13).
// ---------------------------------------------------------------------
/** Recorded at all? An empty list or blank reads as not recorded. */
const has = (v) => (Array.isArray(v) ? v.length > 0 : v !== null && v !== undefined && v !== '' && v !== false);
const trim = (n) => { const x = Number(n); return Number.isInteger(x) ? String(x) : String(Math.round(x * 10) / 10); };
const join = (bits) => bits.filter(Boolean).join('; ');

/**
 * The look's examination, as headed lines:
 *   [{ heading: 'Primary lesion(s)', text: '…' }, …]
 * `where` = the finding's areas (Location); `size` = "22 × 18 mm (ruler)".
 */
const lookSections = (look, { where = '', size = '' } = {}) => {
  const L = look || {};
  const out = [];
  const primary = join([
    where && `location ${where}`,
    [phrase('distribution', L.distribution), phrase('symmetry', L.symmetry)].filter(Boolean).join(', ') && `distribution ${[phrase('distribution', L.distribution), phrase('symmetry', L.symmetry)].filter(Boolean).join(', ')}`,
    has(L.pattern) && `pattern ${phrase('pattern', L.pattern)}`,
    has(L.configuration) && `configuration ${phrase('configuration', L.configuration)}`,
  ]);
  if (primary) out.push({ heading: 'Primary lesion(s)', text: primary });

  const range = (L.sizeMinMm || L.sizeMaxMm) ? `range ${[L.sizeMinMm, L.sizeMaxMm].filter((x) => x !== null && x !== undefined && x !== '').map(trim).join('–')} mm` : '';
  const morph = join([
    has(L.morphology) && listOf(L.morphology).length && `type ${phrase('morphology', L.morphology)}`,
    [size && `size ${size}`, range].filter(Boolean).join(', '),
    has(L.shape) && `shape ${phrase('shape', L.shape)}`,
    has(L.border) && `border ${phrase('border', L.border)}`,
    has(L.colours) && listOf(L.colours).length && `colour ${phrase('colours', L.colours)}`,
    has(L.surface) && `surface ${phrase('surface', L.surface)}`,
    has(L.texture) && `texture ${phrase('texture', L.texture)}`,
  ]);
  if (morph) out.push({ heading: 'Morphology', text: morph });

  const sec = join(LOOK_SECTIONS.find((s) => s.id === 'secondary').fields.map((f) => {
    if (!has(L[f.key])) return null;
    if (f.key === 'ulcerBase') return null;
    const v = phrase(f.key, L[f.key]);
    if (f.key === 'ulceration' && L.ulceration !== 'none' && L.ulcerBase) return `ulceration ${v}, base ${phrase('ulcerBase', L.ulcerBase)}`;
    return `${f.label.toLowerCase()} ${v}`;
  }));
  if (sec) out.push({ heading: 'Secondary changes', text: sec });

  const count = L.lesionCountKind ? phrase('lesionCountKind', L.lesionCountKind) : (L.lesionCount ? String(L.lesionCount) : '');
  const quant = join([count && `number of lesions ${count}`, (L.bsaPercent || L.bsaPercent === 0) && L.bsaPercent !== null && `${trim(L.bsaPercent)} % BSA`]);
  if (quant) out.push({ heading: 'Quantification', text: quant });

  if (L.dermoscopy) {
    const ds = join(LOOK_SECTIONS.find((s) => s.id === 'dermoscopy').fields
      .filter((f) => has(L[f.key])).map((f) => `${f.label.toLowerCase()} ${phrase(f.key, L[f.key])}`));
    out.push({ heading: 'Dermoscopy', text: ds || 'performed' });
  }
  return out;
};

/** Today's whole-skin exam, as headed lines (parts not examined are left out). */
const skinExamSections = (exam) => {
  if (!exam) return [];
  const E = exam;
  const out = [];
  if (E.hairExamined) {
    const density = E.hairDensity ? `${phrase('hairDensity', E.hairDensity)}${E.hairDensity === 'decreased' && has(E.hairDensityPattern) ? ` (${phrase('hairDensityPattern', E.hairDensityPattern)})` : ''}` : '';
    const pull = E.pullTest ? `${phrase('pullTest', E.pullTest)}${E.pullTest === 'positive' && (E.pullTestSite || E.pullTestCount) ? ` (${[E.pullTestSite, E.pullTestCount ? `${E.pullTestCount} hairs` : ''].filter(Boolean).join(', ')})` : ''}` : '';
    out.push({ heading: 'Hair', text: join([
      has(E.scalp) && `scalp ${E.scalp}`, density && `density ${density}`, has(E.hairCalibre) && `calibre ${phrase('hairCalibre', E.hairCalibre)}`,
      pull && `pull test ${pull}`, has(E.exclamationHairs) && `exclamation-point hairs ${phrase('exclamationHairs', E.exclamationHairs)}`,
      has(E.brokenHairs) && `broken hairs ${phrase('brokenHairs', E.brokenHairs)}`,
    ]) || 'examined' });
  }
  if (E.nailsExamined) {
    out.push({ heading: 'Nails', text: join([
      has(E.nailsAffected) && `affected ${phrase('nailsAffected', E.nailsAffected)}`, has(E.nailPlate) && `plate ${phrase('nailPlate', E.nailPlate)}`,
      has(E.nailBed) && `bed ${phrase('nailBed', E.nailBed)}`, has(E.periungual) && `periungual ${phrase('periungual', E.periungual)}`,
    ]) || 'examined' });
  }
  if (E.nodesExamined) {
    out.push({ heading: 'Lymph nodes', text: E.lymphadenopathy
      ? `regional lymphadenopathy ${phrase('lymphadenopathy', E.lymphadenopathy)}${E.nodesNote ? ` — ${E.nodesNote}` : ''}` : 'examined' });
  }
  if (E.mucosaExamined) {
    out.push({ heading: 'Mucosa', text: join([
      has(E.oral) && `oral ${phrase('oral', E.oral)}${E.oralNote ? ` — ${E.oralNote}` : ''}`,
      has(E.genital) && `genital ${phrase('genital', E.genital)}${E.genitalNote ? ` — ${E.genitalNote}` : ''}`,
    ]) || 'examined' });
  }
  if (E.notes) out.push({ heading: 'Notes', text: E.notes });
  return out;
};

/**
 * Photography, written from the day's photos (never typed — S10).
 * photos: [{ photoType: 'overview'|'close_up'|'dermoscopy', view }] where view
 * is what the photo shows (finding label + area). Returns a line or ''.
 */
const photographyText = (photos = []) => {
  if (!photos.length) return '';
  const clinical = photos.filter((p) => p.photoType !== 'dermoscopy');
  const dermo = photos.filter((p) => p.photoType === 'dermoscopy');
  const views = (list) => [...new Set(list.map((p) => p.view).filter(Boolean))].join(', ');
  const parts = [];
  parts.push(clinical.length ? `clinical photos taken: yes (${clinical.length})${views(clinical) ? ` — views: ${views(clinical)}` : ''}` : 'clinical photos taken: no');
  parts.push(dermo.length ? `dermoscopic images taken: yes (${dermo.length})${views(dermo) ? ` — ${views(dermo)}` : ''}` : 'dermoscopic images taken: no');
  return parts.join('; ');
};

module.exports = {
  LOOK_SECTIONS, EXAM_SECTIONS, LOOK_FIELDS, EXAM_FIELDS, EXAM_SWITCHES, CHOICE_FIELDS, LEGACY_LABELS,
  SKIN_EXAM_KEYS, LOOK_EXAM_KEYS, MAX_TERM, NAILS,
  cleanTerm, cleanOne, cleanMany, cleanLookExam, cleanSkinExam, typedTerms, labelOf, phrase, listOf,
  lookSections, skinExamSections, photographyText,
};
