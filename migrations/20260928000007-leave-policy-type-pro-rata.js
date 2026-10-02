'use strict';

// B27 phase 1b — pro-rata is chosen per leave type (Emu, 28 Sep 2026).
//
// Phase 1 had one switch for the whole policy (LeavePolicies.proRate), which
// pro-rated every yearly type including Sick — a July joiner got 7 sick days.
// Emu's ruling: per type, Annual on, Sick off.
//
//   + LeavePolicyTypes.proRate  BOOLEAN NOT NULL DEFAULT false
//
// Backfill (only when the column is first added): a type is pro-rated where
// its policy's old switch was on, it is a yearly allowance (up front or
// monthly — per-event and no-limit types never are), and it is not Sick.
//
// LeavePolicies.proRate STAYS. The app keeps it equal to "at least one type is
// pro-rated", so `down` only has to drop the new column: the code before this
// migration reads the policy switch and finds a sensible value. What `down`
// cannot keep is the per-type choice itself — the old schema has nowhere to
// hold it — so, before dropping, it sets each policy's switch from its types.
//
// Guarded both ways; table names compared case-insensitively (the VDS returns
// them lowercase). `grant` and `key` are reserved words in MySQL — backticked.

const findTable = async (qi, name) => {
  const tables = await qi.showAllTables();
  return tables.map((t) => (typeof t === 'string' ? t : t.tableName))
    .find((t) => t.toLowerCase() === name.toLowerCase()) || null;
};

module.exports = {
  async up(queryInterface, Sequelize) {
    const ptTable = await findTable(queryInterface, 'LeavePolicyTypes');
    if (!ptTable) return;
    const cols = await queryInterface.describeTable(ptTable);
    if (cols.proRate) return;

    await queryInterface.addColumn(ptTable, 'proRate', { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false });

    const polTable = await findTable(queryInterface, 'LeavePolicies');
    const typesTable = await findTable(queryInterface, 'LeaveTypes');
    if (!polTable || !typesTable) return;
    await queryInterface.sequelize.query(
      `UPDATE \`${ptTable}\` pt
         JOIN \`${polTable}\` p ON pt.policyId = p.id
         JOIN \`${typesTable}\` t ON pt.leaveTypeId = t.id
          SET pt.proRate = 1
        WHERE p.proRate = 1
          AND pt.\`grant\` IN ('up_front', 'monthly')
          AND t.\`key\` <> 'Sick'`
    );
  },

  async down(queryInterface) {
    const ptTable = await findTable(queryInterface, 'LeavePolicyTypes');
    if (!ptTable) return;
    const cols = await queryInterface.describeTable(ptTable);
    if (!cols.proRate) return;

    const polTable = await findTable(queryInterface, 'LeavePolicies');
    if (polTable) {
      await queryInterface.sequelize.query(
        `UPDATE \`${polTable}\` p
            SET p.proRate = CASE WHEN EXISTS (
              SELECT 1 FROM \`${ptTable}\` pt WHERE pt.policyId = p.id AND pt.proRate = 1
            ) THEN 1 ELSE 0 END`
      );
    }
    await queryInterface.removeColumn(ptTable, 'proRate');
  },
};
