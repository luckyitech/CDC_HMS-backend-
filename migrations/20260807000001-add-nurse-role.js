'use strict';

// HMIS V3 Phase 0 — widen Users.role to include 'nurse'.
// Additive ENUM widening (existing rows keep their value). The down() narrows
// back but first guards that no user holds 'nurse'.

module.exports = {
  async up(queryInterface, Sequelize) {
    // Guard (README rule): skip if the role ENUM already includes 'nurse', so a
    // from-scratch rebuild or a re-run is a no-op rather than a redundant ALTER.
    const [cols] = await queryInterface.sequelize.query(
      "SHOW COLUMNS FROM Users LIKE 'role'"
    );
    const type = cols && cols[0] ? String(cols[0].Type) : '';
    if (type.includes("'nurse'")) return;

    await queryInterface.changeColumn('Users', 'role', {
      type: Sequelize.ENUM('doctor', 'staff', 'lab', 'patient', 'admin', 'nurse'),
      allowNull: false,
    });
  },

  async down(queryInterface, Sequelize) {
    const [rows] = await queryInterface.sequelize.query(
      "SELECT COUNT(*) AS n FROM Users WHERE role = 'nurse'"
    );
    if (rows[0] && Number(rows[0].n) > 0) {
      throw new Error('Cannot remove nurse role: users still hold it. Reassign them first.');
    }
    await queryInterface.changeColumn('Users', 'role', {
      type: Sequelize.ENUM('doctor', 'staff', 'lab', 'patient', 'admin'),
      allowNull: false,
    });
  },
};
