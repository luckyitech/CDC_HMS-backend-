const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const catalog = require('../controllers/catalogController');

// Admin-managed clinical catalogs (medications, diagnoses) powering the
// autocomplete inputs. :type is validated by catalog.validateType.

// Suggestion sources — declared before /:type so 'sources' isn't taken as a type
router.get('/sources', authenticate, authorize('doctor', 'nurse', 'staff', 'lab', 'admin'), catalog.getSources);

// Search/list — used by the autocomplete inputs + the lab request form, so all
// clinical roles including nurse.
router.get('/:type', authenticate, authorize('doctor', 'nurse', 'staff', 'lab', 'admin'), catalog.validateType, catalog.list);

// Management — admin only
router.put('/:type/source', authenticate, authorize('admin', 'config.write'), catalog.validateType, catalog.setSource);
router.post('/:type', authenticate, authorize('admin', 'config.write'), catalog.validateType, catalog.create);
router.post('/:type/bulk', authenticate, authorize('admin', 'config.write'), catalog.validateType, catalog.bulkCreate);
router.put('/:type/:id', authenticate, authorize('admin', 'config.write'), catalog.validateType, catalog.update);
router.delete('/:type/:id', authenticate, authorize('admin', 'config.write'), catalog.validateType, catalog.destroy);

module.exports = router;
