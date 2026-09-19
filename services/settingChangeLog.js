const db = require('../models');

const { SettingChangeLog } = db;

// ---------------------------------------------------------------------------
// Records who changed which clinic-wide setting, from what, to what.
//
// Fire-and-forget, like services/activityLogService.js logLogin: a settings
// save must never fail or slow down because the audit row could not be
// written. Every write is a diff — only fields whose value actually changed
// produce a row, so re-saving a form untouched logs nothing.
//
// SECRETS ARE NEVER STORED. A key that looks like a credential is logged as
// "(set)" → "(changed)" so the trail says it changed and by whom, never what to.
// ---------------------------------------------------------------------------

const SECRET_KEY = /password|secret|token|apikey|api_key/i;

/** A value as the short, human string the Activity Log shows. */
const show = (value) => {
  if (value === undefined || value === null || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (Array.isArray(value)) return value.length ? value.join(', ') : '(none)';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
};

const same = (a, b) => show(a) === show(b);

/**
 * Compare two config snapshots and log every field that changed.
 *
 * @param {object}   opts
 * @param {object}   opts.user     req.user (JWT) — attribution
 * @param {string}   opts.area     e.g. 'Lab Inbox'
 * @param {object}   opts.before   snapshot before the save (redacted — no secrets)
 * @param {object}   opts.after    snapshot after the save
 * @param {object}   opts.fields   { fieldName: { key: 'setting.key', label: 'Human label' } }
 * @param {string[]} [opts.secretsChanged]  fieldNames whose secret value was (re)set this save
 */
const recordSettingChanges = ({ user, area, before = {}, after = {}, fields = {}, secretsChanged = [] }) => {
  if (!user) return;
  const rows = [];
  const actor = {
    changedById:   user.id || null,
    changedByName: `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.name || 'Unknown',
    changedByRole: user.role || null,
    changedAt:     new Date(),
  };

  for (const [field, meta] of Object.entries(fields)) {
    if (SECRET_KEY.test(meta.key) || SECRET_KEY.test(field)) {
      if (secretsChanged.includes(field)) {
        rows.push({ ...actor, area, settingKey: meta.key, label: meta.label,
          oldValue: before[field] ? '(set)' : '—', newValue: '(changed)' });
      }
      continue;
    }
    if (same(before[field], after[field])) continue;
    rows.push({ ...actor, area, settingKey: meta.key, label: meta.label,
      oldValue: show(before[field]), newValue: show(after[field]) });
  }

  if (!rows.length) return;
  SettingChangeLog.bulkCreate(rows).catch((err) => {
    console.error('[SettingChangeLog] write failed (non-fatal):', err.message);
  });
};

module.exports = { recordSettingChanges, show };
