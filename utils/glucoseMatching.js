// =====================================================================
// Server-side time-matching — the only route to meal context.
//
// The Accu-Chek Instant sends no meal marker (no 0x2A34), so a meter reading
// arrives with nothing but a value and a wall-clock time. The patient diary
// (PatientDiaryEvents) supplies the context: this matcher pairs each meter
// reading with the nearest diary MEAL and writes a `pre-<meal>` / `post-<meal>`
// tag onto the reading (contextTag + contextSource='matched'). Activity, dose,
// symptom and note events are NOT written onto the reading — they are shown
// alongside on the chart from the diary itself — so the reading's tag always
// answers exactly one question: what meal was it around.
//
// Rules (plan §6b):
//   • a reading ≤ 60 min BEFORE a meal        → pre-<meal>
//   • a reading 60–180 min AFTER a meal       → post-<meal>
//   • the CLOSEST qualifying meal wins; a tie prefers pre-
//   • no qualifying meal                      → the clock-hour bucket (source 'clock')
//
// It NEVER touches the reading's value or its meter time, and it NEVER
// overwrites a tag a human set by hand (contextSource='manual'). If the meter
// clock was more than CLOCK_DRIFT.noMatchSec out at import, that batch's
// readings are left on the clock heuristic — the times are too unreliable to
// match on (plan §6b clock rule). Runs after every meter import and again
// whenever a diary event is added, edited or removed.
//
// TIME. Meter measuredAt and diary occurredAt are both naive wall times stored
// through the same Date.UTC() encoding (utils/glucoseTime.js), so their JS
// Date .getTime() values are directly comparable in minutes with no timezone
// conversion at all.
// =====================================================================

const { Op } = require('sequelize');
const db = require('../models');
const G = require('../constants/glucose');
const { naiveToDate, naiveHour } = require('./glucoseTime');

const MIN = 60 * 1000;
const { GlucoseMeterReading, PatientDiaryEvent } = db;

// The meal tag written onto a reading, clamped to the column width (32).
const mealTag = (rel, label) => `${rel}-${(label && String(label).trim()) || 'meal'}`.slice(0, 32);

// Closest qualifying meal for one reading instant (ms), or null.
const bestMealFor = (readingMs, meals) => {
  let best = null;
  for (const ev of meals) {
    const delta = ev.ms - readingMs;                 // > 0 → the meal is in the future
    let rel = null;
    if (delta >= 0 && delta <= G.MATCH.preMealMin * MIN) rel = 'pre';
    else if (delta < 0 && -delta >= G.MATCH.postMealMinLow * MIN && -delta <= G.MATCH.postMealMinHigh * MIN) rel = 'post';
    if (!rel) continue;
    const closeness = Math.abs(delta);
    if (!best || closeness < best.closeness || (closeness === best.closeness && rel === 'pre')) {
      best = { rel, label: ev.label, closeness };
    }
  }
  return best ? mealTag(best.rel, best.label) : null;
};

/**
 * Re-tag every Active meter reading for a patient family whose measuredAt lies
 * in [fromNaive, toNaive] (naive 'YYYY-MM-DD HH:mm:ss'), against that family's
 * Active meal diary events. Merge-aware: the caller passes the whole family's
 * ids. Only rows whose (tag, source) actually change are written.
 *
 * @returns {Promise<{scanned:number, matched:number, cleared:number, updated:number}>}
 */
const matchWindow = async (patientIds, fromNaive, toNaive) => {
  const from = naiveToDate(fromNaive);
  const to = naiveToDate(toNaive);
  if (!from || !to) return { scanned: 0, matched: 0, cleared: 0, updated: 0 };

  // Meals can sit up to postMealMinHigh (180) min BEFORE a reading and
  // preMealMin (60) min AFTER it, so widen the meal window accordingly.
  const mealsFrom = new Date(from.getTime() - G.MATCH.postMealMinHigh * MIN);
  const mealsTo = new Date(to.getTime() + G.MATCH.preMealMin * MIN);

  const [readings, mealRows] = await Promise.all([
    GlucoseMeterReading.findAll({
      where: { PatientId: { [Op.in]: patientIds }, status: 'Active', measuredAt: { [Op.between]: [from, to] } },
      attributes: ['id', 'measuredAt', 'contextTag', 'contextSource', 'hostClockDeltaSec'],
    }),
    PatientDiaryEvent.findAll({
      where: { PatientId: { [Op.in]: patientIds }, status: 'Active', eventType: 'meal', occurredAt: { [Op.between]: [mealsFrom, mealsTo] } },
      attributes: ['occurredAt', 'label'],
    }),
  ]);

  const meals = mealRows.map((m) => ({ ms: new Date(m.occurredAt).getTime(), label: m.label }));

  // Decide each reading's tag, then write in as few statements as possible:
  // group the rows that need the SAME (tag, source) and issue one UPDATE per
  // group inside a transaction, instead of one UPDATE per row. A full 720-row
  // import collapses to a handful of statements (one per distinct tag) rather
  // than hundreds of round-trips. The per-reading decision is unchanged.
  let matched = 0, cleared = 0;
  const groups = new Map();                          // "tag\u0000source" -> [id, …] (changed rows only)
  for (const r of readings) {
    if (r.contextSource === 'manual') continue;      // a human set this tag — never override
    const driftOut = r.hostClockDeltaSec !== null && Math.abs(r.hostClockDeltaSec) > G.CLOCK_DRIFT.noMatchSec;
    const clockTag = G.bucketForHour(naiveHour(r.measuredAt));

    let newTag = clockTag, newSource = 'clock';
    if (!driftOut && meals.length) {
      const tag = bestMealFor(new Date(r.measuredAt).getTime(), meals);
      if (tag) { newTag = tag; newSource = 'matched'; matched++; }
    }
    if (newSource === 'clock' && r.contextSource === 'matched') cleared++;

    if (r.contextTag !== newTag || r.contextSource !== newSource) {
      const key = `${newTag}\u0000${newSource}`;
      (groups.get(key) || groups.set(key, []).get(key)).push(r.id);
    }
  }

  let updated = 0;
  if (groups.size) {
    await db.sequelize.transaction(async (transaction) => {
      for (const [key, ids] of groups) {
        const [contextTag, contextSource] = key.split('\u0000');
        await GlucoseMeterReading.update({ contextTag, contextSource }, { where: { id: { [Op.in]: ids } }, transaction });
        updated += ids.length;
      }
    });
  }
  return { scanned: readings.length, matched, cleared, updated };
};

module.exports = { matchWindow, bestMealFor, mealTag };
