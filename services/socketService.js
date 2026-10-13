const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const config = require('../config/config');
const logger = require('./logger');

let io = null;

function init(server) {
  io = new Server(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST']
    }
  });

  // Socket Authentication & Room Scoping Middleware
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (!token) {
      logger.warn('Socket connection rejected: Missing authorization token.');
      return next(new Error('Authentication error: Token required'));
    }

    try {
      const activeConfig = config.get();
      const decoded = jwt.verify(token, activeConfig.JWT_SECRET);
      socket.user = decoded;
      socket.tenantId = decoded.tenantId || decoded.tenant_id;
      if (!socket.tenantId) {
        return next(new Error('Authentication error: Missing tenantId in token'));
      }
      next();
    } catch (err) {
      logger.warn('Socket connection rejected: Invalid JWT token - %s', err.message);
      next(new Error('Authentication error: Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    const tenantId = socket.tenantId;
    logger.info(`[Socket] Authenticated client connected for tenant '${tenantId}' (Socket ID: ${socket.id})`);

    // Join room scoped ONLY to this tenant for 100% Multi-Tenant Isolation
    socket.join(tenantId);

    socket.on('disconnect', (reason) => {
      logger.info(`[Socket] Client disconnected for tenant '${tenantId}' (Reason: ${reason})`);
    });
  });

  return io;
}

function getIo() {
  return io;
}

/**
 * Emits a real-time event ONLY to clients belonging to a specific tenant ID room.
 */
function emitToTenant(tenantId, event, payload) {
  if (io) {
    io.to(tenantId).emit(event, payload);
  }
}

module.exports = {
  init,
  getIo,
  emitToTenant
};
