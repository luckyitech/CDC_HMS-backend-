'use strict';

// Staff Profiles Phase 3 — HR documents attached to a member of staff.
//
// Separate from MedicalDocuments by design: staff files in the patient document
// store would appear in patient document listings and inherit patient access
// rules. See STAFF_PROFILE_DESIGN.md.

const TABLE = 'StaffDocuments';

const CATEGORIES = [
  'Employment Contract', 'National ID', 'Practising Licence',
  'Academic Certificate', 'CV', 'Training Certificate',
  'Sick Note', 'Appraisal', 'Disciplinary', 'Other',
];

const tableExists = async (qi) => {
  const tables = await qi.showAllTables();
  return tables
    .map((t) => (typeof t === 'string' ? t : t.tableName).toLowerCase())
    .includes(TABLE.toLowerCase());
};

module.exports = {
  async up(queryInterface, Sequelize) {
    if (await tableExists(queryInterface)) return;

    await queryInterface.createTable(TABLE, {
      id:         { type: Sequelize.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
      UserId: {
        type: Sequelize.INTEGER, allowNull: true,
        references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
      },
      documentId: { type: Sequelize.STRING, allowNull: false },
      category:   { type: Sequelize.ENUM(...CATEGORIES), allowNull: false, defaultValue: 'Other' },

      // Defaults to the restrictive option so an unclassified upload stays
      // admin-only rather than leaking.
      visibility: { type: Sequelize.ENUM('Staff', 'Admin only'), allowNull: false, defaultValue: 'Admin only' },

      fileName:   { type: Sequelize.STRING, allowNull: false },
      filePath:   { type: Sequelize.STRING, allowNull: false },
      fileSize:   { type: Sequelize.STRING, allowNull: true },
      fileUrl:    { type: Sequelize.STRING, allowNull: true },

      uploadedById: {
        type: Sequelize.INTEGER, allowNull: true,
        references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
      },
      uploadedByRole: { type: Sequelize.STRING, allowNull: true },
      notes:          { type: Sequelize.TEXT, allowNull: true },

      isArchived:   { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      archivedById: { type: Sequelize.INTEGER, allowNull: true },
      archivedAt:   { type: Sequelize.DATE, allowNull: true },

      createdAt:  { type: Sequelize.DATE, allowNull: false },
      updatedAt:  { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.addIndex(TABLE, {
      fields: ['documentId'],
      unique: true,
      name: 'unique_staff_document_id',
    });
  },

  async down(queryInterface) {
    if (await tableExists(queryInterface)) await queryInterface.dropTable(TABLE);
  },
};
