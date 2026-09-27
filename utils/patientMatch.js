// ---------------------------------------------------------------------------
// utils/patientMatch.js
//
// The single source of truth for "does a patient file that looks like this
// already exist?". Used at registration time (to WARN before a duplicate file
// is created) and available to the patient search fallback and the merge tool.
//
// Design constraints (see the project weak-points list):
//   - No new npm dependency: Levenshtein is hand-rolled; phonetic bucketing
//     uses MySQL's built-in SOUNDEX() in the candidate query.
//   - Merge-aware: every candidate is collapsed to its canonical patient
//     (mergedIntoId || id) so we never warn about, or point staff at, a
//     deactivated shadow record.
//   - Two stages: a cheap DB "blocking" query pulls a small candidate set;
//     the scoring runs in Node over that set only (never a full-table scan of
//     names, and never Levenshtein in SQL).
//
// The clinic-specific reason this exists: a file gets created with a misspelled
// name ("Mohammed"), the patient returns as "Mohamed", staff don't find the
// file, and a second file is born. Phonetic bucketing + edit-distance scoring
// catches that pair.
// ---------------------------------------------------------------------------

const { Op } = require('sequelize');
const sequelize = require('../config/database');
const db = require('../models');
const { Patient } = db;

// --- normalisation ---------------------------------------------------------

// Lower-case, strip diacritics and punctuation, collapse whitespace.
const normalizeName = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')   // combining marks
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// A token-sorted key so "Jane Amina Doe" == "Doe Jane Amina" (transposed
// first/last, dropped or reordered middle names all collapse to one key).
const nameKey = (firstName, lastName) =>
  normalizeName(`${firstName || ''} ${lastName || ''}`)
    .split(' ')
    .filter(Boolean)
    .sort()
    .join(' ');

// Kenyan numbers arrive as 0712…, +254712…, 254712…, 712…. Reduce to the last
// 9 significant digits so those forms compare equal.
const normalizePhone = (p) => {
  const digits = String(p || '').replace(/\D/g, '');
  return digits.length > 9 ? digits.slice(-9) : digits;
};

const normalizeEmail = (e) => String(e || '').trim().toLowerCase() || null;

// --- edit distance ---------------------------------------------------------

// Iterative two-row Levenshtein. O(n·m) time, O(min(n,m)) space. Names are
// short, so this is trivial per comparison and we only run it over the small
// blocked candidate set.
const levenshtein = (a, b) => {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array(b.length + 1);
  for (let i = 0; i < a.length; i++) {
    curr[0] = i + 1;
    for (let j = 0; j < b.length; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      curr[j + 1] = Math.min(curr[j] + 1, prev[j + 1] + 1, prev[j] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
};

// Similarity in [0,1]. 1 = identical.
const similarity = (a, b) => {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const max = Math.max(a.length, b.length) || 1;
  return 1 - levenshtein(a, b) / max;
};

// --- scoring config --------------------------------------------------------

// Thresholds are intentionally conservative to start; tune on real duplicate
// history before tightening. A match at or above PROBABLE triggers the WARN.
const THRESHOLDS = {
  CERTAIN:  0.90,   // near-certain: floated to the top of the warning
  PROBABLE: 0.78,   // shown as a possible match
};

// Name similarity carries the score; exact identifiers add confidence. DOB is a
// strong signal by request: same name + same DOB is treated as near-certain
// even if the name is only a fuzzy match.
const BONUS = {
  PHONE: 0.25,
  EMAIL: 0.25,
  ID:    0.30,
  DOB:   0.20,
};

// --- the matcher -----------------------------------------------------------

/**
 * Find existing patient files that plausibly match the given identity.
 *
 * @param {object} fields  { firstName, lastName, phone, email, dateOfBirth, idNumber, uhid }
 * @param {object} [opts]
 * @param {number} [opts.excludeId]  canonical patient id to exclude (self, on update/complete)
 * @param {number} [opts.limit=50]   max candidates to pull in the blocking query
 * @returns {Promise<Array>} candidates sorted by score desc, each:
 *   { id, uhid, name, firstName, lastName, dateOfBirth, phone, email,
 *     registeredBy, hasPortalAccount, score, tier, reasons[] }
 *   (only those at or above PROBABLE)
 */
const findMatches = async (fields, opts = {}) => {
  const { excludeId = null, limit = 50 } = opts;
  const firstName = fields.firstName;
  const lastName  = fields.lastName;
  const phone     = normalizePhone(fields.phone);
  const email     = normalizeEmail(fields.email);
  const idNumber  = fields.idNumber ? String(fields.idNumber).trim() : null;
  const uhid      = fields.uhid ? String(fields.uhid).trim() : null;

  // -- Stage 1: blocking query (cheap, indexable-ish, pulls a small set) -----
  const or = [];
  if (fields.phone) or.push({ phone: fields.phone });
  if (email)        or.push({ email });
  if (uhid)         or.push({ uhid });
  if (idNumber)     or.push({ idNumber });
  // Two complementary phonetic/prefix buckets on each name part, because either
  // one alone has a blind spot (both verified on MariaDB/MySQL 8):
  //   - SOUNDEX catches variants that differ in the MIDDLE of the word
  //     (Mohammed/Mohamed, Njeri/Njeru, Kamau/Kamaw) but is order-sensitive on
  //     trailing consonants, so it MISSES end-of-word variants (Wanjiru/Wanjiku
  //     → W526 vs W520, Achieng/Achieno).
  //   - A first-N-letters prefix catches exactly those end-of-word variants
  //     (LEFT('Wanjiru',4) = LEFT('Wanjiku',4) = 'Wanj') but misses a wrong
  //     first letter.
  // Together they retrieve realistic misspellings; the Node scorer then decides.
  // SOUNDEX/LEFT scans are fine at current table size; back them with stored
  // generated columns + indexes if the table grows (task debt).
  const prefixLen = 4;
  // Match one input token against ONE name column (SOUNDEX + prefix bucket).
  const tokenAgainstColumn = (col, val) => {
    const clauses = [
      sequelize.where(sequelize.fn('SOUNDEX', sequelize.col(col)), sequelize.fn('SOUNDEX', val)),
    ];
    const norm = normalizeName(val).replace(/\s/g, '');
    if (norm.length >= 3) {
      const pfx = norm.slice(0, prefixLen);
      clauses.push(sequelize.where(sequelize.fn('LOWER', sequelize.col(col)), { [Op.like]: `${pfx}%` }));
    }
    return clauses;
  };
  // Cross-match: each input name token is checked against BOTH columns, so a
  // file stored with first/last transposed ("Otieno John" vs input "John
  // Otieno") is still retrieved — the Node scorer's token-sorted key then
  // scores it correctly.
  if (firstName) { or.push(...tokenAgainstColumn('firstName', firstName)); or.push(...tokenAgainstColumn('lastName', firstName)); }
  if (lastName)  { or.push(...tokenAgainstColumn('lastName', lastName));   or.push(...tokenAgainstColumn('firstName', lastName)); }

  if (!or.length) return [];

  const rows = await Patient.findAll({
    where: { [Op.or]: or },
    attributes: ['id', 'uhid', 'firstName', 'lastName', 'dateOfBirth', 'phone', 'email', 'idNumber', 'registeredBy', 'status', 'mergedIntoId', 'UserId'],
    limit,
  });

  // -- collapse to canonical files, drop self / deactivated / already-merged --
  // Group every hit under its canonical id; keep one representative row. If both
  // a merged child and its canonical parent are in the set, the canonical wins.
  const byCanonical = new Map();
  for (const r of rows) {
    const canonicalId = r.mergedIntoId || r.id;
    if (excludeId && canonicalId === excludeId) continue;
    if ((r.status || '').toLowerCase() === 'inactive') continue;
    const existing = byCanonical.get(canonicalId);
    // Prefer the row that IS the canonical record (id === canonicalId).
    if (!existing || (r.id === canonicalId && existing.id !== canonicalId)) {
      byCanonical.set(canonicalId, r);
    }
  }

  // -- Stage 2: score in Node -------------------------------------------------
  const targetKey   = nameKey(firstName, lastName);
  const targetDob   = fields.dateOfBirth ? String(fields.dateOfBirth).slice(0, 10) : null;

  const scored = [];
  for (const r of byCanonical.values()) {
    // A candidate pulled in ONLY by a phonetic bucket but whose merged shadow
    // was the actual hit still gets scored on the canonical row's own name.
    const candKey  = nameKey(r.firstName, r.lastName);
    const nameScore = similarity(targetKey, candKey);

    const reasons = [];
    let score = nameScore;
    if (nameScore >= 0.6) reasons.push(nameScore >= 0.95 ? 'same name' : 'similar name');

    if (fields.phone && normalizePhone(r.phone) && normalizePhone(r.phone) === phone) {
      score += BONUS.PHONE; reasons.push('same phone');
    }
    if (email && normalizeEmail(r.email) === email) {
      score += BONUS.EMAIL; reasons.push('same email');
    }
    if (idNumber && r.idNumber && String(r.idNumber).trim() === idNumber) {
      score += BONUS.ID; reasons.push('same ID number');
    }
    let dobMatch = false;
    if (targetDob && r.dateOfBirth && String(r.dateOfBirth).slice(0, 10) === targetDob) {
      score += BONUS.DOB; dobMatch = true; reasons.push('same date of birth');
    }
    if (uhid && r.uhid === uhid) { score = 1; reasons.push('same UHID'); }

    score = Math.min(score, 1);

    // Tiering. Same name + same DOB is near-certain regardless of bonuses (DOB
    // is a strong signal by request). An exact strong identifier (phone/email/
    // id/uhid) always at least reaches PROBABLE so staff see it.
    const strongId = reasons.some((x) => x === 'same phone' || x === 'same email' || x === 'same ID number' || x === 'same UHID');
    let tier = null;
    if (score >= THRESHOLDS.CERTAIN || (nameScore >= 0.82 && dobMatch)) tier = 'certain';
    else if (score >= THRESHOLDS.PROBABLE || strongId) tier = 'probable';

    if (!tier) continue;

    scored.push({
      id:               r.id,
      uhid:             r.uhid,
      firstName:        r.firstName,
      lastName:         r.lastName,
      name:             `${r.firstName || ''} ${r.lastName || ''}`.trim(),
      dateOfBirth:      r.dateOfBirth,
      phone:            r.phone,
      email:            r.email,
      registeredBy:     r.registeredBy || null,
      hasPortalAccount: !!r.UserId,
      score:            Math.round(score * 100) / 100,
      tier,
      reasons,
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored;
};

module.exports = {
  findMatches,
  // exported for unit tests and reuse
  normalizeName,
  nameKey,
  normalizePhone,
  levenshtein,
  similarity,
  THRESHOLDS,
};
