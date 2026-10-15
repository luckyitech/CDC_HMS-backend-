const { success, error } = require('../utils/response');
const db = require('../models');
const { takeForAttempt } = require('../utils/testStock');
const { logStockActivity } = require('../utils/stockAudit');

const { QueueCharge, Queue, Patient } = db;

// Stocks — tests that use stock (13 Oct 2026, Emu). See utils/testStock.
//   GET  /api/stock/tests/not-taken           test attempts whose strip was not taken
//   POST /api/stock/tests/not-taken/:id/retry try again (after moving stock / matching a room)
//   POST /api/stock/tests/not-taken/retry-all every pending attempt, oldest first (15 Oct 2026:
//                                             a strip now comes from the store when no room has it)
//   POST /api/stock/tests/not-taken/:id/resolve { note } — settled another way

const notTaken = async (req, res) => {
  try {
    const rows = await QueueCharge.findAll({
      where: { stockStatus: 'not_taken', status: 'active' },
      include: [{ model: Queue, attributes: ['id', 'PatientId', 'createdAt'], include: [{ model: Patient, attributes: ['uhid', 'firstName', 'lastName'] }] }],
      order: [['createdAt', 'DESC']],
      limit: 200,
    });
    return success(res, rows.map((r) => ({
      id: r.id, name: r.name, at: r.createdAt, by: r.addedByName, stage: r.stage, note: r.stockNote,
      patient: r.Queue?.Patient ? { uhid: r.Queue.Patient.uhid, name: `${r.Queue.Patient.firstName} ${r.Queue.Patient.lastName}` } : null,
    })));
  } catch (err) {
    console.error('StockTests.notTaken error:', err);
    return error(res, 'Failed to load the tests not taken from stock', 500);
  }
};

const whose = (row) => {
  const p = row.Queue?.Patient;
  return `${row.name}${p ? ` — ${p.firstName} ${p.lastName} (${p.uhid})` : ''}`;
};

const findPending = async (id) => {
  const row = await QueueCharge.findByPk(id, { include: [{ model: Queue, include: [{ model: Patient, attributes: ['uhid', 'firstName', 'lastName'] }] }] });
  return row && row.stockStatus === 'not_taken' && row.status === 'active' ? row : null;
};

const retry = async (req, res) => {
  try {
    const row = await findPending(req.params.id);
    if (!row) return error(res, 'Nothing to take for this test', 404);
    await takeForAttempt(row, row.Queue, req.user.id);
    if (row.stockStatus !== 'taken') return error(res, row.stockNote || 'Still could not take the supplies', 409);
    await logStockActivity({ action: 'test_taken', userId: req.user.id, detail: whose(row) });
    return success(res, { id: row.id, stockStatus: row.stockStatus });
  } catch (err) {
    console.error('StockTests.retry error:', err);
    return error(res, 'Failed to take the supplies', 500);
  }
};

const retryAll = async (req, res) => {
  try {
    const rows = await QueueCharge.findAll({
      where: { stockStatus: 'not_taken', status: 'active' },
      include: [{ model: Queue, include: [{ model: Patient, attributes: ['uhid', 'firstName', 'lastName'] }] }],
      order: [['createdAt', 'ASC']],
      limit: 500,
    });
    let taken = 0;
    for (const row of rows) {
      await takeForAttempt(row, row.Queue, req.user.id);
      if (row.stockStatus === 'taken') {
        taken += 1;
        await logStockActivity({ action: 'test_taken', userId: req.user.id, detail: whose(row) });
      }
    }
    return success(res, { tried: rows.length, taken, remaining: rows.length - taken });
  } catch (err) {
    console.error('StockTests.retryAll error:', err);
    return error(res, 'Failed to take the supplies', 500);
  }
};

const resolve = async (req, res) => {
  try {
    const note = String(req.body?.note || '').trim();
    if (note.length < 3) return error(res, 'Say how it was settled');
    const row = await findPending(req.params.id);
    if (!row) return error(res, 'Nothing to settle for this test', 404);
    await row.update({ stockStatus: 'resolved', stockNote: `${note} — ${req.user.name || 'user'}`.slice(0, 255) });
    await logStockActivity({ action: 'test_settled', userId: req.user.id, detail: `${whose(row)} · ${note}` });
    return success(res, { id: row.id, stockStatus: row.stockStatus });
  } catch (err) {
    console.error('StockTests.resolve error:', err);
    return error(res, 'Failed to settle it', 500);
  }
};

module.exports = { notTaken, retry, retryAll, resolve };
