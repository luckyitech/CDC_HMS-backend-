'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    if (tables.includes('CareLinkPartners')) return;

    await queryInterface.createTable('CareLinkPartners', {
      id: {
        type:          Sequelize.INTEGER,
        primaryKey:    true,
        autoIncrement: true,
        allowNull:     false,
      },
      PatientId: {
        type:       Sequelize.INTEGER,
        allowNull:  false,
        references: { model: 'Patients', key: 'id' },
        onUpdate:   'CASCADE',
        onDelete:   'CASCADE',
      },
      firstName:    { type: Sequelize.STRING, allowNull: false },
      lastName:     { type: Sequelize.STRING, allowNull: false },
      email:        { type: Sequelize.STRING, allowNull: false },
      relationship: { type: Sequelize.STRING, allowNull: false },
      phone:        { type: Sequelize.STRING, defaultValue: null },
      addedBy:      { type: Sequelize.INTEGER, defaultValue: null },
      addedDate:    { type: Sequelize.DATE,    defaultValue: null },
      createdAt:    { type: Sequelize.DATE,    allowNull: false },
      updatedAt:    { type: Sequelize.DATE,    allowNull: false },
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('CareLinkPartners');
  },
};
