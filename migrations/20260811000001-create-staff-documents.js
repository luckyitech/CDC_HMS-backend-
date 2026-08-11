'use strict';

// Creates the StaffDocuments table — staff-scoped documents (practising
// licences, qualification certificates, training records, HR files).
//
// Guarded with showAllTables per the README convention: a rebuild of the
// database from scratch must not fail if the table already exists. Working
// down() drops it.

const TABLE = 'StaffDocuments';

module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    // showAllTables returns lowercase on some platforms; compare case-insensitively.
    if (tables.map(t => t.toLowerCase()).includes(TABLE.toLowerCase())) return;

    await queryInterface.createTable(TABLE, {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false,
      },
      documentId: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      // Whose file this document belongs to.
      staffUserId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Users', key: 'id' },
        onDelete: 'CASCADE',
      },
      // The admin who uploaded it.
      uploadedById: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Users', key: 'id' },
        onDelete: 'SET NULL',
      },
      documentCategory: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      fileName: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      filePath: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      fileSize: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      fileUrl: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      expiryDate: {
        type: Sequelize.DATEONLY,
        allowNull: true,
        defaultValue: null,
      },
      notes: {
        type: Sequelize.TEXT,
        allowNull: true,
        defaultValue: null,
      },
      status: {
        type: Sequelize.ENUM('active', 'archived'),
        allowNull: false,
        defaultValue: 'active',
      },
      archivedBy: {
        type: Sequelize.STRING,
        allowNull: true,
        defaultValue: null,
      },
      archivedAt: {
        type: Sequelize.DATE,
        allowNull: true,
        defaultValue: null,
      },
      archiveReason: {
        type: Sequelize.TEXT,
        allowNull: true,
        defaultValue: null,
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
      },
    });

    await queryInterface.addIndex(TABLE, ['documentId'], {
      unique: true,
      name: 'unique_staff_documentId',
    });
    await queryInterface.addIndex(TABLE, ['staffUserId'], {
      name: 'staff_documents_staffUserId',
    });
  },

  async down(queryInterface) {
    const tables = await queryInterface.showAllTables();
    if (!tables.map(t => t.toLowerCase()).includes(TABLE.toLowerCase())) return;
    await queryInterface.dropTable(TABLE);
  },
};
