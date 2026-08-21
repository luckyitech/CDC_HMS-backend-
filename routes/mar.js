const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const { PERMISSIONS } = require('../constants/permissions');
const mar = require('../controllers/marController');

const READ = ['doctor', 'nurse', 'admin', 'inpatient.access'];

// Orders (doctor)
router.post('/orders', authenticate, authorize('doctor'), mar.createOrder);
router.get('/orders', authenticate, authorize(...READ), mar.listOrders);
router.put('/orders/:id', authenticate, authorize('doctor'), mar.updateOrder);

// Drug round (nurse)
router.get('/due', authenticate, authorize('nurse', 'doctor'), mar.dueList);
router.post('/administer', authenticate, authorize('nurse', PERMISSIONS.MAR_ADMINISTER), mar.administer);
router.get('/history', authenticate, authorize(...READ), mar.history);

module.exports = router;
