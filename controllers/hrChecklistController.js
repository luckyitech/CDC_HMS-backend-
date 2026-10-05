// HR Suite → Manual → Checklist (5 Oct 2026): ONE shared go-live / first-week
// checklist for the clinic's HR staff. The route gate (routes/hrChecklist.js)
// admits HR staff only (constants/permissions isHrStaff). Attribution comes
// from req.user, never from the body. Rules in utils/hrChecklist.
//
// State lives on HrChecklistItem (one row per item that has ever been touched
// or added); every change is also appended to HrChecklistEvent, so unticking
// keeps the record of who ticked it and when. Nothing is ever destroyed:
// custom items are archived and can be restored.

const crypto = require('crypto');
const { sequelize, User, HrChecklistItem, HrChecklistEvent } = require('../models');
const { success, error } = require('../utils/response');
const R = require('../utils/hrChecklist');

const NAME = ['id', 'firstName', 'lastName'];
const ITEM_INCLUDE = [
  { model: User, as: 'doneBy', attributes: NAME },
  { model: User, as: 'noteBy', attributes: NAME },
  { model: User, as: 'createdBy', attributes: NAME },
];
const HISTORY_LIMIT = 500;

const viewOf = async (itemKey, transaction) => R.itemView(
  await HrChecklistItem.findOne({ where: { itemKey }, include: ITEM_INCLUDE, transaction }),
);

/**
 * The row for a key, creating a built-in item's row on first use. Returns
 * { item } or { status, message }. A custom key must already exist.
 */
const rowFor = async (key, actorId, transaction) => {
  if (!R.isKnownKey(key)) return { status: 400, message: 'That checklist item does not exist.' };
  const found = await HrChecklistItem.findOne({ where: { itemKey: key }, transaction, lock: transaction?.LOCK?.UPDATE });
  if (found) {
    if (found.status !== 'active') return { status: 409, message: 'That item is archived — restore it first.' };
    return { item: found };
  }
  if (R.isCustomKey(key)) return { status: 404, message: 'That checklist item does not exist.' };
  const [item] = await HrChecklistItem.findOrCreate({
    where: { itemKey: key },
    defaults: { itemKey: key, section: R.sectionOfKey(key), isCustom: false, createdById: actorId },
    transaction,
  });
  return { item };
};

/** Apply one change (patch + history row) to an item, in one transaction. */
const applyChange = async (key, actorId, makeChange) => sequelize.transaction(async (transaction) => {
  const found = await rowFor(key, actorId, transaction);
  if (!found.item) return found;
  const change = makeChange(found.item);
  if (change) {
    await found.item.update(change.patch, { transaction });
    await HrChecklistEvent.create({ itemKey: key, ...change.event }, { transaction });
  }
  return { view: await viewOf(key, transaction) };
});

/** GET /api/hr/manual/checklist — every item with state, and the history. */
const list = async (req, res) => {
  try {
    const [items, events] = await Promise.all([
      HrChecklistItem.findAll({ include: ITEM_INCLUDE, order: [['createdAt', 'ASC'], ['id', 'ASC']] }),
      HrChecklistEvent.findAll({
        include: [{ model: User, as: 'by', attributes: NAME }],
        order: [['createdAt', 'DESC'], ['id', 'DESC']],
        limit: HISTORY_LIMIT,
      }),
    ]);
    return success(res, { items: items.map(R.itemView), events: events.map(R.eventView) });
  } catch (err) {
    console.error('HrChecklistItem.list error:', err);
    return error(res, 'Could not load the checklist', 500);
  }
};

/** PUT /api/hr/manual/checklist/:key/done  { done: boolean } — tick or untick. */
const setDone = async (req, res) => {
  try {
    if (typeof req.body?.done !== 'boolean') return error(res, 'Say whether the item is done.', 400);
    const out = await applyChange(req.params.key, req.user.id, (item) => R.tickChange(item, req.body.done, req.user.id));
    if (!out.view) return error(res, out.message, out.status);
    return success(res, out.view);
  } catch (err) {
    console.error('HrChecklistItem.setDone error:', err);
    return error(res, 'Could not save the tick', 500);
  }
};

/** PUT /api/hr/manual/checklist/:key/note  { note } — '' or null clears it. */
const setNote = async (req, res) => {
  try {
    const note = R.cleanNote(req.body?.note);
    if (note.error) return error(res, note.error, 400);
    const out = await applyChange(req.params.key, req.user.id, (item) => R.noteChange(item, note.value, req.user.id));
    if (!out.view) return error(res, out.message, out.status);
    return success(res, out.view);
  } catch (err) {
    console.error('HrChecklistItem.setNote error:', err);
    return error(res, 'Could not save the note', 500);
  }
};

/** POST /api/hr/manual/checklist/items  { section, label } — HR adds its own item. */
const addItem = async (req, res) => {
  try {
    const clean = R.cleanNewItem(req.body);
    if (clean.error) return error(res, clean.error, 400);
    const itemKey = `custom-${crypto.randomBytes(5).toString('hex')}`;
    const view = await sequelize.transaction(async (transaction) => {
      await HrChecklistItem.create({
        itemKey, section: clean.value.section, label: clean.value.label, isCustom: true, createdById: req.user.id,
      }, { transaction });
      await HrChecklistEvent.create({ itemKey, action: 'add', byId: req.user.id, detail: clean.value.label }, { transaction });
      return viewOf(itemKey, transaction);
    });
    return success(res, view, 201);
  } catch (err) {
    console.error('HrChecklistItem.addItem error:', err);
    return error(res, 'Could not add the item', 500);
  }
};

/** PATCH /api/hr/manual/checklist/items/:key  { status: 'archived' | 'active' } — custom items only. */
const setStatus = async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!['archived', 'active'].includes(status)) return error(res, 'Choose archive or restore.', 400);
    const out = await sequelize.transaction(async (transaction) => {
      const item = await HrChecklistItem.findOne({ where: { itemKey: req.params.key }, transaction });
      if (!item || !item.isCustom) return { status: 404, message: 'Only items HR added can be archived.' };
      if (item.status !== status) {
        await item.update(status === 'archived'
          ? { status, archivedById: req.user.id, archivedAt: new Date() }
          : { status, archivedById: null, archivedAt: null }, { transaction });
        await HrChecklistEvent.create({
          itemKey: item.itemKey, action: status === 'archived' ? 'archive' : 'restore', byId: req.user.id,
        }, { transaction });
      }
      return { view: await viewOf(item.itemKey, transaction) };
    });
    if (!out.view) return error(res, out.message, out.status);
    return success(res, out.view);
  } catch (err) {
    console.error('HrChecklistItem.setStatus error:', err);
    return error(res, 'Could not change the item', 500);
  }
};

module.exports = { list, setDone, setNote, addItem, setStatus };
