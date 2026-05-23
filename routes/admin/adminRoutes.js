const express = require('express');
const router = express.Router();
const { signupAdmin, loginAdmin, getAllAgencies, getAllQuotations } = require('../../controllers/adminController');
const { adminProtect } = require('../../middleware/admin/adminAuthMiddleware');

// POST /api/admin/signup
router.post('/signup', signupAdmin);

// POST /api/admin/login
router.post('/login', loginAdmin);

// GET /api/admin/agencies  (protected)
router.get('/agencies', adminProtect, getAllAgencies);

// GET /api/admin/quotations (protected)
router.get('/quotations', adminProtect, getAllQuotations);

module.exports = router;
