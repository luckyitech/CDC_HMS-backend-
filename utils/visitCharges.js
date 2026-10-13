// A visit's bill, carried through every stage (12 Oct 2026, Emu).
//
// The nurse, the doctor and the cashier add to ONE bill per visit (the Queue
// row). Queue.selectedCharges / selectedProcedures remain the bill — every
// existing reader (the cashier's checkout, reports) keeps working — and
// QueueCharges records who added each line, at which stage, and any removal.
//
// Every write to the bill goes through here, merging ON THE SERVER:
//   addCharges    — adds what is not already on the bill; never removes. The
//                   queue PUT, referral, admission request and triage vitals all
//                   call it, so a screen with stale data can no longer wipe
//                   another stage's lines (the old PUT replaced the arrays).
//   removeCharge  — takes one line off (soft: the row keeps who / when / why).
//   listCharges   — the bill with attribution; lines from before this existed
//                   come back as `legacy` (no who/when).
//   addAttempt    — one MORE attempt of a test (13 Oct 2026): "HbA1c × 2".
//
// Tests (HbA1c, RBS, Ketones — utils/testStock) count ATTEMPTS: each is its own
// QueueCharge row, takes its own supplies out of stock, and the bill shows
// "× n". Taking one off asks whether it was done: not done → its supplies go
// back. Every other line is on the bill once, as before.

const { QueueCharge } = require('../models');
const { isTest, takeForAttempt, returnForAttempt } = require('./testStock');

const KINDS = { charge: 'selectedCharges', procedure: 'selectedProcedures' };

// Triage results that are themselves billable tests — entering the value puts
// the test on the bill (the nurse can untick it). Names match CHARGE_OPTIONS.
const VITAL_CHARGES = { hba1c: 'HbA1c', rbs: 'Random Blood Sugar', ketones: 'Ketones' };

const jsonArray = (v) => {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } }
  return [];
};
const clean = (list) => [...new Set(jsonArray(list).map((s) => String(s || '').trim().slice(0, 120)).filter(Boolean))];

/** Which stage of the visit an action belongs to, from where the patient is and who is acting. */
const stageFor = (queue, user, explicit) => {
  if (explicit && ['triage', 'consultation', 'injection', 'radiology', 'billing'].includes(explicit)) return explicit;
  const s = queue.status;
  if (s === 'Pending Billing') return 'billing';
  if (s === 'Pending Injection') return 'injection';
  if (queue.destination === 'Radiology') return 'radiology';
  if (user?.role === 'doctor' && ['With Doctor', 'Awaiting Doctor'].includes(s)) return 'consultation';
  if (['Awaiting Triage', 'In Triage', 'Awaiting Doctor'].includes(s)) return 'triage';
  return 'other';
};

/**
 * Add lines to the visit's bill. Returns the names actually added.
 * @param queue   Queue instance (will be updated)
 * @param items   { charges?: string[], procedures?: string[] }
 * @param user    req.user (id, name, role) — attribution, never from the client
 * @param opts    { source: 'picked'|'vital', stage?, transaction?, save=true }
 */
const addCharges = async (queue, items, user, { source = 'picked', stage, transaction, save = true } = {}) => {
  const added = [];
  const testRows = [];
  const st = stageFor(queue, user, stage);
  for (const [kind, field] of Object.entries(KINDS)) {
    const incoming = clean(kind === 'charge' ? items?.charges : items?.procedures);
    if (!incoming.length) continue;
    const current = clean(queue[field]);
    const fresh = incoming.filter((n) => !current.includes(n));
    if (!fresh.length) continue;
    queue.set(field, [...current, ...fresh]);
    for (const name of fresh) {
      const row = await QueueCharge.create({
        QueueId: queue.id, kind, name, stage: st, source,
        addedById: user?.id || null, addedByName: user?.name || null, addedByRole: user?.role || null,
      }, { transaction });
      added.push(name);
      if (kind === 'charge' && isTest(name)) testRows.push(row);
    }
  }
  if (save && added.length) await queue.save({ transaction });
  // A test's supplies come out of stock once its line is committed (own transaction).
  if (testRows.length) {
    const take = () => Promise.all(testRows.map((r) => takeForAttempt(r, queue, user?.id)));
    if (transaction) transaction.afterCommit(() => { take().catch(() => {}); });
    else await take();
  }
  return added;
};

/** One more attempt of a test (a repeat). Returns the new line. */
const addAttempt = async (queue, name, user, { stage } = {}) => {
  if (!isTest(name)) return null;
  const st = stageFor(queue, user, stage);
  const row = await QueueCharge.create({
    QueueId: queue.id, kind: 'charge', name, stage: st, source: 'picked',
    addedById: user?.id || null, addedByName: user?.name || null, addedByRole: user?.role || null,
  });
  const current = clean(queue.selectedCharges);
  if (!current.includes(name)) { queue.set('selectedCharges', [...current, name]); await queue.save(); }
  await takeForAttempt(row, queue, user?.id);
  return row;
};

/**
 * Take one line off the bill (soft). Returns true when it was on the bill.
 * A test loses ONE attempt (the latest); `done === false` puts that attempt's
 * supplies back in stock. The name leaves the bill when no attempt is left.
 */
const removeCharge = async (queue, { kind, name, reason, done }, user, { transaction } = {}) => {
  const field = KINDS[kind];
  if (!field) return false;
  const current = clean(queue[field]);
  if (!current.includes(name)) return false;
  const test = kind === 'charge' && isTest(name);
  const active = test
    ? await QueueCharge.count({ where: { QueueId: queue.id, kind, name, status: 'active' }, transaction })
    : 1;
  if (active <= 1) {
    queue.set(field, current.filter((n) => n !== name));
    await queue.save({ transaction });
  }
  const row = await QueueCharge.findOne({ where: { QueueId: queue.id, kind, name, status: 'active' }, order: [['id', 'DESC']], transaction });
  if (row && test && done === false) {
    await returnForAttempt(row, queue, user?.id, reason ? String(reason).slice(0, 200) : null);
  } else if (row && test && done === true && row.stockStatus) {
    await row.update({ stockNote: 'Done — taken off the bill only' }, { transaction });
  }
  const removal = {
    status: 'removed', removedById: user?.id || null, removedByName: user?.name || null,
    removedAt: new Date(), removedReason: reason ? String(reason).slice(0, 255) : null,
  };
  if (row) await row.update(removal, { transaction });
  else {
    // A line from before the log existed: record its removal all the same.
    await QueueCharge.create({ QueueId: queue.id, kind, name, stage: stageFor(queue, user), source: 'picked', ...removal }, { transaction });
  }
  return true;
};

/** The bill with who added each line; removed lines listed separately. */
const listCharges = async (queue) => {
  const rows = await QueueCharge.findAll({ where: { QueueId: queue.id }, order: [['createdAt', 'ASC'], ['id', 'ASC']] });
  const out = [];
  for (const [kind, field] of Object.entries(KINDS)) {
    for (const name of clean(queue[field])) {
      const active = rows.filter((r) => r.kind === kind && r.name === name && r.status === 'active');
      const row = active[active.length - 1];
      const test = kind === 'charge' && isTest(name);
      out.push(row ? {
        kind, name, stage: row.stage, source: row.source,
        addedByName: row.addedByName, addedByRole: row.addedByRole, addedAt: row.createdAt, legacy: false,
        // Tests count attempts ("× 2"), each with who / when / whether stock was taken.
        test, quantity: test ? active.length : 1,
        attempts: test ? active.map((r) => ({
          id: r.id, stage: r.stage, source: r.source, addedByName: r.addedByName, addedByRole: r.addedByRole,
          addedAt: r.createdAt, stockStatus: r.stockStatus, stockNote: r.stockNote,
        })) : undefined,
      } : { kind, name, legacy: true, test, quantity: 1 });
    }
  }
  const removed = rows.filter((r) => r.status === 'removed').map((r) => ({
    kind: r.kind, name: r.name, stage: r.stage, addedByName: r.addedByName,
    removedByName: r.removedByName, removedAt: r.removedAt, removedReason: r.removedReason,
  }));
  return { lines: out, removed };
};

/** Bill the triage results that are tests (HbA1c, RBS, ketones) on the live visit. */
const chargesFromVitals = (body) => Object.entries(VITAL_CHARGES)
  .filter(([field]) => body?.[field] !== undefined && body[field] !== null && body[field] !== '')
  .map(([, name]) => name);

module.exports = { addCharges, addAttempt, removeCharge, listCharges, chargesFromVitals, stageFor, VITAL_CHARGES, KINDS, jsonArray };
