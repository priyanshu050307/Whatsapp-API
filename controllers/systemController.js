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
    serverUptime: uptime,
    pendingQueue: queueLength,
    statsToday: stats,
    credits: {
      allocated: balance ? balance.allocated_credits : 0,
      used: balance ? balance.used_credits : 0,
      remaining: balance ? balance.remaining_credits : 0,
      todayUsage: usageStats ? usageStats.today : 0,
      monthlyUsage: usageStats ? usageStats.month : 0
    },
    nodeVersion: process.version,
    platformOS: process.platform
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
      reason: err.message
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
      reason: err.message
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
      reason: err.message
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
      [API_USERNAME, API_PASSWORD, API_CHANNEL_ID, tenantId],
      function(err) {
        if (err) {
          return res.status(500).json({
            status: 'failed',
            reason: err.message
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
      reason: err.message || 'Failed to update tenant credentials'
    });
  }
};

/**
 * POST /api/tenants
 * Registers a new tenant in the system (master admin only)
 */
exports.registerTenant = async (req, res) => {
  const adminPasswordHeader = req.headers['x-admin-password'] || req.body.adminPassword;
  const expectedAdminPassword = process.env.MASTER_ADMIN_PASSWORD || 'master_admin_pass';

  if (!adminPasswordHeader || adminPasswordHeader.toString() !== expectedAdminPassword.toString()) {
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

  try {
    const success = await db.addTenant(tenantId, username, password, channelId);
    if (!success) {
      return res.status(409).json({
        status: 'failed',
        reason: 'Failed to create tenant. The tenantId or username might already exist.'
      });
    }

    // Initialize the WhatsApp Web instance for the new tenant
    whatsappService.initClient(tenantId);

    return res.status(201).json({
      status: 'success',
      message: `Tenant '${tenantId}' registered successfully. WhatsApp session initialization started in background.`
    });
  } catch (err) {
    return res.status(500).json({
      status: 'failed',
      reason: err.message || 'Failed to register tenant'
    });
  }
};

/**
 * POST /api/admin/credits/recharge
 * Allocates credits to a tenant (master admin only)
 */
exports.rechargeCredits = async (req, res) => {
  const adminPasswordHeader = req.headers['x-admin-password'] || req.body.adminPassword;
  const expectedAdminPassword = process.env.MASTER_ADMIN_PASSWORD || 'master_admin_pass';

  if (!adminPasswordHeader || adminPasswordHeader.toString() !== expectedAdminPassword.toString()) {
    return res.status(403).json({
      status: 'failed',
      reason: 'Forbidden: Invalid Master Admin Password'
    });
  }

  const { tenantId, amount, notes } = req.body;
  const creditsAmount = parseInt(amount);

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
      reason: err.message || 'Failed to recharge credits'
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
