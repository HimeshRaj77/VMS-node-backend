const express = require('express');
const router = express.Router();
const { registerAgency, loginAgency } = require('../controllers/authController');

// POST /api/auth/register
router.post('/register', registerAgency);

// POST /api/auth/login
router.post('/login', loginAgency);

module.exports = router;
