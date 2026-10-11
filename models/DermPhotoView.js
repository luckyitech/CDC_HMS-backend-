const { defineModel, DataTypes } = require('../utils/defineModel');

// Who opened a skin photo, and when (Phase 2). One row per opening of the
// full picture — written by GET /api/derm/photos/:id/file. Never edited.
const DermPhotoView = defineModel('DermPhotoView', {
  viewedById: { type: DataTypes.INTEGER, allowNull: true },
}, {
  updatedAt: false,
  indexes: [{ name: 'idx_derm_photo_view', fields: ['DermPhotoId', 'createdAt'] }],
});

module.exports = DermPhotoView;
