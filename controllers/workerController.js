const prisma = require('../prisma/client');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');

const PYTHON_SERVICE_URL = process.env.PYTHON_SERVICE_URL || 'http://localhost:8000';


// Array of mock Indian Aadhaar profiles for premium scanning simulation
const MOCK_AADHAAR_PROFILES = [
  {
    name: "Rajesh Kumar Sharma",
    aadharNumber: "5423 8912 0456",
    dob: "15/08/1988",
    gender: "Male",
    address: "H.No. 45, Gali No. 3, Laxmi Nagar, New Delhi - 110092"
  },
  {
    name: "Priya Balakrishnan",
    aadharNumber: "7841 9023 1156",
    dob: "22/11/1993",
    gender: "Female",
    address: "Flat 202, Gokulam Heights, J.P. Nagar, Bengaluru, Karnataka - 560078"
  },
  {
    name: "Amit Anil Deshmukh",
    aadharNumber: "3321 0498 7765",
    dob: "03/04/1985",
    gender: "Male",
    address: "Room 12, Chawl No. 4, Kurla East, Mumbai, Maharashtra - 400024"
  },
  {
    name: "Sunita Yadav",
    aadharNumber: "9012 4587 3341",
    dob: "10/06/1991",
    gender: "Female",
    address: "Village Post - Chauras, Tehsil - Gyanpur, Bhadohi, Uttar Pradesh - 221304"
  },
  {
    name: "Vikramjit Singh",
    aadharNumber: "6541 3321 9087",
    dob: "18/12/1987",
    gender: "Male",
    address: "B-12, Model Town, Phase 1, Ludhiana, Punjab - 141002"
  }
];

/**
 * Processes high-precision Aadhaar Card OCR extraction via Python Backend
 * POST /api/worker/ocr
 */
const extractAadharOCR = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'Aadhaar Card document image is required.' });
    }

    const aadharFrontPath = `/uploads/aadhar/${req.file.filename}`;

    const form = new FormData();
    form.append('file', fs.createReadStream(req.file.path));

    const response = await axios.post(`${PYTHON_SERVICE_URL}/api/aadhaar/extract`, form, {
      headers: {
        ...form.getHeaders()
      }
    });

    if (!response.data.success) {
      throw new Error("Python OCR returned failure");
    }

    const ocrData = response.data.data;

    return res.status(200).json({
      message: 'OCR extraction successful.',
      data: {
        name: ocrData.full_name,
        aadharNumber: ocrData.aadhaar_number,
        dob: ocrData.date_of_birth,
        gender: ocrData.gender,
        address: "Address Extraction Not Supported by Basic OCR",
        aadharFrontPath
      }
    });

  } catch (error) {
    console.error('Error during Aadhaar OCR:', error.message);
    const errorDetails = error.response?.data?.detail || error.message;
    return res.status(500).json({ message: 'Failed to process Aadhaar card scanning.', details: errorDetails });
  }
};

/**
 * Processes Excel sheet to extract worker roster records via Python Backend
 * POST /api/worker/excel-extract
 */
const extractExcelRoster = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'Excel roster spreadsheet is required.' });
    }

    const form = new FormData();
    form.append('file', fs.createReadStream(req.file.path));

    const response = await axios.post(`${PYTHON_SERVICE_URL}/api/excel/extract`, form, {
      headers: {
        ...form.getHeaders()
      }
    });

    if (!response.data.success) {
      throw new Error("Python Excel parser returned failure");
    }

    return res.status(200).json({
      message: 'Excel roster parsed successfully.',
      data: response.data.data,
      count: response.data.count
    });

  } catch (error) {
    console.error('Error during Excel roster extraction:', error.message);
    const errorDetails = error.response?.data?.detail || error.message;
    return res.status(500).json({ message: 'Failed to process Excel roster spreadsheet.', details: errorDetails });
  }
};


/**
 * Registers a worker inside a service department
 * POST /api/worker
 */
const createWorker = async (req, res) => {
  try {
    const { name, aadharNumber, dob, gender, serviceId, department, role, ratePerDay } = req.body;
    const agencyId = req.agency.id;

    if (!name || !aadharNumber || serviceId === undefined || serviceId === null || serviceId === '') {
      return res.status(400).json({ message: 'Name, Aadhaar Number, and Service ID are required.' });
    }

    const srvId = String(serviceId);

    // Format clean numeric Aadhaar
    const cleanAadhar = String(aadharNumber || '').replace(/\D/g, '');
    if (cleanAadhar.length !== 12 || isNaN(cleanAadhar)) {
      return res.status(400).json({ message: 'Aadhaar Number must be a valid 12-digit numeric sequence.' });
    }

    const parsedRate = parseInt(ratePerDay) || 300;

    // Record worker inside the database
    const worker = await prisma.worker.create({
      data: {
        name,
        aadharNumber: cleanAadhar,
        dob,
        gender,
        agencyId,
        serviceId: srvId,
        department: department || 'SECURITY',
        role: role || 'Security Guards',
        ratePerDay: parsedRate
      }
    });

    return res.status(201).json({
      message: 'Worker registered successfully.',
      worker
    });

  } catch (error) {
    console.error('Error creating worker record:', error);
    return res.status(500).json({ message: 'Failed to save worker record in database.' });
  }
};

/**
 * Fetches all workers enrolled under a service
 * GET /api/worker/service/:serviceId
 */
const getWorkersByService = async (req, res) => {
  try {
    const { serviceId } = req.params;
    const agencyId = req.agency.id;

    const workers = await prisma.worker.findMany({
      where: {
        serviceId,
        agencyId
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    return res.status(200).json(workers);

  } catch (error) {
    console.error('Error listing service workers:', error);
    return res.status(500).json({ message: 'Failed to fetch workers list.' });
  }
};

/**
 * Removes a worker record
 * DELETE /api/worker/:id
 */
const deleteWorker = async (req, res) => {
  try {
    const { id } = req.params;
    const agencyId = req.agency.id;

    // Verify ownership
    const worker = await prisma.worker.findFirst({
      where: {
        id,
        agencyId
      }
    });

    if (!worker) {
      return res.status(404).json({ message: 'Worker record not found or unauthorized.' });
    }

    await prisma.worker.delete({
      where: {
        id
      }
    });

    return res.status(200).json({ message: 'Worker record successfully removed.' });

  } catch (error) {
    console.error('Error deleting worker record:', error);
    return res.status(500).json({ message: 'Failed to delete worker record.' });
  }
};

module.exports = {
  extractAadharOCR,
  extractExcelRoster,
  createWorker,
  getWorkersByService,
  deleteWorker
};
