const whatsappService = require('../services/whatsapp');
const logService = require('../services/logService');
const config = require('../config/config');
const db = require('../services/db');

/**
 * GET /status
 * Returns connection parameters, platform details, and transaction statistics for the tenant
 */
exports.getStatus = async (req, res) => {
  const tenantId = req.tenant.tenant_id;
  const state = whatsappService.getClientState(tenantId);
  const info = whatsappService.getClientInfo(tenantId);
  const uptime = whatsappService.getUptime(tenantId);
  const queueLength = whatsappService.getQueueLength(tenantId);
  const stats = await logService.getStatsToday(tenantId);
  
  // Fetch credit balance and detailed usage statistics
  const balance = await db.getCreditBalance(tenantId);
  const usageStats = await db.getUsageStats(tenantId);

  return res.status(200).json({
    status: 'success',
    clientState: state,
    whatsappNumber: info.number,
    pushName: info.pushname,
    platform: info.platform,
    wwebVersion: info.wwebVersion,
    libraryVersion: whatsappService.getLibraryVersionStatus ? whatsappService.getLibraryVersionStatus() : null,
    serverUptime: uptime,
    pendingQueue: queueLength,
    statsToday: stats,
    credits: {
      allocated: balance ? balance.allocated_credits : 0,
      used: balance ? balance.used_credits : 0,
      remaining: balance ? balance.remaining_credits : 0,
      todayUsage: usageStats ? usageStats.today : 0,
      monthlyUsage: usageStats ? usageStats.month : 0
    }
  });
};

/**
 * GET /qr
 * Returns current login QR code for the tenant. If content-negotiation suggests image or query is raw=true, returns raw PNG.
 */
exports.getQrCode = (req, res) => {
  const tenantId = req.tenant.tenant_id;
  const qrData = whatsappService.getQrCodeData(tenantId);
  
  if (!qrData) {
    return res.status(404).json({
      status: 'failed',
      reason: 'QR code is not active. The WhatsApp client is already connected or loading.'
    });
  }

  // Handle request for raw image download/display (useful for simple integrations)
  const acceptHeader = req.headers.accept || '';
  if (acceptHeader.includes('image/*') || acceptHeader.includes('image/png') || req.query.raw === 'true') {
    try {
      const base64Data = qrData.replace(/^data:image\/png;base64,/, '');
      const img = Buffer.from(base64Data, 'base64');
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': img.length
      });
      return res.end(img);
    } catch (err) {
      return res.status(500).json({ status: 'failed', reason: 'Error rendering QR code image' });
    }
  }

  // Default: JSON payload containing data URL
  return res.status(200).json({
    status: 'success',
    qr: qrData
  });
};

/**
 * GET /logout
 * Gracefully logs out the active session for the tenant, clears credentials, and re-initializes client.
 */
exports.logout = async (req, res) => {
  const tenantId = req.tenant.tenant_id;
  try {
    const success = await whatsappService.logoutSession(tenantId);
    if (success) {
      return res.status(200).json({
        status: 'success',
        message: 'WhatsApp Session logged out and persistent credentials cleared.'
      });
    } else {
      return res.status(500).json({
        status: 'failed',
        reason: 'Could not perform standard logout, but client session has been forced shut.'
      });
    }
  } catch (err) {
    return res.status(500).json({
      status: 'failed',
      reason: 'Error logging out WhatsApp session'
    });
  }
};

/**
 * GET /restart
 * Triggers a soft client reboot for the tenant (destroys Puppeteer session and launches fresh).
 */
exports.restart = async (req, res) => {
  const tenantId = req.tenant.tenant_id;
  try {
    await whatsappService.restartClient(tenantId);
    return res.status(200).json({
      status: 'success',
      message: 'WhatsApp Web Client restart sequence initiated.'
    });
  } catch (err) {
    return res.status(500).json({
      status: 'failed',
      reason: 'Error restarting WhatsApp session'
    });
  }
};

/**
 * GET /api/logs
 * Fetches recent 100 transaction log records for the tenant
 */
exports.getLogs = async (req, res) => {
  const tenantId = req.tenant.tenant_id;
  try {
    const logs = await logService.getRecentLogs(tenantId, 100);
    return res.status(200).json({
      status: 'success',
      logs
    });
  } catch (err) {
    return res.status(500).json({
      status: 'failed',
      reason: 'Failed to retrieve logs'
    });
  }
};

/**
 * GET /api/config
 * Retrieves configuration values for settings UI (username, password, etc.) scoped to the tenant
 */
exports.getConfig = (req, res) => {
  const tenant = req.tenant;
  const activeConfig = config.get();
  return res.status(200).json({
    status: 'success',
    config: {
      API_USERNAME: tenant.username,
      API_PASSWORD: tenant.password,
      API_CHANNEL_ID: tenant.channel_id,
      PORT: activeConfig.PORT,
      RATE_LIMIT_MAX: activeConfig.RATE_LIMIT_MAX,
      PUPPETEER_HEADLESS: activeConfig.PUPPETEER_HEADLESS,
      USE_SQLITE: activeConfig.USE_SQLITE
    }
  });
};

/**
 * POST /api/config
 * Saves updated configurations for the specific tenant to the SQLite database
 */
exports.saveConfig = async (req, res) => {
  const tenantId = req.tenant.tenant_id;
  const { API_USERNAME, API_PASSWORD, API_CHANNEL_ID } = req.body;

  if (!API_USERNAME || !API_PASSWORD || !API_CHANNEL_ID) {
    return res.status(400).json({
      status: 'failed',
      reason: 'API Username, Password, and Channel ID parameters are mandatory.'
    });
  }

  if (!db.isAvailable() || !db.dbInstance) {
    return res.status(503).json({
      status: 'failed',
      reason: 'Database service is currently unavailable. Configuration update failed.'
    });
  }

  try {
    db.dbInstance.run(
      `UPDATE tenants SET username = ?, password = ?, channel_id = ? WHERE tenant_id = ?`,
      [String(API_USERNAME).trim(), String(API_PASSWORD).trim(), String(API_CHANNEL_ID).trim(), tenantId],
      function(err) {
        if (err) {
          return res.status(500).json({
            status: 'failed',
            reason: 'Failed to update tenant credentials'
          });
        }
        return res.status(200).json({
          status: 'success',
          message: 'Tenant credentials updated successfully. Please restart the client to apply changes.'
        });
      }
    );
  } catch (err) {
    return res.status(500).json({
      status: 'failed',
      reason: 'Failed to update tenant credentials'
    });
  }
};

/**
 * POST /api/tenants
 * Registers a new tenant in the system (master admin only, protected by adminAuth middleware)
 */
exports.registerTenant = async (req, res) => {
  if (!req.isAdmin) {
    return res.status(403).json({
      status: 'failed',
      reason: 'Forbidden: Invalid Master Admin Password'
    });
  }

  const { tenantId, username, password, channelId } = req.body;

  if (!tenantId || !username || !password || !channelId) {
    return res.status(400).json({
      status: 'failed',
      reason: 'Missing required parameters. tenantId, username, password, and channelId are required.'
    });
  }

  // Validate tenantId format to prevent path traversal in session/log file paths
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(String(tenantId).trim())) {
    return res.status(400).json({
      status: 'failed',
      reason: 'Validation Error: tenantId must contain only alphanumeric characters, hyphens, or underscores (max 64 chars).'
    });
  }

  // Validate that channelId is numeric and at most 8 digits for Busy integration compatibility
  const isNumeric = /^\d+$/.test(String(channelId).trim());
  if (!isNumeric || String(channelId).trim().length > 8) {
    return res.status(400).json({
      status: 'failed',
      reason: 'Validation Error: channelId must be a numeric value of at most 8 digits.'
    });
  }

  try {
    const cleanTenantId = String(tenantId).trim();
    const success = await db.addTenant(cleanTenantId, String(username).trim(), String(password).trim(), String(channelId).trim());
    if (!success) {
      return res.status(409).json({
        status: 'failed',
        reason: 'Failed to create tenant. The tenantId or username might already exist.'
      });
    }

    // Initialize the WhatsApp Web instance for the new tenant
    whatsappService.initClient(cleanTenantId);

    return res.status(201).json({
      status: 'success',
      message: `Tenant '${cleanTenantId}' registered successfully. WhatsApp session initialization started in background.`
    });
  } catch (err) {
    return res.status(500).json({
      status: 'failed',
      reason: 'Failed to register tenant'
    });
  }
};

/**
 * POST /api/admin/credits/recharge
 * Allocates credits to a tenant (master admin only, protected by adminAuth middleware)
 */
exports.rechargeCredits = async (req, res) => {
  if (!req.isAdmin) {
    return res.status(403).json({
      status: 'failed',
      reason: 'Forbidden: Invalid Master Admin Password'
    });
  }

  const { tenantId, amount, notes } = req.body;
  const creditsAmount = parseInt(amount, 10);

  if (!tenantId || isNaN(creditsAmount) || creditsAmount <= 0) {
    return res.status(400).json({
      status: 'failed',
      reason: 'Missing or invalid parameters. tenantId and positive amount are required.'
    });
  }

  try {
    const tenant = await db.getTenantById(tenantId);
    if (!tenant) {
      return res.status(404).json({
        status: 'failed',
        reason: `Tenant '${tenantId}' does not exist.`
      });
    }

    const success = await db.addCredits(tenantId, creditsAmount, notes);
    if (!success) {
      return res.status(500).json({
        status: 'failed',
        reason: 'Failed to allocate credits in database.'
      });
    }

    return res.status(200).json({
      status: 'success',
      message: `Successfully allocated ${creditsAmount} credits to tenant '${tenantId}'.`
    });
  } catch (err) {
    return res.status(500).json({
      status: 'failed',
      reason: 'Failed to recharge credits'
    });
  }
};

/**
 * GET /api/credits/history
 * Returns the recharge history log for the authenticated tenant
 */
exports.getRechargeHistory = async (req, res) => {
  const tenantId = req.tenant.tenant_id;
  try {
    const logs = await db.getRechargeHistory(tenantId);
    return res.status(200).json({
      status: 'success',
      logs
    });
  } catch (err) {
    return res.status(500).json({
      status: 'failed',
      reason: err.message
    });
  }
};
