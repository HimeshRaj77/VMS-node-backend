const { PrismaClient } = require('@prisma/client');

// Singleton pattern to avoid creating multiple connections
const globalForPrisma = global;

const prisma = globalForPrisma.prisma || new PrismaClient({
  log: ['error'],
});

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

module.exports = prisma;
