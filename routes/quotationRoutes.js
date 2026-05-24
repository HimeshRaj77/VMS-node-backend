const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const { protect } = require('../middleware/auth');
const { uploadQuotation, getQuotationHistory, getQuotationById, getCurrentQuotation, updateQuotation } = require('../controllers/quotationController');

// Multer storage configuration — saves PDFs to /uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, '../uploads'));
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${uniqueSuffix}-${file.originalname}`);
  },
});

const fileFilter = (req, file, cb) => {
  if (file.mimetype === 'application/pdf') {
    cb(null, true);
  } else {
    cb(new Error('Only PDF files are allowed'), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB max
});

// POST /api/quotation/upload
router.post('/upload', protect, upload.single('pdf'), uploadQuotation);

// GET /api/quotation/current (placed before /:id to avoid collision)
router.get('/current', protect, getCurrentQuotation);

// GET /api/quotation/history
router.get('/history', protect, getQuotationHistory);

// GET /api/quotation/:id
router.get('/:id', protect, getQuotationById);

// PUT /api/quotation/:id
router.put('/:id', protect, updateQuotation);

module.exports = router;
