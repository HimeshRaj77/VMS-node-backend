const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const prisma = require('../prisma/client');

// Generate JWT
const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '30d' });
};

// @desc    Register a new admin
// @route   POST /api/admin/signup
// @access  Public
const signupAdmin = async (req, res) => {
  const { fullName, email, password } = req.body;

  if (!fullName || !email || !password) {
    return res.status(400).json({ message: 'Please fill all required fields' });
  }

  try {
    const existingAdmin = await prisma.admin.findUnique({ where: { email } });
    if (existingAdmin) {
      return res.status(400).json({ message: 'An admin account with this email already exists' });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const admin = await prisma.admin.create({
      data: {
        fullName,
        email,
        password: hashedPassword,
        role: 'admin',
      },
    });

    res.status(201).json({
      id: admin.id,
      fullName: admin.fullName,
      email: admin.email,
      token: generateToken(admin.id),
    });
  } catch (error) {
    console.error('Admin signup error:', error);
    res.status(500).json({ message: 'Server error during admin registration' });
  }
};

// @desc    Login admin
// @route   POST /api/admin/login
// @access  Public
const loginAdmin = async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: 'Please provide email and password' });
  }

  try {
    const admin = await prisma.admin.findUnique({ where: { email } });

    if (!admin || admin.role !== 'admin') {
      return res.status(401).json({ message: 'Invalid credentials or insufficient permissions' });
    }

    const isMatch = await bcrypt.compare(password, admin.password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    res.json({
      id: admin.id,
      fullName: admin.fullName,
      email: admin.email,
      token: generateToken(admin.id),
    });
  } catch (error) {
    console.error('Admin login error:', error);
    res.status(500).json({ message: 'Server error during admin login' });
  }
};

// @desc    Get all agencies (admin only)
// @route   GET /api/admin/agencies
// @access  Admin
const getAllAgencies = async (req, res) => {
  try {
    const agencies = await prisma.agency.findMany({
      select: {
        id: true,
        agencyName: true,
        contactPerson: true,
        email: true,
        phone: true,
        gstNumber: true,
        city: true,
        state: true,
        createdAt: true,
        quotation: { select: { id: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Map `quotation` to `_count: { quotations: q ? 1 : 0 }` for backwards compatibility with the admin UI
    const mappedAgencies = agencies.map(agency => {
      const copy = {
        ...agency,
        _count: {
          quotations: agency.quotation ? 1 : 0
        }
      };
      delete copy.quotation;
      return copy;
    });

    res.json(mappedAgencies);
  } catch (error) {
    console.error('Get agencies error:', error);
    res.status(500).json({ message: 'Server error fetching agencies' });
  }
};

// @desc    Get all quotations (admin only)
// @route   GET /api/admin/quotations
// @access  Admin
const getAllQuotations = async (req, res) => {
  try {
    const quotations = await prisma.quotation.findMany({
      include: {
        agency: {
          select: { agencyName: true, email: true, city: true },
        },
        StructuredQuotation: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    // Normalize StructuredQuotation to structuredQuotation camelCase for the frontend
    const response = quotations.map((q) => {
      const copy = {
        ...q,
        structuredQuotation: q.StructuredQuotation || null,
      };
      delete copy.StructuredQuotation;
      return copy;
    });

    res.json(response);
  } catch (error) {
    console.error('Get quotations error:', error);
    res.status(500).json({ message: 'Server error fetching quotations' });
  }
};

module.exports = { signupAdmin, loginAdmin, getAllAgencies, getAllQuotations };
