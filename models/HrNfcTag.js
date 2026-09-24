const { defineModel, DataTypes } = require('../utils/defineModel');

// An NTAG 424 DNA entrance tag registered with the clinic (B21).
//
// The tag's SDM file-read key (K1) is stored ENCRYPTED with utils/crypto.js
// and is never returned by any API: every read path must
// `attributes: { exclude: ['keyEncrypted'] }`, and only the tap verifier and
// the "test a tap URL" action decrypt it. A generated key is shown to the
// admin exactly once, at registration, to write into the tag with TagWriter.
//
// lastCounter is the tag's monotonic SDM read counter as last seen. A tap
// whose counter is not greater than it is a replay (a screenshot, a saved
// link, a re-opened tab) and is refused.
//
// Association-injected: createdById, retiredById (models/index.js).
const HrNfcTag = defineModel('HrNfcTag', {
  // 7-byte UID as 14 uppercase hex characters, e.g. 04A1B2C3D4E5F6.
  uid: {
    type: DataTypes.STRING(14),
    allowNull: false,
    unique: true,
  },
  label: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  location: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: null,
  },
  keyEncrypted: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  lastCounter: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
  lastTapAt: {
    type: DataTypes.DATE,
    allowNull: true,
    defaultValue: null,
  },
  status: {
    type: DataTypes.ENUM('active', 'retired'),
    allowNull: false,
    defaultValue: 'active',
  },
  retiredAt: {
    type: DataTypes.DATE,
    allowNull: true,
    defaultValue: null,
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: true,
    defaultValue: null,
  },
});

module.exports = HrNfcTag;
