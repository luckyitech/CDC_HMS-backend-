'use strict';

// Adds `overallGrade` to NeuropathyStudies — the study's single Final-Result
// severity: the WORST of the numeric per-foot grades (R/L × VPT/HOT/COLD).
// Monofilament is excluded, exactly matching how NeuropathyReport derives the
// printed Final Result. Persisted at sign-off (see neuropathyController.complete)
// so the live prospective-cohort analytics count the clinically-signed grade
// rather than re-deriving it on every read.
//
// Guarded (describeTable/showAllTables), reversible, and back-fills existing
// Completed studies from their already-signed per-foot grade columns.

const TABLE = 'NeuropathyStudies';
const GRADES = ['Normal', 'Mild', 'Moderate', 'Severe'];
const RANK = { Normal: 0, Mild: 1, Moderate: 2, Severe: 3 };

const resolveTable = async (qi, name) => {
  const tables = await qi.showAllTables();
  return tables.find((t) => String(t).toLowerCase() === name.toLowerCase());
};
const hasColumn = async (qi, table, col) => {
  const d = await qi.describeTable(table);
  return Object.keys(d).some((c) => c.toLowerCase() === col.toLowerCase());
};

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await resolveTable(queryInterface, TABLE);
    if (!table) return;

    if (!(await hasColumn(queryInterface, table, 'overallGrade'))) {
      await queryInterface.addColumn(table, 'overallGrade', {
        type: Sequelize.ENUM(...GRADES),
        allowNull: true,
        defaultValue: null,
      });
    }

    // Back-fill signed studies from their stored per-foot grades (idempotent:
    // only rows still NULL are touched, so re-running is safe).
    const [rows] = await queryInterface.sequelize.query(
      'SELECT id, rightVptGrade, leftVptGrade, rightHotGrade, leftHotGrade, rightColdGrade, leftColdGrade ' +
      'FROM `' + table + '` WHERE status = \'Completed\' AND overallGrade IS NULL'
    );
    for (const r of rows) {
      const ranks = [
        r.rightVptGrade, r.leftVptGrade,
        r.rightHotGrade, r.leftHotGrade,
        r.rightColdGrade, r.leftColdGrade,
      ].filter((g) => g && Object.prototype.hasOwnProperty.call(RANK, g)).map((g) => RANK[g]);
      if (!ranks.length) continue;
      const worst = GRADES[Math.max(...ranks)];
      await queryInterface.sequelize.query(
        'UPDATE `' + table + '` SET overallGrade = ? WHERE id = ?',
        { replacements: [worst, r.id] }
      );
    }
  },

  async down(queryInterface) {
    const table = await resolveTable(queryInterface, TABLE);
    if (!table) return;
    if (await hasColumn(queryInterface, table, 'overallGrade')) {
      await queryInterface.removeColumn(table, 'overallGrade');
    }
  },
};
