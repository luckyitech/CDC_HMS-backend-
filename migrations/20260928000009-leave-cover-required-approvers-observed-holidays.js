'use strict';

// HR Suite Tier 2 (Emu, 2 Oct 2026 — recommendations T2-1 … T2-6 accepted).
//
//   LeaveParticipants.kind   ENUM + 'cover'          the colleague who covers the
//                                                    applicant's work (asked to
//                                                    agree; never blocks approval)
//   LeaveEvents.type         ENUM + 'cover_agreed', 'cover_declined'
//   StaffRequiredApprovers   NEW (UserId, approverId, setById) — HR (leave.manage)
//                            names approvers added to every new request a person makes
//   PublicHolidays.source    ENUM + 'auto'           a holiday on a Sunday is also
//   PublicHolidays.observedForId  INT NULL           observed on the next day that is
//                                                    not already a holiday (Public
//                                                    Holidays Act); 'auto' rows point
//                                                    at the Sunday holiday
//   + the observed day for every active Sunday holiday already in the table.
//     The three 2027 observed Mondays migration …002 SEEDED (11 Oct, 13 Dec,
//     27 Dec) become 'auto' rows linked to their Sunday holiday, so the switch
//     governs them too; `down` turns exactly those three back into 'seed'.
//
// `down`: REFUSES while any cover participant or cover event exists (narrowing
// an ENUM would blank those rows; the timeline is never edited). Otherwise it
// deletes the 'auto' holiday rows (derived — the up recreates them), drops
// observedForId, narrows the ENUMs and drops StaffRequiredApprovers (refusing if
// it has rows — HR typed those). Guarded both ways; table names compared
// case-insensitively (the VDS returns them lowercase). FK dropped before index.

const PART_KINDS_OLD = ['approver', 'acknowledger'];
const PART_KINDS_NEW = [...PART_KINDS_OLD, 'cover'];
const EVENT_OLD = ['submitted', 'approved', 'declined', 'info_requested', 'info_replied', 'charge_changed',
  'withdrawn', 'cancel_requested', 'cancelled', 'recorded', 'notified', 'document_added'];
const EVENT_NEW = [...EVENT_OLD, 'cover_agreed', 'cover_declined'];
const SOURCE_OLD = ['seed', 'hr'];
const SOURCE_NEW = [...SOURCE_OLD, 'auto'];
const TAG = '[20260928000009]';

const findTable = async (qi, name) => {
  const tables = await qi.showAllTables();
  return tables.map((t) => (typeof t === 'string' ? t : t.tableName))
    .find((t) => t.toLowerCase() === name.toLowerCase()) || null;
};
const hasValue = (column, value) => String(column?.type || '').includes(`'${value}'`)
  || (Array.isArray(column?.special) && column.special.includes(value));
const count = async (qi, sql) => {
  const [rows] = await qi.sequelize.query(sql);
  return Number(rows[0].n ?? rows[0].N ?? 0);
};

// The observed Mondays migration 20260928000002 seeded (kept in step with it).
const SEEDED_OBSERVED = ['2027-10-11', '2027-12-13', '2027-12-27'];

const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const isSunday = (s) => new Date(`${s}T00:00:00Z`).getUTCDay() === 0;

module.exports = {
  async up(queryInterface, Sequelize) {
    const qi = queryInterface;

    const parts = await findTable(qi, 'LeaveParticipants');
    if (parts) {
      const cols = await qi.describeTable(parts);
      if (cols.kind && !hasValue(cols.kind, 'cover')) {
        await qi.changeColumn(parts, 'kind', { type: Sequelize.ENUM(...PART_KINDS_NEW), allowNull: false });
      }
    }

    const events = await findTable(qi, 'LeaveEvents');
    if (events) {
      const cols = await qi.describeTable(events);
      if (cols.type && !hasValue(cols.type, 'cover_agreed')) {
        await qi.changeColumn(events, 'type', { type: Sequelize.ENUM(...EVENT_NEW), allowNull: false });
      }
    }

    if (!(await findTable(qi, 'StaffRequiredApprovers'))) {
      const users = await findTable(qi, 'Users') || 'Users';
      await qi.createTable('StaffRequiredApprovers', {
        id: { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        UserId: { type: Sequelize.INTEGER, allowNull: false, references: { model: users, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
        approverId: { type: Sequelize.INTEGER, allowNull: false, references: { model: users, key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
        setById: { type: Sequelize.INTEGER, allowNull: true },
        createdAt: { type: Sequelize.DATE, allowNull: false },
        updatedAt: { type: Sequelize.DATE, allowNull: false },
      });
      await qi.addIndex('StaffRequiredApprovers', ['UserId', 'approverId'], { unique: true, name: 'uniq_required_approver' });
    }

    const hol = await findTable(qi, 'PublicHolidays');
    if (hol) {
      const cols = await qi.describeTable(hol);
      if (cols.source && !hasValue(cols.source, 'auto')) {
        await qi.changeColumn(hol, 'source', { type: Sequelize.ENUM(...SOURCE_NEW), allowNull: false, defaultValue: 'hr' });
      }
      if (!cols.observedForId) {
        await qi.addColumn(hol, 'observedForId', { type: Sequelize.INTEGER, allowNull: true });
      }

      // The observed day for every active Sunday holiday already here.
      const [rows] = await qi.sequelize.query(`SELECT id, date, name, status, source, observedForId FROM \`${hol}\``);
      const observed = new Set(rows.filter((r) => r.observedForId).map((r) => Number(r.observedForId)));
      const byDate = new Map(rows.map((r) => [String(r.date instanceof Date ? iso(r.date) : r.date).slice(0, 10), r]));
      const now = new Date();
      let added = 0;
      for (const h of rows) {
        const date = String(h.date instanceof Date ? iso(h.date) : h.date).slice(0, 10);
        if (h.status !== 'active' || !isSunday(date)) continue;
        if (observed.has(Number(h.id))) continue;   // already has its observed day (a re-run)
        let day = addDays(date, 1);
        // A seeded "(observed)" row on that day is the observed day already: adopt it.
        const seeded = byDate.get(day);
        if (seeded && seeded.source === 'seed' && /\(observed\)\s*$/.test(seeded.name)) {
          await qi.sequelize.query(
            `UPDATE \`${hol}\` SET source = 'auto', observedForId = ? WHERE id = ?`,
            { replacements: [h.id, seeded.id] },
          );
          continue;
        }
        while (byDate.get(day)?.status === 'active') day = addDays(day, 1);
        if (byDate.has(day)) continue;   // a retired row on that date: HR's call, leave it
        await qi.bulkInsert(hol, [{
          date: day, name: `${h.name} (observed)`, status: 'active', source: 'auto', observedForId: h.id,
          createdBy: null, updatedBy: null, createdAt: now, updatedAt: now,
        }]);
        byDate.set(day, { status: 'active' });
        added += 1;
      }
      if (added) console.log(`${TAG} added ${added} observed day${added === 1 ? '' : 's'} for holidays on a Sunday`);
    }
  },

  async down(queryInterface, Sequelize) {
    const qi = queryInterface;

    const parts = await findTable(qi, 'LeaveParticipants');
    const events = await findTable(qi, 'LeaveEvents');
    const req = await findTable(qi, 'StaffRequiredApprovers');
    if (parts) {
      const n = await count(qi, `SELECT COUNT(*) AS n FROM \`${parts}\` WHERE kind = 'cover'`);
      if (n > 0) throw new Error(`${TAG} down refused: ${n} leave request(s) name a cover person. Restore the backup instead.`);
    }
    if (events) {
      const n = await count(qi, `SELECT COUNT(*) AS n FROM \`${events}\` WHERE type IN ('cover_agreed','cover_declined')`);
      if (n > 0) throw new Error(`${TAG} down refused: ${n} leave timeline entr${n === 1 ? 'y records' : 'ies record'} a cover answer. Restore the backup instead.`);
    }
    if (req) {
      const n = await count(qi, `SELECT COUNT(*) AS n FROM \`${req}\``);
      if (n > 0) throw new Error(`${TAG} down refused: HR has set ${n} required approver(s). Restore the backup instead.`);
    }

    const hol = await findTable(qi, 'PublicHolidays');
    if (hol) {
      const cols = await qi.describeTable(hol);
      if (cols.source && hasValue(cols.source, 'auto')) {
        // The three seeded Mondays go back to 'seed'; every other 'auto' row is
        // derived — the up recreates it from the Sunday holidays.
        await qi.sequelize.query(
          `UPDATE \`${hol}\` SET source = 'seed' WHERE source = 'auto' AND date IN (?)`,
          { replacements: [SEEDED_OBSERVED] },
        );
        await qi.sequelize.query(`DELETE FROM \`${hol}\` WHERE source = 'auto'`);
        await qi.changeColumn(hol, 'source', { type: Sequelize.ENUM(...SOURCE_OLD), allowNull: false, defaultValue: 'hr' });
      }
      if (cols.observedForId) await qi.removeColumn(hol, 'observedForId');
    }
    if (req) await qi.dropTable(req);
    if (events) {
      const cols = await qi.describeTable(events);
      if (cols.type && hasValue(cols.type, 'cover_agreed')) {
        await qi.changeColumn(events, 'type', { type: Sequelize.ENUM(...EVENT_OLD), allowNull: false });
      }
    }
    if (parts) {
      const cols = await qi.describeTable(parts);
      if (cols.kind && hasValue(cols.kind, 'cover')) {
        await qi.changeColumn(parts, 'kind', { type: Sequelize.ENUM(...PART_KINDS_OLD), allowNull: false });
      }
    }
  },
};
