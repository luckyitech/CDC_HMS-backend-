'use strict';

// Dermatology click-through changes (8 Oct 2026, Emu):
//
//   DermFindings.typeOther      NEW  VARCHAR(60) — the name typed when the type
//                               is "Other" (e.g. "Keloid"). The names already
//                               used are offered again in later consultations.
//   DermObservations.morphology WIDENED VARCHAR(20) → VARCHAR(200): it now holds a
//                               comma list of tokens ("papule,vesicle"), like
//                               colours and symptoms. A single old value is
//                               already a valid one-item list — no data rewrite.
//
// `down`: REFUSES once any finding has a typeOther, or any look has more than
// one morphology (narrowing would lose it — restore the backup instead).

const TAG = '[20260928000024]';

const findTable = async (qi, name) => {
  const tables = await qi.showAllTables();
  return tables.map((t) => (typeof t === 'string' ? t : t.tableName))
    .find((t) => t.toLowerCase() === name.toLowerCase()) || null;
};

const countRows = async (qi, table, where = '') => {
  const [rows] = await qi.sequelize.query(`SELECT COUNT(*) AS n FROM \`${table}\` ${where}`);
  return Number(rows[0].n ?? rows[0].N ?? 0);
};

module.exports = {
  async up(queryInterface, Sequelize) {
    const qi = queryInterface;
    const findings = await findTable(qi, 'DermFindings');
    const observations = await findTable(qi, 'DermObservations');
    if (!findings || !observations) throw new Error(`${TAG} DermFindings / DermObservations missing — run 20260928000021 first`);

    const fCols = await qi.describeTable(findings);
    if (!fCols.typeOther) {
      await qi.addColumn(findings, 'typeOther', { type: Sequelize.STRING(60), allowNull: true, after: 'type' });
      console.log(`${TAG} DermFindings.typeOther added`);
    }
    const oCols = await qi.describeTable(observations);
    if (oCols.morphology && !/200/.test(String(oCols.morphology.type))) {
      await qi.changeColumn(observations, 'morphology', { type: Sequelize.STRING(200), allowNull: true });
      console.log(`${TAG} DermObservations.morphology widened to a list`);
    }
  },

  async down(queryInterface, Sequelize) {
    const qi = queryInterface;
    const findings = await findTable(qi, 'DermFindings');
    const observations = await findTable(qi, 'DermObservations');
    if (findings) {
      const cols = await qi.describeTable(findings);
      if (cols.typeOther) {
        const n = await countRows(qi, findings, 'WHERE typeOther IS NOT NULL');
        if (n > 0) throw new Error(`${TAG} down refused: ${n} finding(s) carry a typed "Other" name (medical record). Restore the database backup instead.`);
      }
    }
    if (observations) {
      const n = await countRows(qi, observations, "WHERE morphology LIKE '%,%' OR CHAR_LENGTH(morphology) > 20");
      if (n > 0) throw new Error(`${TAG} down refused: ${n} look(s) record more than one morphology. Restore the database backup instead.`);
    }
    if (findings && (await qi.describeTable(findings)).typeOther) await qi.removeColumn(findings, 'typeOther');
    if (observations) await qi.changeColumn(observations, 'morphology', { type: Sequelize.STRING(20), allowNull: true });
    console.log(`${TAG} reverted (nothing used the new fields)`);
  },
};
