const fs = require('fs');
const { Op } = require('sequelize');
const db = require('../models');

const { Patient, sequelize } = db;

// ---------------------------------------------------------------------------
// Lab Inbox — patient auto-suggestion for an incoming external lab report.
//
// ADVISORY ONLY. This never files anything; it proposes ONE patient with a
// score + confidence tier and the hints it found, and a human confirms on the
// Lab Inbox page. External labs do not know our UHID, so the real signals are
// the patient's name, phone, national ID and DOB printed on the report (plus
// the email subject). Those are fuzzy — hence the tiers and the mandatory
// confirmation.
//
//   high    — UHID, national ID, or phone match, or name + DOB
//   medium  — full name (first + last) only, one candidate
//   low     — partial name, or several patients share the name (ambiguous)
//   none    — nothing usable (scanned image, encrypted PDF, foreign layout)
//
// Two layers: extractHints() is pure (no DB — unit-testable), suggestPatient()
// queries patients and ranks. pdf-parse is loaded lazily and every failure is
// swallowed into confidence 'none' — a bad PDF must never break an import.
// ---------------------------------------------------------------------------

const MAX_TEXT = 60_000;

/** Text from a PDF on disk. Returns '' on any failure (encrypted, image-only, corrupt). */
const extractPdfText = async (filePath) => {
  let parser;
  try {
    const { PDFParse } = require('pdf-parse');
    parser = new PDFParse({ data: fs.readFileSync(filePath) });
    const result = await parser.getText();
    const text = (result && result.text ? String(result.text) : '')
      .replace(/^--\s*\d+\s+of\s+\d+\s*--\s*$/gm, '')   // pdf-parse page separators
      .slice(0, MAX_TEXT);
    return text;
  } catch (err) {
    console.error('LabReportMatch.extractPdfText (non-fatal):', err.message);
    return '';
  } finally {
    if (parser && typeof parser.destroy === 'function') {
      try { await parser.destroy(); } catch { /* ignore */ }
    }
  }
};

// --- normalisers ------------------------------------------------------------

/** Kenyan phone → last 9 digits (07XX XXX XXX / +254 7XX / 2547XX all → 7XXXXXXXX). */
const normalisePhone = (raw) => {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length < 9) return null;
  return digits.slice(-9);
};

/** dd/mm/yyyy, dd-mm-yyyy, dd.mm.yyyy, yyyy-mm-dd, "14 Mar 1979" → YYYY-MM-DD (or null). */
const normaliseDate = (raw) => {
  if (!raw) return null;
  const s = String(raw).trim();
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  if ((m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/))) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const MONTHS = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', sept: '09', oct: '10', nov: '11', dec: '12' };
  if ((m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})[,.]?\s+(\d{4})$/))) {
    const mm = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mm) return `${m[3]}-${mm}-${m[1].padStart(2, '0')}`;
  }
  return null;
};

const cleanName = (s) => String(s || '')
  .replace(/\b(mr|mrs|ms|miss|dr|prof|baby|master)\.?\b/gi, ' ')
  .replace(/[^A-Za-z'’\- ,]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/** "WANJIRU, JANE" → {first:'Jane', last:'Wanjiru'}; "Jane Wanjiru" → first/last by position. */
const splitName = (raw) => {
  const s = cleanName(raw);
  if (!s) return null;
  if (s.includes(',')) {
    const [last, first] = s.split(',').map((p) => p.trim());
    if (last && first) return { first: first.split(' ')[0], last: last.split(' ')[0], full: s };
  }
  const parts = s.split(' ').filter((p) => p.length > 1);
  if (parts.length < 2) return parts.length === 1 ? { first: parts[0], last: null, full: s } : null;
  return { first: parts[0], last: parts[parts.length - 1], full: s };
};

// --- extraction (pure) ------------------------------------------------------

/**
 * Pull matching hints out of the report text + email subject/sender.
 * @returns {{ uhid, phone, idNumber, dob, name:{first,last,full}|null, raw:{} }}
 */
const extractHints = ({ text = '', subject = '', senderName = '' } = {}) => {
  const body = `${subject}\n${text}`;
  const hints = { uhid: null, phone: null, idNumber: null, dob: null, name: null, raw: {} };

  // UHID — cheap to check even though external labs rarely print it
  let m = body.match(/\bCDC[-\s]?(\d{3,})\b/i);
  if (m) { hints.uhid = `CDC${m[1]}`; hints.raw.uhid = m[0]; }

  // Phone — prefer a labelled one, else any Kenyan-looking number
  m = body.match(/(?:phone|tel|mobile|cell|contact)[^\d+]{0,12}((?:\+?254|0)\s?[17]\d{2}[\s-]?\d{3}[\s-]?\d{3})/i)
   || body.match(/\b((?:\+?254|0)\s?[17]\d{2}[\s-]?\d{3}[\s-]?\d{3})\b/);
  if (m) { hints.phone = normalisePhone(m[1]); hints.raw.phone = m[1]; }

  // National ID — ONLY when labelled, so reference numbers are never mistaken for it
  m = body.match(/(?:national\s*id|id\s*(?:no|number|#)|id)\s*[:.\-]?\s*(\d{6,9})\b/i);
  if (m) { hints.idNumber = m[1]; hints.raw.idNumber = m[0]; }

  // DOB — labelled
  m = body.match(/(?:d\.?o\.?b\.?|date\s*of\s*birth|born)\s*[:.\-]?\s*(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{4}|\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\s+[A-Za-z]{3,9}[,.]?\s+\d{4})/i);
  if (m) { hints.dob = normaliseDate(m[1]); hints.raw.dob = m[1]; }

  // Name — labelled line in the report first, then the subject
  m = text.match(/(?:patient\s*name|patient|name|client)\s*[:.\-]\s*([A-Za-z'’\-]+(?:[ ,]+[A-Za-z'’\-]+){1,3})/i);
  if (m) hints.name = splitName(m[1]);
  if (!hints.name && subject) {
    // "Lab results — WANJIRU, JANE — Ref 88213" / "Results for Jane Wanjiru"
    const sm = subject.match(/([A-Z][A-Za-z'’\-]+,\s*[A-Z][A-Za-z'’\-]+)/)
            || subject.match(/(?:for|re|patient)[:\s]+([A-Za-z'’\-]+\s+[A-Za-z'’\-]+)/i);
    if (sm) hints.name = splitName(sm[1]);
  }
  if (hints.name) hints.raw.name = hints.name.full;

  return hints;
};

// --- ranking (DB) -----------------------------------------------------------

const PATIENT_ATTRS = ['id', 'uhid', 'firstName', 'lastName', 'phone', 'idNumber', 'dateOfBirth', 'status', 'mergedIntoId'];

/** Collapse a merged duplicate to its canonical record (A4 — merge-aware). */
const canonical = async (p) => {
  if (!p) return null;
  if (!p.mergedIntoId) return p;
  const target = await Patient.findByPk(p.mergedIntoId, { attributes: PATIENT_ATTRS });
  return target ? canonical(target) : p;
};

const phoneWhere = (last9) => sequelize.where(
  sequelize.fn('REPLACE', sequelize.fn('REPLACE', sequelize.fn('REPLACE', sequelize.col('phone'), ' ', ''), '-', ''), '+', ''),
  { [Op.like]: `%${last9}` },
);

const nameMatches = (p, name) => {
  if (!p || !name) return { full: false, partial: false };
  const f = (p.firstName || '').toLowerCase(), l = (p.lastName || '').toLowerCase();
  const nf = (name.first || '').toLowerCase(), nl = (name.last || '').toLowerCase();
  const straight = nf && nl && f === nf && l === nl;
  const swapped  = nf && nl && f === nl && l === nf;
  const partial  = (nf && (f === nf || l === nf)) || (nl && (f === nl || l === nl));
  return { full: !!(straight || swapped), partial: !!partial };
};

/**
 * Suggest ONE patient for a report.
 * @param {object} hints  from extractHints()
 * @returns {{ patient:object|null, score:number, confidence:string, source:string }}
 */
const rankCandidates = async (hints) => {
  const none = { patient: null, score: 0, confidence: 'none', source: 'none' };
  try {
    // 1) UHID — exact, decisive
    if (hints.uhid) {
      const p = await canonical(await Patient.findOne({ where: { uhid: hints.uhid }, attributes: PATIENT_ATTRS }));
      if (p) return { patient: p, score: 100, confidence: 'high', source: 'uhid' };
    }

    // 2) National ID — exact, decisive
    if (hints.idNumber) {
      const p = await canonical(await Patient.findOne({ where: { idNumber: hints.idNumber }, attributes: PATIENT_ATTRS }));
      if (p) return { patient: p, score: 92, confidence: 'high', source: 'idNumber' };
    }

    // 3) Phone — strong; better still with the name agreeing
    if (hints.phone) {
      const rows = await Patient.findAll({ where: phoneWhere(hints.phone), attributes: PATIENT_ATTRS, limit: 5 });
      const cands = [];
      for (const r of rows) cands.push(await canonical(r));
      const uniq = [...new Map(cands.filter(Boolean).map((p) => [p.id, p])).values()];
      if (uniq.length === 1) {
        const nm = nameMatches(uniq[0], hints.name);
        return { patient: uniq[0], score: nm.full ? 96 : 82, confidence: 'high', source: nm.full ? 'phone+name' : 'phone' };
      }
      if (uniq.length > 1) {
        // a household phone — let the name decide, else ambiguous
        const byName = uniq.find((p) => nameMatches(p, hints.name).full);
        if (byName) return { patient: byName, score: 94, confidence: 'high', source: 'phone+name' };
        return { patient: uniq[0], score: 45, confidence: 'low', source: 'phone:shared' };
      }
    }

    // 4) Name (+ DOB)
    if (hints.name && hints.name.first && hints.name.last) {
      const { first, last } = hints.name;
      const rows = await Patient.findAll({
        where: {
          [Op.or]: [
            { firstName: first, lastName: last },
            { firstName: last,  lastName: first },
          ],
        },
        attributes: PATIENT_ATTRS, limit: 10,
      });
      const cands = [];
      for (const r of rows) cands.push(await canonical(r));
      const uniq = [...new Map(cands.filter(Boolean).map((p) => [p.id, p])).values()];

      if (uniq.length >= 1 && hints.dob) {
        const byDob = uniq.find((p) => p.dateOfBirth && String(p.dateOfBirth).slice(0, 10) === hints.dob);
        if (byDob) return { patient: byDob, score: 90, confidence: 'high', source: 'name+dob' };
      }
      if (uniq.length === 1) return { patient: uniq[0], score: 60, confidence: 'medium', source: 'name' };
      if (uniq.length > 1)  return { patient: uniq[0], score: 40, confidence: 'low', source: 'name:ambiguous' };

      // partial — surname only (common when the lab prints one name)
      const partial = await Patient.findAll({
        where: { [Op.or]: [{ lastName: last }, { lastName: first }] },
        attributes: PATIENT_ATTRS, limit: 5,
      });
      const pc = [];
      for (const r of partial) pc.push(await canonical(r));
      const pu = [...new Map(pc.filter(Boolean).map((p) => [p.id, p])).values()];
      if (pu.length === 1) return { patient: pu[0], score: 35, confidence: 'low', source: 'name:partial' };
    }

    return none;
  } catch (err) {
    console.error('LabReportMatch.rankCandidates (non-fatal):', err.message);
    return none;
  }
};

/**
 * End-to-end: read the PDF, extract hints, rank. Never throws.
 * @returns {{ suggestedPatientId, suggestionScore, suggestionConfidence, suggestionSource,
 *             extractedName, extractedPhone, extractedIdNumber, extractedUhid, extractedDob }}
 */
const suggestForReport = async ({ filePath, subject, senderName }) => {
  const text = filePath ? await extractPdfText(filePath) : '';
  const hints = extractHints({ text, subject, senderName });
  const ranked = await rankCandidates(hints);
  return {
    suggestedPatientId:   ranked.patient ? ranked.patient.id : null,
    suggestionScore:      ranked.score,
    suggestionConfidence: ranked.confidence,
    suggestionSource:     `${text ? 'pdf' : 'nopdf'}+email:${ranked.source}`,
    extractedName:        hints.name ? hints.name.full : null,
    extractedPhone:       hints.raw.phone || null,
    extractedIdNumber:    hints.idNumber,
    extractedUhid:        hints.uhid,
    extractedDob:         hints.dob,
  };
};

module.exports = {
  extractPdfText,
  extractHints,
  rankCandidates,
  suggestForReport,
  // exported for tests
  normalisePhone,
  normaliseDate,
  splitName,
};
