'use strict';

/**
 * Removes the thyroid ultrasound reporting tool's tables. The feature has been
 * retired in favour of uploading a final report PDF into the image safe.
 * Tables are dropped children-first to satisfy foreign keys. The old create
 * migrations are kept as history; this migration is what removes the tables.
 *
 * down() is intentionally a no-op: the tool's models were deleted, so the tables
 * cannot be faithfully recreated here. Restore from the create migrations in
 * git history if the feature is ever revived.
 */
const ORDER = [
  'ThyroidUltrasoundImages',
  'ThyroidNoduleFollicularAssessments',
  'ThyroidNodules',
  'ThyroidUsCatalogItems',
  'ThyroidUltrasounds',
];

module.exports = {
  async up(queryInterface) {
    const tables = await queryInterface.showAllTables().catch(() => []);
    const have = new Set((tables || []).map((t) => (typeof t === 'string' ? t : t.tableName)));
    for (const name of ORDER) {
      if (have.has(name)) await queryInterface.dropTable(name);
    }
  },
  async down() {
    // no-op — see file header
  },
};
