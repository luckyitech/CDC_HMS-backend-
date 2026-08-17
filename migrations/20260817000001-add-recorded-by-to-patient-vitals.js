'use strict';

// Attribution on triage vitals. PatientVital carried no author, so the Visit
// Timeline could never say who took a set of vitals and the nurse-workload
// analytics had nothing to group by. recordedById is stamped from the JWT
// (req.user.id) by both vitals endpoints — never from the client body.
//
// An INTEGER reference to Users.id, not a name string, per the audit-field
// rule; the display name is joined at read time (PatientVital.belongsTo(User,
// { as: 'recordedByUser' })). Nullable: rows recorded before this column existed
// stay as they are and read as "recorded by: unknown".
//
// ⚠️ Deploy order: run this migration BEFORE restarting the API. The new
// association makes every PatientVital query select recordedById; if the code
// starts first, vitals reads fail with "Unknown column" while the boot log
// looks healthy (sync({ alter:false }) only creates missing tables — it never
// adds columns).
//
// Guarded per column via describeTable; working down().

const TABLE  = 'PatientVitals';
const COLUMN = 'recordedById';

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable(TABLE);
    if (table[COLUMN]) return;

    await queryInterface.addColumn(TABLE, COLUMN, {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: { model: 'Users', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    });
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable(TABLE);
    if (table[COLUMN]) await queryInterface.removeColumn(TABLE, COLUMN);
  },
};
