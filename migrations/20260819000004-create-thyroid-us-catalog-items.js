'use strict';

/**
 * ThyroidUsCatalogItems — clinic-editable vocabularies for indications and plan
 * options (mirrors Glp1SideEffectCatalog). Reporters add; admins retire via
 * isActive. Snapshotted labels are frozen on the report so a later rename never
 * rewrites a signed report.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    if (tables.map((t) => t.toLowerCase()).includes('thyroiduscatalogitems')) return;

    const S = Sequelize;
    await queryInterface.createTable('ThyroidUsCatalogItems', {
      id:        { type: S.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      type:      { type: S.ENUM('indication', 'plan'), allowNull: false },
      code:      { type: S.STRING, allowNull: false },
      label:     { type: S.STRING, allowNull: false },
      isActive:  { type: S.BOOLEAN, allowNull: false, defaultValue: true },
      sortOrder: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      addedBy:   { type: S.INTEGER, allowNull: true, references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
      createdAt: { type: S.DATE, allowNull: false, defaultValue: S.literal('CURRENT_TIMESTAMP') },
      updatedAt: { type: S.DATE, allowNull: false, defaultValue: S.literal('CURRENT_TIMESTAMP') },
    });

    await queryInterface.addIndex('ThyroidUsCatalogItems', ['type', 'code'], { unique: true, name: 'unique_thyroid_us_catalog_type_code' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('ThyroidUsCatalogItems');
  },
};
