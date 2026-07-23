'use strict';

/**
 * Glp1SideEffectCatalogs — the clinic-wide symptom vocabulary.
 *
 * "Add symptom" in the side effects tracker writes here, so a symptom added for
 * one patient is offered for every patient afterwards. Entries are retired via
 * isActive, never deleted, because historical reviews reference them.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    if (tables.includes('Glp1SideEffectCatalogs')) return;

    await queryInterface.createTable('Glp1SideEffectCatalogs', {
      id: {
        type:          Sequelize.INTEGER,
        primaryKey:    true,
        autoIncrement: true,
        allowNull:     false,
      },
      name: {
        type:      Sequelize.STRING,
        allowNull: false,
      },
      isActive: {
        type:         Sequelize.BOOLEAN,
        allowNull:    false,
        defaultValue: true,
      },
      sortOrder: {
        type:         Sequelize.INTEGER,
        allowNull:    false,
        defaultValue: 0,
      },
      addedBy: {
        type:       Sequelize.INTEGER,
        allowNull:  true,
        references: { model: 'Users', key: 'id' },
        onUpdate:   'CASCADE',
        onDelete:   'SET NULL',
      },
      createdAt: {
        type:         Sequelize.DATE,
        allowNull:    false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
      updatedAt: {
        type:         Sequelize.DATE,
        allowNull:    false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });

    await queryInterface.addIndex('Glp1SideEffectCatalogs', ['name'], {
      unique: true,
      name:   'unique_glp1_side_effect_name',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('Glp1SideEffectCatalogs');
  },
};
