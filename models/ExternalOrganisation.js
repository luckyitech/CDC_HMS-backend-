const { defineModel, DataTypes } = require('../utils/defineModel');

// ---------------------------------------------------------------------------
// ExternalOrganisation — an outside party the clinic exchanges reports/messages
// with: a lab, a pharmacy, an insurer. One record holds all of that party's
// contact handles (its WhatsApp number(s) AND its email sender addresses) via
// ExternalOrganisationContact, so the Lab Inbox's email allowlist and a lab's
// WhatsApp number live in one place. A conversation whose contactType is 'lab'
// (or 'organisation') points here instead of at a patient.
// ---------------------------------------------------------------------------

const ExternalOrganisation = defineModel('ExternalOrganisation', {
  type: {
    type: DataTypes.ENUM('lab', 'pharmacy', 'insurer', 'other'),
    allowNull: false,
    defaultValue: 'lab',
  },
  name:     { type: DataTypes.STRING, allowNull: false },
  notes:    { type: DataTypes.STRING, allowNull: true },
  isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
}, {
  indexes: [
    { fields: ['type'], name: 'external_org_type' },
  ],
});

module.exports = ExternalOrganisation;
