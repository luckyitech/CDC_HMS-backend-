'use strict';

/**
 * Moves GLP-1 agents onto the clinic catalogue and drops the standalone
 * Glp1Medications formulary.
 *
 * All medication decisions in the app now come from one place — the clinic
 * catalogue (CatalogItem, type 'medication'). A GLP-1 agent is simply a
 * catalogue medication whose name or detail is tagged GLP-1 / GIP; the tool
 * derives its tabs from there. The per-agent titration ladder is no longer
 * stored: every course is built with the custom-ladder builder at initiation.
 *
 * A therapy therefore records its agent by name rather than a foreign key —
 * the catalogue owns medication identity, and a course must remember its drug
 * even if the catalogue entry is later edited or removed.
 *
 * Migration order: add the name columns, backfill them from the old formulary
 * while it still exists, then drop the FK and the table. All steps guarded so a
 * partially-applied or sync()-rebuilt database does not error.
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    const { DataTypes } = Sequelize;
    const tables = (await queryInterface.showAllTables()).map(String);
    if (!tables.includes('Glp1Therapies')) {
      console.log('Glp1Therapies not found — skipping');
      return;
    }

    let cols = await queryInterface.describeTable('Glp1Therapies');

    // 1. Denormalised agent identity on the therapy
    if (!cols.medicationName) {
      await queryInterface.addColumn('Glp1Therapies', 'medicationName', {
        type: DataTypes.STRING, allowNull: true,
      });
    }
    if (!cols.medicationBrand) {
      await queryInterface.addColumn('Glp1Therapies', 'medicationBrand', {
        type: DataTypes.STRING, allowNull: true,
      });
    }

    // 2. Backfill from the old formulary while it is still there
    if (tables.includes('Glp1Medications') && cols.Glp1MedicationId) {
      await queryInterface.sequelize.query(
        'UPDATE `Glp1Therapies` t ' +
        'JOIN `Glp1Medications` m ON t.`Glp1MedicationId` = m.`id` ' +
        'SET t.`medicationName` = m.`genericName`, t.`medicationBrand` = m.`brandName` ' +
        'WHERE t.`medicationName` IS NULL'
      );
    }

    // 3. Drop the foreign key and its column
    cols = await queryInterface.describeTable('Glp1Therapies');
    if (cols.Glp1MedicationId) {
      const [fks] = await queryInterface.sequelize.query(
        "SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE " +
        "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Glp1Therapies' " +
        "AND COLUMN_NAME = 'Glp1MedicationId' AND REFERENCED_TABLE_NAME = 'Glp1Medications'"
      );
      for (const row of fks) {
        await queryInterface.sequelize.query(
          `ALTER TABLE \`Glp1Therapies\` DROP FOREIGN KEY \`${row.CONSTRAINT_NAME}\``
        );
      }
      await queryInterface.removeColumn('Glp1Therapies', 'Glp1MedicationId');
    }

    // 4. medicationName is now the identity — make it required
    await queryInterface.sequelize.query(
      "UPDATE `Glp1Therapies` SET `medicationName` = 'Unknown agent' " +
      "WHERE `medicationName` IS NULL OR `medicationName` = ''"
    );
    await queryInterface.changeColumn('Glp1Therapies', 'medicationName', {
      type: DataTypes.STRING, allowNull: false,
    });

    // 5. Drop the formulary table (its only inbound FK was removed above)
    if (tables.includes('Glp1Medications')) {
      await queryInterface.dropTable('Glp1Medications');
    }
  },

  async down(queryInterface, Sequelize) {
    // Structural rollback only — the dropped formulary rows are not restored.
    const { DataTypes } = Sequelize;
    const tables = (await queryInterface.showAllTables()).map(String);

    if (!tables.includes('Glp1Medications')) {
      await queryInterface.createTable('Glp1Medications', {
        id:                    { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        genericName:           { type: DataTypes.STRING, allowNull: false },
        brandName:             { type: DataTypes.STRING },
        drugClass:             { type: DataTypes.STRING },
        route:                 { type: DataTypes.STRING },
        strengths:             { type: DataTypes.JSON },
        defaultSchedule:       { type: DataTypes.JSON },
        defaultTitrationWeeks: { type: DataTypes.INTEGER },
        isActive:              { type: DataTypes.BOOLEAN, defaultValue: true },
        addedBy:               { type: DataTypes.INTEGER },
        createdAt:             { type: DataTypes.DATE, allowNull: false },
        updatedAt:             { type: DataTypes.DATE, allowNull: false },
      });
    }

    const cols = await queryInterface.describeTable('Glp1Therapies');
    if (!cols.Glp1MedicationId) {
      await queryInterface.addColumn('Glp1Therapies', 'Glp1MedicationId', {
        type: DataTypes.INTEGER, allowNull: true,
      });
    }
    if (cols.medicationName)  await queryInterface.removeColumn('Glp1Therapies', 'medicationName');
    if (cols.medicationBrand) await queryInterface.removeColumn('Glp1Therapies', 'medicationBrand');
  },
};
