const jwt = require('jsonwebtoken');
const prisma = require('../../prisma/client');

const adminProtect = async (req, res, next) => {
  let token;

  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer')
  ) {
    try {
      token = req.headers.authorization.split(' ')[1];

      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      const admin = await prisma.admin.findUnique({
        where: { id: decoded.id },
      });

      if (!admin || admin.role !== 'admin') {
        return res.status(401).json({ message: 'Not authorized as an admin' });
      }

      delete admin.password;
      req.admin = admin;

      return next();
    } catch (error) {
      console.error(error);
      return res.status(401).json({ message: 'Not authorized, token failed' });
    }
  }

  return res.status(401).json({ message: 'Not authorized, no token' });
};

module.exports = { adminProtect };
