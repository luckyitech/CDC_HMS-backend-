// =====================================================================
// Specialist modules — the clinic's on/off switches (7 Oct 2026, D2).
//
// A module (Dermatology; Histology / cytology from Phase 3) ships
// with the HMS but stays OFF until an administrator switches it on in System
// Settings → Specialist modules. CDC runs with them off; a licensed clinic
// (iTechModular) switches on the ones it bought.
//
// While a module is off its routes answer 404 (middleware/requireModule) and
// the frontend shows nothing of it. Switching it off never deletes data — the
// tables and rows stay; switching back on brings them back as they were.
//
// Stored as Setting rows 'modules.<key>' = 'true' | 'false'. No row = off.
// Every change is logged through services/settingChangeLog (area
// "Specialist modules").
// =====================================================================

const db = require('../models');
const { recordSettingChanges } = require('./settingChangeLog');

const { Setting } = db;

const MODULES = [
  { key: 'dermatology', label: 'Dermatology',
    description: 'Body map, skin findings, skin photos and procedures inside Today\'s Consultation.' },
  { key: 'histology', label: 'Histology / cytology',
    description: 'Histology and cytology requests (skin, thyroid nodule CNB / FNAC, lymph node, '
      + 'other site) as Orders tab 3, with typed results and the report.' },
];
const MODULE_KEYS = MODULES.map((m) => m.key);
const settingKey = (key) => `modules.${key}`;

/** { dermatology: false, … } — every known module, off unless a row says 'true'. */
const getModules = async () => {
  const rows = await Setting.findAll({ where: { key: MODULE_KEYS.map(settingKey) } });
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return Object.fromEntries(MODULE_KEYS.map((k) => [k, byKey[settingKey(k)] === 'true']));
};

const isModuleOn = async (key) => {
  if (!MODULE_KEYS.includes(key)) return false;
  const row = await Setting.findOne({ where: { key: settingKey(key) } });
  return row?.value === 'true';
};

/**
 * Switch modules on or off. `changes` = { dermatology: true, … }; unknown keys
 * are ignored by the caller's validation. Returns the new state.
 */
const setModules = async (changes, user) => {
  const before = await getModules();
  for (const key of MODULE_KEYS) {
    if (typeof changes[key] !== 'boolean') continue;
    const [row] = await Setting.findOrCreate({ where: { key: settingKey(key) }, defaults: { value: 'false' } });
    const value = changes[key] ? 'true' : 'false';
    if (row.value !== value) await row.update({ value });
  }
  const after = await getModules();
  recordSettingChanges({
    user, area: 'Specialist modules', before, after,
    fields: Object.fromEntries(MODULES.map((m) => [m.key, { key: settingKey(m.key), label: m.label }])),
  });
  return after;
};

module.exports = { MODULES, MODULE_KEYS, getModules, isModuleOn, setModules };
