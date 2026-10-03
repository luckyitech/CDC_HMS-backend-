const { defineModel, DataTypes } = require('../utils/defineModel');

// One competency on one appraisal: the person's and the reviewer's rating
// (1–4) and comment. Rows, not JSON, so ratings can be reported on. The
// competency's name is copied (competencyId kept for reporting).
const AppraisalRating = defineModel('AppraisalRating', {
  appraisalId:     { type: DataTypes.INTEGER, allowNull: false },
  competencyId:    { type: DataTypes.INTEGER, allowNull: true },
  name:            { type: DataTypes.STRING(120), allowNull: false },
  sortOrder:       { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  selfRating:      { type: DataTypes.TINYINT, allowNull: true },
  selfComment:     { type: DataTypes.TEXT, allowNull: true },
  reviewerRating:  { type: DataTypes.TINYINT, allowNull: true },
  reviewerComment: { type: DataTypes.TEXT, allowNull: true },
});

module.exports = AppraisalRating;
