const { success, error } = require('../utils/response');
const { PREFERENCE_KEYS } = require('../utils/consultationTools');
const db = require('../models');

const { UserPreference } = db;

// =====================================================================
// My preferences — how the HMS looks to ME (7 Oct 2026).
// Always the caller's own rows (UserId from the JWT); nobody reads or sets
// anyone else's. Only keys listed in utils/consultationTools.PREFERENCE_KEYS
// are accepted, each through its own cleaner, so nothing arbitrary is stored.
// =====================================================================

const parse = (text) => { try { return JSON.parse(text); } catch { return null; } };

// GET /api/me/preferences — every key I have saved: { 'consultation.tools': {...} }
const list = async (req, res) => {
  try {
    const rows = await UserPreference.findAll({ where: { UserId: req.user.id } });
    const out = {};
    for (const r of rows) {
      if (!PREFERENCE_KEYS[r.key]) continue;
      out[r.key] = PREFERENCE_KEYS[r.key](parse(r.value));
    }
    return success(res, out);
  } catch (err) {
    console.error('UserPreference.list error:', err);
    return error(res, 'Server error', 500);
  }
};

// PUT /api/me/preferences/:key — { value } → the cleaned value as stored
const save = async (req, res) => {
  try {
    const clean = PREFERENCE_KEYS[req.params.key];
    if (!clean) return error(res, 'Unknown preference', 400, { code: 'UNKNOWN_PREFERENCE' });
    const value = clean(req.body?.value);
    const [row, created] = await UserPreference.findOrCreate({
      where: { UserId: req.user.id, key: req.params.key },
      defaults: { value: JSON.stringify(value) },
    });
    if (!created) await row.update({ value: JSON.stringify(value) });
    return success(res, { key: req.params.key, value });
  } catch (err) {
    console.error('UserPreference.save error:', err);
    return error(res, 'Server error', 500);
  }
};

module.exports = { list, save };
