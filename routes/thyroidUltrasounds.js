const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const { INTERNAL_ROLES, PERMISSIONS } = require('../constants/permissions');
const CLINICAL_READ_ROLES = INTERNAL_ROLES;
const ctrl = require('../controllers/thyroidUltrasoundController');

// Thyroid ultrasound reporting — authored in the Radiology workspace.
// Reads: any clinical role. Writes: doctor or reporting tech (staff) or admin.
// (The exact "reporting tech" role maps to 'staff' for now — confirm at deploy.)
const READ   = CLINICAL_READ_ROLES;
// Authoring and signing a study. 'staff' is deliberately gone: it held
// reception and administration as well as clinical people, so the front desk
// could sign an ultrasound report. Who actually performs and reports a scan
// differs by clinic — a doctor here, a sonographer elsewhere — so it is granted
// per person rather than assumed from a role.
const AUTHOR = ['doctor', 'admin', PERMISSIONS.RADIOLOGY_WRITE];

router.use(authenticate);

// ----- catalogue (declared before /:id so 'catalog' is not read as an id) -----
router.get('/catalog/:type',            authorize(...READ),   ctrl.listCatalog);
router.post('/catalog/:type',           authorize(...AUTHOR), ctrl.addCatalog);
router.patch('/catalog/:type/:id/retire', authorize('admin'), ctrl.retireCatalog);

// ----- reports -----
router.get('/',            authorize(...READ),   ctrl.list);
router.post('/',           authorize(...AUTHOR), ctrl.create);
router.get('/:id/full',    authorize(...READ),   ctrl.getFull);
router.patch('/:id',       authorize(...AUTHOR), ctrl.patch);
router.delete('/:id',      authorize(...AUTHOR), ctrl.remove);

// ----- nodules -----
router.post('/:id/nodules',                authorize(...AUTHOR), ctrl.addNodule);
router.patch('/:id/nodules/:nid',          authorize(...AUTHOR), ctrl.updateNodule);
router.delete('/:id/nodules/:nid',         authorize(...AUTHOR), ctrl.deleteNodule);
router.put('/:id/nodules/:nid/follicular', authorize(...AUTHOR), ctrl.upsertFollicular);

// ----- preview / sign / reopen -----
router.post('/:id/preview', authorize(...AUTHOR), ctrl.preview);
router.post('/:id/sign',    authorize(...AUTHOR), ctrl.sign);
router.post('/:id/reopen',  authorize(...AUTHOR), ctrl.reopen);

// ----- images (machine-fed selection for the combined PDF) -----
router.put('/:id/images', authorize(...AUTHOR), ctrl.setImages);

module.exports = router;
