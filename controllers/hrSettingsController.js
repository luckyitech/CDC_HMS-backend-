// HR Suite (B21) — check-in rules and clinic-wide hours (config.write).
const { success, error } = require('../utils/response');
const { getHrConfig, setHrConfig, FIELDS } = require('../utils/hrConfig');
const { recordSettingChanges } = require('../services/settingChangeLog');
const db = require('../models');

const { SettingChangeLog, User } = db;

const get = async (req, res) => {
  try {
    const cfg = await getHrConfig();
    const recent = await SettingChangeLog.findAll({
      where: { area: 'HR Suite' }, order: [['changedAt', 'DESC']], limit: 20,
    });
    return success(res, { ...cfg, recentChanges: recent.map((r) => ({
      id: r.id, label: r.label, oldValue: r.oldValue, newValue: r.newValue, changedByName: r.changedByName, changedAt: r.changedAt,
    })) });
  } catch (err) {
    console.error('HrSettings.get error:', err);
    return error(res, 'Failed to load HR settings', 500);
  }
};

const update = async (req, res) => {
  try {
    const allowed = Object.keys(FIELDS);
    const changes = {};
    for (const k of allowed) if (req.body[k] !== undefined) changes[k] = req.body[k];
    if (!Object.keys(changes).length) return error(res, 'Nothing to update.', 400);
    const before = await getHrConfig();
    const cfg = await setHrConfig(changes);
    recordSettingChanges({ user: req.user, area: 'HR Suite', before, after: cfg, fields: FIELDS });
    return success(res, cfg);
  } catch (err) {
    console.error('HrSettings.update error:', err);
    const userFacing = /must be|at least/i.test(err.message || '');
    return error(res, userFacing ? err.message : 'Failed to update HR settings', userFacing ? 400 : 500);
  }
};

module.exports = { get, update };
