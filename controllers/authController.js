const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const prisma = require('../prisma/client');

// Generate JWT
const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '30d' });
};

// @desc    Register a new agency
// @route   POST /api/auth/register
// @access  Public
const registerAgency = async (req, res) => {
  const { agencyName, contactPerson, email, phone, password, gstNumber, address, city, state } = req.body;

  if (!agencyName || !contactPerson || !email || !phone || !password || !gstNumber || !address || !city || !state) {
    return res.status(400).json({ message: 'Please fill all required fields' });
  }

  try {
    const existingAgency = await prisma.agency.findUnique({ where: { email } });
    if (existingAgency) {
      return res.status(400).json({ message: 'An account with this email already exists' });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const agency = await prisma.agency.create({
      data: {
        agencyName,
        contactPerson,
        email,
        phone,
        password: hashedPassword,
        gstNumber,
        address,
        city,
        state,
      },
    });

    res.status(201).json({
      id: agency.id,
      agencyName: agency.agencyName,
      email: agency.email,
      token: generateToken(agency.id),
    });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ message: 'Server error during registration' });
  }
};

// @desc    Login agency
// @route   POST /api/auth/login
// @access  Public
const   loginAgency = async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: 'Please provide email and password' });
  }

  try {
    const agency = await prisma.agency.findUnique({ where: { email } });

    if (!agency) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    const isMatch = await bcrypt.compare(password, agency.password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    res.json({
      id: agency.id,
      agencyName: agency.agencyName,
      email: agency.email,
      token: generateToken(agency.id),
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Server error during login' });
  }
};

module.exports = { registerAgency, loginAgency };
