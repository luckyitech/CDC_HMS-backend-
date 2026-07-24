'use strict';

/**
 * Adds `drugClass` to CatalogItems so a medication's clinical class is a real,
 * structured field instead of being inferred from magic text in its name.
 *
 * Before this, the GLP-1 tool decided whether a catalogue medication was a
 * GLP-1 agent by checking whether its name/detail contained the letters "GLP"
 * or "GIP" — which depended on an admin remembering an undocumented convention
 * and silently failed when they didn't. `drugClass` replaces that with a value
 * the admin picks from a dropdown.
 *
 * The column is nullable (diagnoses and un-classified medications have none).
 * The backfill sets drugClass = 'glp1' for any existing medication that WOULD
 * have matched the old substring rule, so nothing added the old way is lost.
 */

const enumSql = (values) =>
  `ENUM(${values.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ')})`;

// Kept in sync with constants/drugClasses.js. Duplicated as a literal here
// because migrations must not depend on app code that can change over time.
const DRUG_CLASS_VALUES = ['glp1'];

module.exports = {
  async up(queryInterface, Sequelize) {
    const { DataTypes } = Sequelize;
    const tables = (await queryInterface.showAllTables())
      .map((t) => String(typeof t === 'string' ? t : t.tableName).toLowerCase());
    if (!tables.includes('catalogitems')) {
      console.log('CatalogItems not found — skipping');
      return;
    }

    const cols = await queryInterface.describeTable('CatalogItems');
    if (!cols.drugClass) {
      await queryInterface.addColumn('CatalogItems', 'drugClass', {
        type: DataTypes.ENUM(...DRUG_CLASS_VALUES),
        allowNull: true,
      });
    }

    // Backfill anything that would have matched the old '%GLP%' / '%GIP%' rule
    await queryInterface.sequelize.query(
      "UPDATE `CatalogItems` SET `drugClass` = 'glp1' " +
      "WHERE `type` = 'medication' AND `drugClass` IS NULL AND (" +
      "  `name` LIKE '%GLP%' OR `name` LIKE '%GIP%' " +
      "  OR `detail` LIKE '%GLP%' OR `detail` LIKE '%GIP%')"
    );
  },

  async down(queryInterface) {
    const tables = (await queryInterface.showAllTables())
      .map((t) => String(typeof t === 'string' ? t : t.tableName).toLowerCase());
    if (!tables.includes('catalogitems')) return;

    const cols = await queryInterface.describeTable('CatalogItems');
    if (cols.drugClass) {
      await queryInterface.removeColumn('CatalogItems', 'drugClass');
      // MySQL leaves the ENUM type behind on some versions; harmless if absent
      await queryInterface.sequelize
        .query('DROP TYPE IF EXISTS "enum_CatalogItems_drugClass"')
        .catch(() => {});
    }
  },
};
