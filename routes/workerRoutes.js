const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { protect } = require('../middleware/auth');
const { extractAadharOCR, extractExcelRoster, createWorker, getWorkersByService, deleteWorker } = require('../controllers/workerController');

// Multer storage setup - saves Aadhaar card scans inside /uploads/aadhar
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '../uploads/aadhar');
    // Ensure directory exists on runtime
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${uniqueSuffix}-${file.originalname}`);
  },
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only JPEG, PNG, WebP images, or PDF documents are allowed.'), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 } // 5 MB max
});

// Multer storage setup - saves Excel/CSV roster sheets inside /uploads/roster
const rosterStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '../uploads/roster');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${uniqueSuffix}-${file.originalname}`);
  },
});

const rosterFileFilter = (req, file, cb) => {
  const allowedExtensions = ['.xlsx', '.xls', '.csv'];
  const ext = path.extname(file.originalname).toLowerCase();
  const allowedMimeTypes = [
    'text/csv',
    'application/csv',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ];
  if (allowedExtensions.includes(ext) || allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only Excel (.xlsx, .xls) or CSV files are allowed.'), false);
  }
};

const uploadRoster = multer({
  storage: rosterStorage,
  fileFilter: rosterFileFilter,
  limits: { fileSize: 10 * 1024 * 1024 } // 10 MB max
});

// POST /api/worker/ocr
router.post('/ocr', protect, upload.single('aadharFile'), extractAadharOCR);

// POST /api/worker/excel-extract
router.post('/excel-extract', protect, uploadRoster.single('rosterFile'), extractExcelRoster);

// POST /api/worker
router.post('/', protect, createWorker);

// GET /api/worker/service/:serviceId
router.get('/service/:serviceId', protect, getWorkersByService);

// DELETE /api/worker/:id
router.delete('/:id', protect, deleteWorker);

module.exports = router;
