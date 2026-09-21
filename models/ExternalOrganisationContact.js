const { defineModel, DataTypes } = require('../utils/defineModel');

// ---------------------------------------------------------------------------
// ExternalOrganisationContact — one contact handle of an ExternalOrganisation:
// a WhatsApp number, an email address, or an email @domain. The Lab Inbox
// sender allowlist folds into this table (each allowlist entry becomes a 'lab'
// org with an 'email'/'emailDomain' contact), and an inbound WhatsApp message
// from a 'whatsapp' contact here is auto-typed as that lab/organisation.
//
// value is stored normalised (lower-cased address/domain; last-9 digits for a
// phone) so a lookup is exact. UNIQUE(kind, value) keeps one handle in one org.
// ---------------------------------------------------------------------------

const ExternalOrganisationContact = defineModel('ExternalOrganisationContact', {
  organisationId: { type: DataTypes.INTEGER, allowNull: false },
  kind: {
    type: DataTypes.ENUM('whatsapp', 'email', 'emailDomain'),
    allowNull: false,
  },
  value: { type: DataTypes.STRING, allowNull: false },   // normalised
  label: { type: DataTypes.STRING, allowNull: true },
}, {
  indexes: [
    { unique: true, fields: ['kind', 'value'], name: 'unique_org_contact_kind_value' },
    { fields: ['organisationId'], name: 'org_contact_organisation' },
  ],
});

module.exports = ExternalOrganisationContact;
