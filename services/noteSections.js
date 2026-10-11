// =====================================================================
// Consultation-note sections — the database side (10 Oct 2026).
// utils/noteSections.js holds the vocabulary and the pure rules; this file
// reads and writes the rows.
//
//   saveSections(note, rows, patientId, t)   replace a note's sections
//   loadSections(noteIds)                    sections + ticks for many notes
//   carryForward(family)                     what pre-fills a new note:
//                                            the last saved copy of every
//                                            carry-forward section, the
//                                            patient file (allergies,
//                                            comorbidities, registration
//                                            medicines), prescriptions
//                                            (current / stopped) and the old
//                                            Initial Assessment as a seed.
// =====================================================================

const { Op } = require('sequelize');
const db = require('../models');
const { SECTIONS, CARRY_KEYS, sanitizeNoteHtml } = require('../utils/noteSections');
const { parseJsonColumn } = require('../utils/jsonColumn');

const {
  ConsultationNote, ConsultationNoteSection, ConsultationNoteSectionItem,
  Prescription, InitialAssessment, User,
} = db;

const doctorName = (u) => (u ? `Dr. ${u.firstName} ${u.lastName}` : null);

const formatSection = (s) => {
  const r = s.dataValues || s;
  return {
    id: r.id,
    key: r.key,
    position: r.position,
    html: r.html,
    text: r.text,
    reviewed: !!r.reviewed,
    carriedFromSectionId: r.carriedFromSectionId || null,
    items: (r.items || []).map((i) => ({ item: i.item, value: i.value })),
  };
};

/** Replace a note's sections with `rows` (from cleanSections). */
const saveSections = async (noteId, rows, patientId, transaction) => {
  await ConsultationNoteSection.destroy({ where: { ConsultationNoteId: noteId }, transaction, individualHooks: false });
  // items go with their section (FK ON DELETE CASCADE in the migration)
  for (const row of rows) {
    const section = await ConsultationNoteSection.create({
      ConsultationNoteId: noteId,
      PatientId: patientId,
      key: row.key,
      position: row.position,
      html: row.html,
      text: row.text,
      reviewed: row.reviewed,
      carriedFromSectionId: row.carriedFromSectionId,
    }, { transaction });
    if (row.items.length) {
      await ConsultationNoteSectionItem.bulkCreate(
        row.items.map((i) => ({ ConsultationNoteSectionId: section.id, item: i.item, value: i.value })),
        { transaction },
      );
    }
  }
};

/** { [noteId]: [section…] } in clinical order. */
const loadSections = async (noteIds) => {
  if (!noteIds.length) return {};
  const rows = await ConsultationNoteSection.findAll({
    where: { ConsultationNoteId: { [Op.in]: noteIds } },
    include: [{ model: ConsultationNoteSectionItem, as: 'items', attributes: ['id', 'item', 'value'] }],
    order: [['position', 'ASC'], ['id', 'ASC'], [{ model: ConsultationNoteSectionItem, as: 'items' }, 'id', 'ASC']],
  });
  const out = {};
  rows.forEach((r) => {
    (out[r.ConsultationNoteId] = out[r.ConsultationNoteId] || []).push(formatSection(r));
  });
  return out;
};

const medLine = (m) => {
  if (!m || typeof m !== 'object') return String(m || '').trim();
  const name = m.name || m.genericName || '';
  const bits = [name, m.dosage, m.frequency].filter((x) => x && String(x).trim()).map((x) => String(x).trim());
  return bits.join(' ');
};

/**
 * Everything a fresh note may be pre-filled with, for one patient family.
 *
 * @returns {{
 *   sections: { [key]: { html, items, source: { kind, label, date, by, sectionId } } },
 *   file: { allergies, comorbidities: string[], medications: string[], updatedAt },
 *   prescriptions: { current: [{ name, since, by }], stopped: [{ name, when, by }] },
 * }}
 */
const carryForward = async (family) => {
  const ids = family.patientIds;
  const out = { sections: {}, file: null, prescriptions: { current: [], stopped: [] } };

  // 1. The last saved copy of every carry-forward section (any doctor).
  const recent = await ConsultationNoteSection.findAll({
    where: { PatientId: { [Op.in]: ids }, key: { [Op.in]: CARRY_KEYS } },
    include: [
      { model: ConsultationNoteSectionItem, as: 'items', attributes: ['item', 'value'] },
      { model: ConsultationNote, attributes: ['id', 'date', 'time'], include: [{ model: User, as: 'doctor', attributes: ['firstName', 'lastName'] }] },
    ],
    order: [['id', 'DESC']],
    limit: 400,
  });
  // newest note wins: order by the note's date, then its time, then id
  const sorted = [...recent].sort((a, b) => {
    const na = a.ConsultationNote || {}; const nb = b.ConsultationNote || {};
    if (String(nb.date || '') !== String(na.date || '')) return String(nb.date || '') < String(na.date || '') ? -1 : 1;
    return b.id - a.id;
  });
  sorted.forEach((s) => {
    if (out.sections[s.key]) return;
    const n = s.ConsultationNote || {};
    out.sections[s.key] = {
      html: s.html,
      items: (s.items || []).map((i) => ({ item: i.item, value: i.value })),
      source: { kind: 'note', label: 'From last visit', date: n.date || null, by: doctorName(n.doctor), sectionId: s.id, reviewed: !!s.reviewed },
    };
  });

  // 2. The patient file — allergies (anyone, nurses included), comorbidities,
  //    registration medicines.
  const p = family.patient;
  out.file = {
    // "None" / "NKDA" at registration means nothing recorded — not an allergy
    allergies: p.allergies && !/^(none|nil|nkda|n\/a|no known( drug)? allergies)\.?$/i.test(String(p.allergies).trim()) ? String(p.allergies).trim() : '',
    comorbidities: (parseJsonColumn(p.comorbidities) || []).map((c) => String(c).trim()).filter(Boolean),
    medications: (parseJsonColumn(p.currentMedications) || []).map((c) => String(c).trim()).filter(Boolean),
    updatedAt: p.updatedAt || null,
  };
  // Allergies ALWAYS come from the file — it is the one copy (saving the
  // section writes it back there).
  // (one line per allergy: the file keeps them on one line, "; "-separated)
  out.sections.al = {
    html: out.file.allergies ? sanitizeNoteHtml(out.file.allergies.split(/\s*;\s*|\n/).filter(Boolean).join('<br>')) : '',
    items: [],
    source: { kind: 'file', label: 'From the patient file', date: out.file.updatedAt, by: null, sectionId: null },
  };
  if (!out.sections.pmh && out.file.comorbidities.length) {
    out.sections.pmh = {
      html: out.file.comorbidities.map((c) => sanitizeNoteHtml(c)).join('<br>'),
      items: [],
      source: { kind: 'file', label: 'From the patient file (comorbidities)', date: out.file.updatedAt, by: null, sectionId: null },
    };
  }

  // 3. Prescriptions — current (Active) and stopped (Completed / Cancelled),
  //    newest first, one line per medicine.
  const scripts = await Prescription.findAll({
    where: { PatientId: { [Op.in]: ids } },
    include: [{ model: User, as: 'doctor', attributes: ['firstName', 'lastName'] }],
    order: [['date', 'DESC'], ['id', 'DESC']],
    limit: 60,
  });
  const seen = new Set();
  scripts.forEach((rx) => {
    const meds = parseJsonColumn(rx.medications) || [];
    meds.forEach((m) => {
      const name = medLine(m);
      if (!name) return;
      const k = name.toLowerCase();
      if (seen.has(k)) return;        // the newest script's line for a medicine
      seen.add(k);
      const entry = { name, date: rx.date, by: doctorName(rx.doctor), prescriptionNumber: rx.prescriptionNumber };
      if (rx.status === 'Active') out.prescriptions.current.push(entry);
      else out.prescriptions.stopped.push(entry);
    });
  });
  out.file.medications.forEach((line) => {
    const k = line.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.prescriptions.current.push({ name: line, date: null, by: null, prescriptionNumber: null, fromFile: true });
  });

  // 4. The retired Initial Assessment seeds the first carried-forward
  //    sections for patients who had one.
  const legacy = await InitialAssessment.findOne({
    where: { PatientId: { [Op.in]: ids } },
    include: [{ model: User, as: 'doctor', attributes: ['firstName', 'lastName'] }],
    order: [['date', 'DESC'], ['id', 'DESC']],
  });
  if (legacy) {
    const src = { kind: 'assessment', label: 'From the initial assessment', date: legacy.date, by: doctorName(legacy.doctor), sectionId: null };
    const data = parseJsonColumn(legacy.data) || {};
    const asHtml = (t) => (t && String(t).trim() ? sanitizeNoteHtml(String(t).trim().replace(/\n/g, '<br>')) : '');
    if (!out.sections.pmh && asHtml(legacy.pastMedicalHistory)) out.sections.pmh = { html: asHtml(legacy.pastMedicalHistory), items: [], source: src };
    if (!out.sections.fh && asHtml(legacy.familyHistory)) out.sections.fh = { html: asHtml(legacy.familyHistory), items: [], source: src };
    if (!out.sections.sh) {
      const rows = [['Alcohol', data.alcoholIntake], ['Smoking', data.cigaretteSmoking], ['Diet', data.dietType], ['Exercise', data.exercisePlan], ['Substance use', data.substanceUse]]
        .filter(([, v]) => v && String(v).trim()).map(([item, v]) => ({ item, value: String(v).trim() }));
      if (rows.length || asHtml(legacy.socialHistory)) out.sections.sh = { html: rows.length ? '' : asHtml(legacy.socialHistory), items: rows, source: src };
    }
    if (!out.sections.dm_comp) {
      const rows = [['Retinopathy', data.retinopathy], ['Cerebrovascular disease', data.cerebrovascularDisease], ['Cardiovascular disease', data.cardiovascularDisease],
        ['Nephropathy', data.nephropathy], ['Neuropathy — peripheral', data.neuropathyPeripheral], ['Neuropathy — autonomic', data.neuropathyAutonomic]]
        .filter(([, v]) => v && String(v).trim()).map(([item, v]) => ({ item, value: String(v).trim() }));
      if (rows.length) out.sections.dm_comp = { html: '', items: rows, source: src };
    }
  }

  // Only carry-forward keys leave here (pc / hpi / imp never pre-fill).
  Object.keys(out.sections).forEach((k) => { if (!CARRY_KEYS.includes(k)) delete out.sections[k]; });
  return out;
};

module.exports = { saveSections, loadSections, carryForward, formatSection, SECTIONS };
