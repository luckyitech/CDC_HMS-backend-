const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const labPackage = require('../controllers/labPackageController');

// Lab test bundles (packages). Read: any clinical role can see them in the
// request form. Manage: admin only (same policy as the clinical catalogue).

router.get('/', authenticate, authorize('doctor', 'nurse', 'staff', 'lab', 'admin'), labPackage.list);
router.post('/', authenticate, authorize('admin', 'config.write'), labPackage.create);
router.put('/:id', authenticate, authorize('admin', 'config.write'), labPackage.update);
router.delete('/:id', authenticate, authorize('admin', 'config.write'), labPackage.destroy);

module.exports = router;
