// NOTE: TLS verification is intentionally ENABLED (default). Never disable it in production.
// If you encounter self-signed certificate issues with an internal proxy, fix the certificate
// instead of disabling TLS verification globally.

const express = require('express');
const http = require('http');
const path = require('path');
const config = require('./config/config');
const logger = require('./services/logger');
const security = require('./middleware/security');
const messageRoutes = require('./routes/messageRoutes');
const systemRoutes = require('./routes/systemRoutes');
const authRoutes = require('./routes/authRoutes');
const adminRoutes = require('./routes/adminRoutes');
const clientRoutes = require('./routes/clientRoutes');
const chatRoutes = require('./routes/chatRoutes');
const whatsappService = require('./services/whatsapp');
const socketService = require('./services/socketService');
const db = require('./services/db');
const multer = require('multer');
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024, // 25 MB max file upload
    files: 1,
    fieldSize: 2 * 1024 * 1024  // 2 MB max text field
  }
});

// Global error handlers to capture Puppeteer/whatsapp-web.js detached frame exceptions and prevent crashes
process.on('uncaughtException', (err) => {
  logger.error('UNCAUGHT EXCEPTION: %s', err.stack || err.message);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('UNHANDLED REJECTION: %s', reason ? (reason.stack || reason) : 'No details');
});

const app = express();
const server = http.createServer(app);
const activeConfig = config.get();
const PORT = activeConfig.PORT || 3000;

// Initialize Socket.IO Real-Time Engine
socketService.init(server);

// 1. Setup security middlewares
app.use(security.helmet);
app.use(security.cors);

// 2. Setup parsing middlewares with explicit size limits to prevent memory exhaustion DoS
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(upload.any());

// 3. Setup rate limits specifically on API and admin paths (protects dashboard static files from being rate limited)
app.use('/message', security.limiter);
app.use('/api', security.limiter);
app.use('/status', security.limiter);
app.use('/qr', security.limiter);
app.use('/logout', security.limiter);
app.use('/restart', security.limiter);

// 4. Serve dashboard frontend files
app.use(express.static(path.join(__dirname, 'public')));

// Request Logger (redacts sensitive credentials and tokens from query strings)
app.use((req, res, next) => {
  const safeUrl = (req.url || '').replace(/([?&](?:password|pass|pwd|token|adminPassword)=)[^&]*/gi, '$1[REDACTED]');
  logger.info(`INCOMING REQUEST: ${req.method} ${safeUrl} - Content-Type: ${req.headers['content-type']}`);
  next();
});

// 5. Register routes
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/client', clientRoutes);
app.use('/api/whatsapp', chatRoutes); // Mounts live WhatsApp Web chat routes
app.use('/message', messageRoutes);   // Mounts /message/new GET and POST
app.use('/', systemRoutes);            // Mounts /status, /qr, /logout, /restart, /api/logs, /api/config

// Fallback to index.html for dashboard routing
app.get('*', (req, res, next) => {
  const isApiRequest = req.path.startsWith('/api') || 
                       req.path.startsWith('/message') || 
                       ['/status', '/qr', '/logout', '/restart'].includes(req.path);
  
  if (isApiRequest) {
    return next();
  }
  
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 6. Handle resource not found
app.use((req, res, next) => {
  res.status(404).json({
    status: 'failed',
    reason: 'Endpoint not found'
  });
});

// 7. Global Exception Handler
app.use((err, req, res, next) => {
  logger.error('Global application error caught: %s', err.stack);
  res.status(500).json({
    status: 'failed',
    reason: 'Internal Server Error'
  });
});

// 8. Start HTTP Server and DB
if (require.main === module) {
  db.init().then(() => {
    server.listen(PORT, async () => {
      logger.info(`=============================================================`);
      logger.info(` WhatsApp REST API Gateway running on http://localhost:${PORT}`);
      logger.info(` Real-Time Socket.IO Web Chat Engine active for all tenants`);
      logger.info(`=============================================================`);
      
      // Seed/Bootstrap default tenant if no tenants exist
      try {
        const tenants = await db.getAllTenants();
        if (tenants.length === 0) {
          logger.info('No tenants found in database. Seeding default tenant from environment configuration...');
          await db.addTenant('default', activeConfig.API_USERNAME, activeConfig.API_PASSWORD, activeConfig.API_CHANNEL_ID);
        }
        
        // Initialize WhatsApp Web clients
        const activeTenants = await db.getAllTenants();
        whatsappService.initAllClients(activeTenants);
      } catch (err) {
        logger.error('Failed to seed default tenant or initialize clients on startup: %s', err.message);
      }
    });

    // 9. Handle System Signals Gracefully
    process.on('SIGINT', gracefulShutdown);
    process.on('SIGTERM', gracefulShutdown);
  }).catch(err => {
    logger.error('Failed to initialize database on startup: %s', err.message);
    process.exit(1);
  });
}

async function gracefulShutdown() {
  logger.warn('Termination signal received. Starting graceful shutdown sequence...');
  
  try {
    const tenants = await db.getAllTenants();
    for (const tenant of tenants) {
      await whatsappService.destroyClient(tenant.tenant_id);
    }
  } catch (err) {
    logger.error('Error during client destruction in graceful shutdown: %s', err.message);
  }
  
  if (server) {
    server.close(() => {
      logger.info('HTTP server closed. WhatsApp REST Gateway process exited successfully.');
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
}

module.exports = { app, server, gracefulShutdown };
