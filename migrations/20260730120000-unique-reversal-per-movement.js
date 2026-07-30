'use strict';

/**
 * A movement may be reversed at most ONCE.
 *
 * reverseMovement() already checked for an existing reversal before writing
 * one, but that is a check-then-act race: under MySQL's default REPEATABLE
 * READ, two concurrent reversals of the same movement both take their snapshot
 * before either commits, both see no reversal, and both proceed. The row lock
 * on StockLevel serialises the writes but does not invalidate the second
 * transaction's stale snapshot — so both reversals apply and stock is credited
 * twice. Reproduced: reversing a dispense of 30 twice took a batch of 100 to
 * 130 units that were never received.
 *
 * No application-level read can close that window. The invariant belongs in the
 * database, where the second insert simply cannot land.
 *
 * NULL is exempt: MySQL permits many NULLs in a unique index, so ordinary
 * movements (which reverse nothing) are unaffected.
 *
 * Idempotent, with a working down().
 */

const TABLE = 'StockMovements';
const INDEX = 'unique_reversal_per_movement';
// reversesMovementId is a self-referencing foreign key, and MySQL requires an
// index on it. It will refuse to drop the LAST such index, so down() has to put
// a plain one in place before removing the unique one — otherwise the rollback
// fails with "needed in a foreign key constraint" and the migration is
// effectively irreversible.
const FALLBACK_INDEX = 'idx_stock_movements_reverses';

const tableExists = async (queryInterface) => {
  const tables = (await queryInterface.showAllTables())
    .map((t) => String(typeof t === 'string' ? t : t.tableName).toLowerCase());
  return tables.includes(TABLE.toLowerCase());
};

const hasIndex = async (queryInterface, name) => {
  const indexes = await queryInterface.showIndex(TABLE);
  return indexes.some((i) => i.name === name);
};

module.exports = {
  async up(queryInterface) {
    if (!(await tableExists(queryInterface))) {
      console.log(`${TABLE} does not exist yet — skipping`);
      return;
    }
    if (await hasIndex(queryInterface, INDEX)) {
      console.log(`${INDEX} already exists — skipping`);
      return;
    }

    // Refuse rather than fail halfway: if duplicates already exist the index
    // cannot be created, and silently dropping rows from an append-only ledger
    // would be far worse than stopping here.
    const [dupes] = await queryInterface.sequelize.query(
      `SELECT reversesMovementId, COUNT(*) AS c FROM \`${TABLE}\`
       WHERE reversesMovementId IS NOT NULL
       GROUP BY reversesMovementId HAVING c > 1`
    );
    if (dupes.length) {
      throw new Error(
        `Cannot add ${INDEX}: ${dupes.length} movement(s) already have more than one reversal ` +
        `(ids: ${dupes.map((d) => d.reversesMovementId).join(', ')}). ` +
        'These are duplicated corrections and the stock levels they produced are wrong. ' +
        'Resolve them deliberately — reverse the surplus reversal, then rebuild levels ' +
        'from the ledger via POST /api/stock/levels/rebuild — and run this migration again.'
      );
    }

    await queryInterface.addIndex(TABLE, ['reversesMovementId'], {
      name: INDEX,
      unique: true,
    });

    // The unique index satisfies the foreign key on its own, so a fallback left
    // behind by a previous down() is now redundant.
    if (await hasIndex(queryInterface, FALLBACK_INDEX)) {
      await queryInterface.removeIndex(TABLE, FALLBACK_INDEX);
    }
  },

  async down(queryInterface) {
    if (!(await tableExists(queryInterface))) return;
    if (!(await hasIndex(queryInterface, INDEX))) return;

    // Put a plain index in place BEFORE removing the unique one — MySQL will not
    // drop the last index backing a foreign key.
    if (!(await hasIndex(queryInterface, FALLBACK_INDEX))) {
      await queryInterface.addIndex(TABLE, ['reversesMovementId'], { name: FALLBACK_INDEX });
    }
    await queryInterface.removeIndex(TABLE, INDEX);
  },
};
