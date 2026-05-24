const axios = require('axios');
const path = require('path');
const fs = require('fs');
const prisma = require('../prisma/client');

const PYTHON_SERVICE_URL = process.env.PYTHON_SERVICE_URL || 'http://localhost:8000';

// @desc    Upload a quotation PDF and extract text via Python service
// @route   POST /api/quotation/upload
// @access  Protected (Agency)
const uploadQuotation = async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: 'No PDF file uploaded. Please attach a file with field name "pdf".' });
  }

  const { originalname, path: filePath } = req.file;

  // Resolve to absolute path for the Python service
  const absoluteFilePath = path.resolve(filePath);

  // Check and clean up any existing quotation of the agency to enforce the 1-to-1 constraint
  try {
    const existingQuotation = await prisma.quotation.findUnique({
      where: { agencyId: req.agency.id },
    });

    if (existingQuotation) {
      if (existingQuotation.uploadedFilePath) {
        const oldFilePath = path.resolve(existingQuotation.uploadedFilePath);
        if (fs.existsSync(oldFilePath)) {
          fs.unlinkSync(oldFilePath);
        }
      }
      await prisma.quotation.delete({
        where: { id: existingQuotation.id },
      });
    }
  } catch (cleanUpError) {
    console.error('Error cleaning up existing quotation:', cleanUpError);
  }

  // 1. Create a pending Quotation record in DB immediately
  let quotation;
  try {
    quotation = await prisma.quotation.create({
      data: {
        agencyId: req.agency.id,
        originalFileName: originalname,
        uploadedFilePath: filePath,
        extractionStatus: 'pending',
      },
    });
  } catch (dbError) {
    console.error('DB create error:', dbError);
    fs.unlink(filePath, () => {});
    return res.status(500).json({ message: 'Failed to save quotation record to database.' });
  }

  // 2. Call Python service — Step 1: Extract raw text from the PDF
  let extractedTextJson;
  try {
    const textResponse = await axios.post(`${PYTHON_SERVICE_URL}/extract-text`, {
      file_path: absoluteFilePath,
    }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 60000, // 60 seconds for PDF text extraction
    });

    if (!textResponse.data?.success) {
      throw new Error(textResponse.data?.error || 'Text extraction returned unsuccessful');
    }

    // The Python service returns { success: true, text: "<JSON string>" }
    // Parse the JSON string into an object
    extractedTextJson = JSON.parse(textResponse.data.text);
  } catch (textError) {
    console.error('Python text extraction error:', textError.message);

    await prisma.quotation.update({
      where: { id: quotation.id },
      data: { extractionStatus: 'failed' },
    }).catch(console.error);

    const errorDetails = textError.response?.data?.detail || textError.message;
    return res.status(502).json({
      message: 'PDF text extraction failed. Please check the Python service.',
      details: errorDetails,
      quotationId: quotation.id,
    });
  }

  // 3. Call Python service — Step 2: Structured AI extraction from raw text
  try {
    const structuredResponse = await axios.post(`${PYTHON_SERVICE_URL}/extract-structured-quotation`, {
      raw_data: extractedTextJson,
    }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 120000, // 2-minute timeout for AI processing
    });

    const { structured_data, performance } = structuredResponse.data;

    // 4. Update Quotation as success
    await prisma.quotation.update({
      where: { id: quotation.id },
      data: {
        extractionStatus: 'success',
      },
    });

    // 5. Build StructuredQuotation data from the AI response
    const quotationData = structured_data?.quotation_meta || {};
    await prisma.structuredQuotation.create({
      data: {
        id: quotation.id, // Use same ID as parent for easy lookup
        quotationId: quotation.id,
        structuredData: structured_data || {},
        vendorCompany: quotationData.agency_name || null,
        eventName: quotationData.event_name || null,
        grandTotal: quotationData.final_total_after_gst
          ? Math.round(quotationData.final_total_after_gst)
          : null,
        totalServices: quotationData.total_services || null,
        totalManpower: quotationData.total_manpower || null,
        extractionConfidence: quotationData.extraction_confidence || null,
        sourceFileName: originalname,
      },
    });

    return res.status(200).json({
      message: 'Quotation uploaded and extracted successfully',
      quotationId: quotation.id,
      originalFileName: originalname,
      structured_data,
      performance,
    });
  } catch (pyError) {
    console.error('Python structured extraction error:', pyError.message);

    // Mark quotation as failed so the user can see status
    await prisma.quotation.update({
      where: { id: quotation.id },
      data: {
        extractionStatus: 'failed',
      },
    }).catch(console.error);

    const errorDetails = pyError.response?.data?.detail || pyError.message;
    return res.status(502).json({
      message: 'PDF text was extracted but AI structuring failed. Please try again.',
      details: errorDetails,
      quotationId: quotation.id,
    });
  }
};

// @desc    Get quotation history for the logged-in agency
// @route   GET /api/quotation/history
// @access  Protected (Agency)
const getQuotationHistory = async (req, res) => {
  try {
    const quotations = await prisma.quotation.findMany({
      where: { agencyId: req.agency.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        originalFileName: true,
        extractionStatus: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    res.json(quotations);
  } catch (error) {
    console.error('Quotation history error:', error);
    res.status(500).json({ message: 'Failed to fetch quotation history' });
  }
};

// @desc    Get full details of a single quotation (with structured data)
// @route   GET /api/quotation/:id
// @access  Protected (Agency - own quotations only)
const getQuotationById = async (req, res) => {
  try {
    const quotation = await prisma.quotation.findUnique({
      where: { id: req.params.id },
      include: { StructuredQuotation: true },
    });

    if (!quotation) {
      return res.status(404).json({ message: 'Quotation not found' });
    }

    // Ensure agency can only see their own quotations
    if (quotation.agencyId !== req.agency.id) {
      return res.status(403).json({ message: 'Access denied: This quotation belongs to another agency' });
    }

    // Normalize the field name from Prisma's `StructuredQuotation` (PascalCase)
    // to JavaScript convention `structuredQuotation` (camelCase) for the frontend
    const response = {
      ...quotation,
      structuredQuotation: quotation.StructuredQuotation || null,
    };
    delete response.StructuredQuotation;

    res.json(response);
  } catch (error) {
    console.error('Get quotation error:', error);
    res.status(500).json({ message: 'Failed to fetch quotation details' });
  }
};

// @desc    Get the current active quotation for the logged-in agency (1-to-1)
// @route   GET /api/quotation/current
// @access  Protected (Agency)
const getCurrentQuotation = async (req, res) => {
  try {
    const quotation = await prisma.quotation.findUnique({
      where: { agencyId: req.agency.id },
      include: { StructuredQuotation: true },
    });

    if (!quotation) {
      return res.json(null);
    }

    const response = {
      ...quotation,
      structuredQuotation: quotation.StructuredQuotation || null,
    };
    delete response.StructuredQuotation;

    res.json(response);
  } catch (error) {
    console.error('Get current quotation error:', error);
    res.status(500).json({ message: 'Failed to fetch current quotation' });
  }
};



// @desc    Update a structured quotation (1-to-1)
// @route   PUT /api/quotation/:id
// @access  Protected (Agency - own only, or Admin)
const updateQuotation = async (req, res) => {
  const { id } = req.params;
  const { structuredData } = req.body;

  if (!structuredData) {
    return res.status(400).json({ message: 'No structured data provided for update.' });
  }

  try {
    const quotation = await prisma.quotation.findUnique({
      where: { id },
    });

    if (!quotation) {
      return res.status(404).json({ message: 'Quotation not found' });
    }

    // Check authorization: must be the owning agency or an admin
    if (quotation.agencyId !== req.agency.id && req.agency.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied: You are not authorized to modify this quotation.' });
    }

    const qData = structuredData.quotation_meta || {};

    // Concurrency safe PostgreSQL update of JSON data & denormalized fields
    const updatedStructured = await prisma.structuredQuotation.update({
      where: { quotationId: id },
      data: {
        structuredData,
        vendorCompany: qData.agency_name || null,
        eventName: qData.event_name || null,
        grandTotal: qData.final_total_after_gst ? Math.round(qData.final_total_after_gst) : (qData.grand_total_before_gst ? Math.round(qData.grand_total_before_gst) : null),
        totalManpower: qData.total_manpower || null,
        totalServices: qData.total_services || null,
      },
    });

    // Clean up structure for return
    const response = {
      ...quotation,
      structuredQuotation: updatedStructured,
    };
    delete response.StructuredQuotation;

    res.json({
      message: 'Quotation updated successfully in real-time',
      quotation: response
    });
  } catch (error) {
    console.error('Update structured quotation error:', error);
    res.status(500).json({ message: 'Failed to save changes. Concurrency or database validation error occurred.' });
  }
};

module.exports = { 
  uploadQuotation, 
  getQuotationHistory, 
  getQuotationById, 
  getCurrentQuotation,
  updateQuotation
};
