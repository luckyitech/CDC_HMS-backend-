'use strict';

// Who opened a patient's clinical record, and when.
//
// Authorship was already recorded everywhere; reading left no trace at all, so
// "who has been looking at my records?" had no answer. This is the other half
// of the question the clinical/non-clinical split answers — that decides who
// MAY look, this records who DID.
//
// Created empty. There is no history to backfill: the reads it records were
// never logged, and inventing entries would be fabricating an audit trail,
// which is worse than admitting the log starts today.

const TABLE = 'PatientAccessLogs';

const resolveTable = async (queryInterface, name) => {
  const tables = await queryInterface.showAllTables();
  return tables.find((t) => String(t).toLowerCase() === name.toLowerCase());
};

module.exports = {
  async up(queryInterface, Sequelize) {
    if (await resolveTable(queryInterface, TABLE)) return;   // already applied

    await queryInterface.createTable(TABLE, {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },

      // No foreign key on purpose. The log must outlive what it describes: a
      // patient merge repoints records at the surviving UHID, and an entry has
      // to keep naming the file that was actually opened. A cascade here could
      // also delete audit history, which defeats the point of having it.
      patientId: { type: Sequelize.INTEGER, allowNull: true },
      uhid:      { type: Sequelize.STRING,  allowNull: true },

      userId:   { type: Sequelize.INTEGER, allowNull: false },
      // Copied in rather than joined out, so an entry still says who it was
      // even after a rename, a change of role, or the account being deleted.
      userName: { type: Sequelize.STRING,  allowNull: true },
      userRole: { type: Sequelize.STRING,  allowNull: true },

      // STRING, not ENUM. UserLoginLog.role was an ENUM missing 'nurse' and
      // 'admin', and because that insert is fire-and-forget those logins were
      // silently dropped. An audit log that quietly discards rows is worse than
      // no log, because it looks complete.
      section: { type: Sequelize.STRING, allowNull: false },

      method: { type: Sequelize.STRING(8),   allowNull: true },
      path:   { type: Sequelize.STRING(512), allowNull: true },

      ipAddress:  { type: Sequelize.STRING, allowNull: true },
      accessedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },

      createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
    });

    // The only query this table is built to serve: one patient, newest first.
    // Deliberately not indexed by user — this is read per patient, never as
    // "what has this member of staff been looking at".
    await queryInterface.addIndex(TABLE, ['patientId', 'accessedAt'], {
      name: 'patient_access_by_patient',
    });
  },

  async down(queryInterface) {
    const table = await resolveTable(queryInterface, TABLE);
    if (table) await queryInterface.dropTable(table);
  },
};
