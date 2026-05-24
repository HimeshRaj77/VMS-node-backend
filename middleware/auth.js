const jwt = require('jsonwebtoken');
const prisma = require('../prisma/client');

const protect = async (req, res, next) => {
  let token;

  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer')
  ) {
    try {
      token = req.headers.authorization.split(' ')[1];

      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      req.agency = await prisma.agency.findUnique({
        where: { id: decoded.id },
      });

      if (!req.agency) {
        return res.status(401).json({ message: 'User not found' });
      }

      // Hide password
      delete req.agency.password;

      return next();
    } catch (error) {
      console.error(error);
      return res.status(401).json({ message: 'Not authorized, token failed' });
    }
  }

  return res.status(401).json({ message: 'Not authorized, no token' });
};

module.exports = { protect };
