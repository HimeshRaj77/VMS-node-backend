const express = require('express');
const router = express.Router();
const { signupAdmin, loginAdmin, getAllAgencies, getAllQuotations, getAllAllocations, saveAllocations, getAllWorkers, getRequirements, saveRequirements } = require('../../controllers/adminController');
const { adminProtect } = require('../../middleware/admin/adminAuthMiddleware');

// POST /api/admin/signup
router.post('/signup', signupAdmin);

// POST /api/admin/login
router.post('/login', loginAdmin);

// GET /api/admin/agencies  (protected)
router.get('/agencies', adminProtect, getAllAgencies);

// GET /api/admin/quotations (protected)
router.get('/quotations', adminProtect, getAllQuotations);

// GET /api/admin/allocations (protected)
router.get('/allocations', adminProtect, getAllAllocations);

// POST /api/admin/allocations (protected)
router.post('/allocations', adminProtect, saveAllocations);

// GET /api/admin/workers (protected)
router.get('/workers', adminProtect, getAllWorkers);

// GET /api/admin/requirements (protected)
router.get('/requirements', adminProtect, getRequirements);

// POST /api/admin/requirements (protected)
router.post('/requirements', adminProtect, saveRequirements);

module.exports = router;

