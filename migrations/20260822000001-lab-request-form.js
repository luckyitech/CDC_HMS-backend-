'use strict';

/**
 * Lab Request Form — schema for the shared (doctor + nurse) lab request tool.
 *
 * Additive and guarded; safe to re-run and safe on a sync()-built dev DB.
 *
 * LabTests gains:
 *   notes                  free-text special instructions (the old modal collected
 *                          these and silently dropped them — there was no column)
 *   requisitionNumber      REQ-YYYY-NNN; shared by every test submitted together
 *                          so a multi-test request is one printable requisition
 *   price                  KES snapshot of the test's catalogue price at order time
 *   onBehalfOfDoctorId     the doctor a nurse-raised request is for (FK Users)
 *   packageName            snapshot of the package a test came from (null if à la carte)
 *   packageRate            snapshot of the package's special rate (null = sum-priced)
 *   supersedesRequisition  the requisition this one replaces (cancel & reissue)
 *   priority ENUM          gains 'STAT' (the route validator already allowed it)
 *   status   ENUM          gains 'Cancelled' (the route validator already allowed it)
 *
 * CatalogItems gains:
 *   price      KES price of a labTest entry
 *   isCommon   show this test as a quick-pick card in the request form
 *   type ENUM  gains 'labTest'
 *
 * New tables:
 *   LabPackages       named bundles (e.g. "Annual Diabetes Check-up")
 *   LabPackageItems   package ↔ CatalogItem membership (kept relational, not JSON,
 *                     so "which packages include test X" stays queryable)
 */

const enumSql = (values) =>
  `ENUM(${values.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ')})`;

const actualTableName = async (queryInterface, wanted) =>
  (await queryInterface.showAllTables())
    .map((t) => String(typeof t === 'string' ? t : t.tableName))
    .find((t) => t.toLowerCase() === String(wanted).toLowerCase()) || null;

const tableExists = async (queryInterface, wanted) =>
  !!(await actualTableName(queryInterface, wanted));

const addColumnIfMissing = async (queryInterface, wanted, column, spec) => {
  const actual = await actualTableName(queryInterface, wanted);
  if (!actual) return;
  const desc = await queryInterface.describeTable(actual);
  if (desc[column]) return;
  await queryInterface.addColumn(actual, column, spec);
};

const removeColumnIfPresent = async (queryInterface, wanted, column) => {
  const actual = await actualTableName(queryInterface, wanted);
  if (!actual) return;
  const desc = await queryInterface.describeTable(actual);
  if (desc[column]) await queryInterface.removeColumn(actual, column);
};

// Widen an ENUM column only when it is missing a value — idempotent.
const ensureEnumValue = async (queryInterface, wanted, column, values, { notNull = false, defaultValue = null } = {}) => {
  const actual = await actualTableName(queryInterface, wanted);
  if (!actual) return;
  const desc = await queryInterface.describeTable(actual);
  const current = desc[column];
  if (!current) return;
  const typeStr = String(current.type || '');
  const missing = values.some((v) => !typeStr.includes(`'${v}'`));
  if (!missing) return;
  const suffix = `${notNull ? ' NOT NULL' : ''}${defaultValue != null ? ` DEFAULT '${defaultValue}'` : ''}`;
  await queryInterface.sequelize.query(
    `ALTER TABLE \`${actual}\` MODIFY COLUMN \`${column}\` ${enumSql(values)}${suffix}`
  );
};

module.exports = {
  async up(queryInterface, Sequelize) {
    const { DataTypes } = Sequelize;

    // ── LabTests: new columns ────────────────────────────────────────────────
    await addColumnIfMissing(queryInterface, 'LabTests', 'notes', {
      type: DataTypes.TEXT, allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'LabTests', 'requisitionNumber', {
      type: DataTypes.STRING, allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'LabTests', 'price', {
      type: DataTypes.DECIMAL(10, 2), allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'LabTests', 'onBehalfOfDoctorId', {
      type: DataTypes.INTEGER, allowNull: true,
      references: { model: 'Users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
    });
    await addColumnIfMissing(queryInterface, 'LabTests', 'packageName', {
      type: DataTypes.STRING, allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'LabTests', 'packageRate', {
      type: DataTypes.DECIMAL(10, 2), allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'LabTests', 'supersedesRequisition', {
      type: DataTypes.STRING, allowNull: true,
    });

    // Index the requisition number — every list/group query filters on it.
    try {
      const actual = await actualTableName(queryInterface, 'LabTests');
      if (actual) await queryInterface.addIndex(actual, ['requisitionNumber'], { name: 'lab_tests_requisition_number' });
    } catch (err) {
      if (!/duplicate|exists/i.test(err.message || '')) throw err;
    }

    // ── LabTests: widen enums ────────────────────────────────────────────────
    await ensureEnumValue(queryInterface, 'LabTests', 'priority',
      ['Routine', 'Urgent', 'STAT'], { defaultValue: 'Routine' });
    await ensureEnumValue(queryInterface, 'LabTests', 'status',
      ['Pending', 'Sample Collected', 'In Progress', 'Completed', 'Cancelled'],
      { notNull: true, defaultValue: 'Pending' });

    // ── CatalogItems: price, isCommon, labTest type ──────────────────────────
    await addColumnIfMissing(queryInterface, 'CatalogItems', 'price', {
      type: DataTypes.DECIMAL(10, 2), allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'CatalogItems', 'isCommon', {
      type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false,
    });
    await ensureEnumValue(queryInterface, 'CatalogItems', 'type',
      ['medication', 'diagnosis', 'labTest'], { notNull: true });

    // ── LabPackages ──────────────────────────────────────────────────────────
    if (!(await tableExists(queryInterface, 'LabPackages'))) {
      await queryInterface.createTable('LabPackages', {
        id:         { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        name:       { type: DataTypes.STRING, allowNull: false, unique: true },
        priceMode:  { type: DataTypes.ENUM('sum', 'fixed'), allowNull: false, defaultValue: 'sum' },
        fixedPrice: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
        isCommon:   { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        status:     { type: DataTypes.ENUM('active', 'archived'), allowNull: false, defaultValue: 'active' },
        addedBy:    { type: DataTypes.STRING, allowNull: true },
        createdAt:  { type: DataTypes.DATE, allowNull: false },
        updatedAt:  { type: DataTypes.DATE, allowNull: false },
      });
    }

    // ── LabPackageItems (membership) ─────────────────────────────────────────
    if (!(await tableExists(queryInterface, 'LabPackageItems'))) {
      await queryInterface.createTable('LabPackageItems', {
        id:            { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
        LabPackageId:  { type: DataTypes.INTEGER, allowNull: false, references: { model: 'LabPackages', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
        CatalogItemId: { type: DataTypes.INTEGER, allowNull: false, references: { model: 'CatalogItems', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
        createdAt:     { type: DataTypes.DATE, allowNull: false },
        updatedAt:     { type: DataTypes.DATE, allowNull: false },
      });
      try {
        await queryInterface.addIndex('LabPackageItems', ['LabPackageId', 'CatalogItemId'], {
          unique: true, name: 'lab_package_items_unique',
        });
      } catch (err) {
        if (!/duplicate|exists/i.test(err.message || '')) throw err;
      }
    }
  },

  async down(queryInterface) {
    if (await tableExists(queryInterface, 'LabPackageItems')) {
      await queryInterface.dropTable('LabPackageItems');
    }
    if (await tableExists(queryInterface, 'LabPackages')) {
      await queryInterface.dropTable('LabPackages');
    }

    await removeColumnIfPresent(queryInterface, 'CatalogItems', 'price');
    await removeColumnIfPresent(queryInterface, 'CatalogItems', 'isCommon');
    // The labTest enum value is left in place — dropping it would fail if any
    // labTest rows exist, and a spare enum value is harmless.

    try {
      const actual = await actualTableName(queryInterface, 'LabTests');
      if (actual) await queryInterface.removeIndex(actual, 'lab_tests_requisition_number').catch(() => {});
    } catch { /* ignore */ }
    await removeColumnIfPresent(queryInterface, 'LabTests', 'notes');
    await removeColumnIfPresent(queryInterface, 'LabTests', 'requisitionNumber');
    await removeColumnIfPresent(queryInterface, 'LabTests', 'price');
    await removeColumnIfPresent(queryInterface, 'LabTests', 'onBehalfOfDoctorId');
    await removeColumnIfPresent(queryInterface, 'LabTests', 'packageName');
    await removeColumnIfPresent(queryInterface, 'LabTests', 'packageRate');
    await removeColumnIfPresent(queryInterface, 'LabTests', 'supersedesRequisition');
    // priority/status enum widenings are left in place (harmless spare values).
  },
};
