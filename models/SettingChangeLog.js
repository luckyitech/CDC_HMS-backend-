const { defineModel, DataTypes } = require('../utils/defineModel');

// ---------------------------------------------------------------------------
// SettingChangeLog — who changed which clinic-wide setting, from what, to what.
//
// System Settings (password policy, the Lab Inbox mailbox + allowlist) and the
// clinical-catalog suggestion source are the only knobs that change how the
// whole clinic's system behaves, and until this table nothing recorded that
// anyone had touched them. One row per changed field per save.
//
// Like UserLoginLog it is a STORED event (the Activity Log is otherwise derived
// from domain tables), and like it the actor's name and role are denormalised
// so the trail survives a user being renamed or removed. Secrets are never
// written: services/settingChangeLog.js stores "(set)" / "(changed)" in place
// of a password's value.
// ---------------------------------------------------------------------------

const SettingChangeLog = defineModel('SettingChangeLog', {
  area: {
    type: DataTypes.STRING,        // 'Password policy' | 'Lab Inbox' | 'Clinical catalog' …
    allowNull: false,
  },
  settingKey: {
    type: DataTypes.STRING,        // the Setting row key, e.g. 'labInbox.allowlist'
    allowNull: false,
  },
  label: {
    type: DataTypes.STRING,        // human field name, e.g. 'Sender allowlist'
    allowNull: false,
  },
  oldValue: { type: DataTypes.TEXT, allowNull: true },
  newValue: { type: DataTypes.TEXT, allowNull: true },
  changedById: {
    type: DataTypes.INTEGER,       // FK -> Users.id (SET NULL on delete)
    allowNull: true,
  },
  changedByName: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  changedByRole: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  changedAt: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
  },
}, {
  indexes: [
    { fields: ['changedAt'], name: 'setting_change_logs_changed_at' },
    { fields: ['settingKey'], name: 'setting_change_logs_key' },
  ],
});

module.exports = SettingChangeLog;
