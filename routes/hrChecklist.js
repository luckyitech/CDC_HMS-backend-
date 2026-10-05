const express = require('express');
const router = express.Router();
const { body, param } = require('express-validator');
const validate = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const { isHrStaff } = require('../constants/permissions');
const { error } = require('../utils/response');
const { isKnownKey, MAX_LABEL, MAX_NOTE } = require('../utils/hrChecklist');
const checklist = require('../controllers/hrChecklistController');

// =====================================================================
// HR Suite → Manual → Checklist — /api/hr/manual (5 Oct 2026)
//
// HR STAFF ONLY: whoever holds at least one HR Suite control beyond
// Self-service (constants/permissions HR_STAFF_CONTROLS / isHrStaff — the
// same rule the frontend uses for the Manual sidebar item and page). Not an
// authorize() list on purpose: authorize() refuses outright when ANY
// capability it names has been withdrawn, so listing every HR control would
// let withdrawing one (say Sick-leave details from an HR officer) shut that
// person out of the manual. isHrStaff asks "holds any one of them?", each
// checked the way authorize('admin', <control>) would.
// =====================================================================
const requireHrStaff = (req, res, next) => {
  if (isHrStaff(req.user)) return next();
  return error(res, 'The HR Suite manual and its checklist are for HR staff.', 403);
};
const hr = [authenticate, requireHrStaff];

const KEY = param('key').custom(isKnownKey).withMessage('That checklist item does not exist.');

router.get('/checklist', ...hr, checklist.list);
router.put('/checklist/:key/done', ...hr, [
  KEY, body('done').isBoolean({ strict: true }).withMessage('Say whether the item is done.'), validate,
], checklist.setDone);
router.put('/checklist/:key/note', ...hr, [
  KEY, body('note').optional({ values: 'null' }).isString().isLength({ max: MAX_NOTE }), validate,
], checklist.setNote);
router.post('/checklist/items', ...hr, [
  body('label').isString().trim().isLength({ min: 1, max: MAX_LABEL }).withMessage('Write what the item is.'),
  body('section').isString(), validate,
], checklist.addItem);
router.patch('/checklist/items/:key', ...hr, [
  KEY, body('status').isIn(['archived', 'active']), validate,
], checklist.setStatus);

module.exports = router;
