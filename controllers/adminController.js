const db = require('../services/db');
const whatsappService = require('../services/whatsapp');
const logger = require('../services/logger');

/**
 * GET /api/admin/clients
 * Lists all registered clients with search filtering and live statistics
 */
exports.getClients = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  try {
    const clients = await db.getAllClientsWithDetails();
    const search = req.query.search ? req.query.search.toLowerCase().trim() : '';

    const now = new Date();

    const formattedClients = clients.map(client => {
      const expiry = client.trial_expiry_date ? new Date(client.trial_expiry_date) : now;
      const remainingDays = Math.max(0, Math.ceil((expiry - now) / (1000 * 60 * 60 * 24)));
      const waState = whatsappService.getClientState(client.tenant_id);

      return {
        tenant_id: client.tenant_id,
        name: client.name || client.username,
        email: client.email || 'N/A',
        google_id: client.google_id,
        picture: client.picture,
        created_at: client.created_at || client.signup_date,
        signup_date: client.signup_date || client.created_at,
        trial_start_date: client.trial_start_date || client.signup_date,
        trial_expiry_date: client.trial_expiry_date,
        remaining_trial_days: remainingDays,
        account_status: client.account_status || 'trial',
        plan_status: client.plan_status || 'free_trial',
        whatsapp_status: waState,
        last_login_at: client.last_login_at || 'Never',
        total_messages_sent: client.total_messages_sent || 0,
        allocated_credits: client.allocated_credits || 0,
        used_credits: client.used_credits || 0,
        remaining_credits: client.remaining_credits || 0,
        api_credentials: {
          username: client.username,
          password: client.password,
          channel_id: client.channel_id
        }
      };
    });

    const filteredClients = search
      ? formattedClients.filter(c => 
          c.email.toLowerCase().includes(search) || 
          c.name.toLowerCase().includes(search) || 
          c.tenant_id.toLowerCase().includes(search)
        )
      : formattedClients;

    return res.status(200).json({
      status: 'success',
      totalClients: filteredClients.length,
      clients: filteredClients
    });
  } catch (err) {
    logger.error('Error fetching admin clients: %s', err.message);
    return res.status(500).json({
      status: 'failed',
      reason: err.message || 'Failed to retrieve clients list'
    });
  }
};

/**
 * GET /api/admin/clients/:tenantId
 * Retrieves detailed client profile by tenantId
 */
exports.getClientDetails = async (req, res) => {
  const { tenantId } = req.params;
  try {
    const client = await db.getTenantById(tenantId);
    if (!client) {
      return res.status(404).json({ status: 'failed', reason: `Client '${tenantId}' not found.` });
    }

    const credits = await db.getCreditBalance(tenantId);
    const usage = await db.getUsageStats(tenantId);
    const waState = whatsappService.getClientState(tenantId);
    const waInfo = whatsappService.getClientInfo(tenantId);
    const now = new Date();
    const expiry = client.trial_expiry_date ? new Date(client.trial_expiry_date) : now;
    const remainingDays = Math.max(0, Math.ceil((expiry - now) / (1000 * 60 * 60 * 24)));

    return res.status(200).json({
      status: 'success',
      client: {
        ...client,
        remaining_trial_days: remainingDays,
        whatsapp: {
          state: waState,
          number: waInfo.number,
          pushname: waInfo.pushname,
          platform: waInfo.platform
        },
        credits,
        usage
      }
    });
  } catch (err) {
    return res.status(500).json({ status: 'failed', reason: err.message });
  }
};

/**
 * POST /api/admin/clients/:tenantId/status
 * Updates client account and plan status (e.g. active, trial, expired, suspended)
 */
exports.updateClientStatus = async (req, res) => {
  const { tenantId } = req.params;
  const { accountStatus, planStatus } = req.body;

  if (!accountStatus) {
    return res.status(400).json({ status: 'failed', reason: 'accountStatus parameter is required.' });
  }

  const validStatuses = ['active', 'trial', 'expired', 'suspended'];
  if (!validStatuses.includes(accountStatus.toLowerCase())) {
    return res.status(400).json({
      status: 'failed',
      reason: `Invalid accountStatus. Must be one of: ${validStatuses.join(', ')}`
    });
  }

  try {
    const client = await db.getTenantById(tenantId);
    if (!client) {
      return res.status(404).json({ status: 'failed', reason: `Client '${tenantId}' not found.` });
    }

    const success = await db.updateTenantStatus(tenantId, accountStatus.toLowerCase(), planStatus || accountStatus.toLowerCase());
    if (success) {
      logger.info(`Admin updated status for client ${tenantId} to ${accountStatus}`);
      return res.status(200).json({
        status: 'success',
        message: `Client status updated to '${accountStatus}'.`
      });
    }
    return res.status(500).json({ status: 'failed', reason: 'Database update failed.' });
  } catch (err) {
    return res.status(500).json({ status: 'failed', reason: err.message });
  }
};

/**
 * POST /api/admin/clients/:tenantId/trial
 * Extends or changes client trial expiry date
 */
exports.extendTrial = async (req, res) => {
  const { tenantId } = req.params;
  const { days, expiryDate } = req.body;

  let newExpiryDateStr = expiryDate;

  if (!newExpiryDateStr && days) {
    const daysToAdd = parseInt(days, 10);
    if (isNaN(daysToAdd)) {
      return res.status(400).json({ status: 'failed', reason: 'Days must be a valid number.' });
    }
    const client = await db.getTenantById(tenantId);
    if (!client) {
      return res.status(404).json({ status: 'failed', reason: `Client '${tenantId}' not found.` });
    }
    
    // Extend from current expiry or now
    const baseDate = client.trial_expiry_date ? new Date(client.trial_expiry_date) : new Date();
    const currentDate = baseDate < new Date() ? new Date() : baseDate;
    currentDate.setDate(currentDate.getDate() + daysToAdd);
    newExpiryDateStr = currentDate.toISOString().replace('T', ' ').substring(0, 19);
  }

  if (!newExpiryDateStr) {
    return res.status(400).json({ status: 'failed', reason: 'Provide either days to add or expiryDate string.' });
  }

  try {
    const success = await db.updateTrialExpiry(tenantId, newExpiryDateStr);
    if (success) {
      logger.info(`Admin extended trial for client ${tenantId} to ${newExpiryDateStr}`);
      return res.status(200).json({
        status: 'success',
        message: `Trial expiry date successfully updated to ${newExpiryDateStr}`,
        newExpiryDate: newExpiryDateStr
      });
    }
    return res.status(500).json({ status: 'failed', reason: 'Failed to update trial expiry date in database.' });
  } catch (err) {
    return res.status(500).json({ status: 'failed', reason: err.message });
  }
};

/**
 * POST /api/admin/clients/:tenantId/credits
 * Recharges message credits for a client
 */
exports.rechargeCredits = async (req, res) => {
  const { tenantId } = req.params;
  const { amount, notes } = req.body;

  const creditsAmount = parseInt(amount, 10);
  if (isNaN(creditsAmount) || creditsAmount <= 0) {
    return res.status(400).json({ status: 'failed', reason: 'Amount must be a positive integer.' });
  }

  try {
    const client = await db.getTenantById(tenantId);
    if (!client) {
      return res.status(404).json({ status: 'failed', reason: `Client '${tenantId}' not found.` });
    }

    const success = await db.addCredits(tenantId, creditsAmount, notes || 'Admin Recharge');
    if (success) {
      logger.info(`Admin allocated ${creditsAmount} credits to client ${tenantId}`);
      return res.status(200).json({
        status: 'success',
        message: `Successfully allocated ${creditsAmount} credits to ${client.email || tenantId}.`
      });
    }
    return res.status(500).json({ status: 'failed', reason: 'Credit allocation failed.' });
  } catch (err) {
    return res.status(500).json({ status: 'failed', reason: err.message });
  }
};

/**
 * POST /api/admin/clients/:tenantId/whatsapp/logout
 * Remotely disconnects/logs out WhatsApp session for client
 */
exports.logoutClientSession = async (req, res) => {
  const { tenantId } = req.params;
  try {
    const client = await db.getTenantById(tenantId);
    if (!client) {
      return res.status(404).json({ status: 'failed', reason: `Client '${tenantId}' not found.` });
    }

    await whatsappService.logoutSession(tenantId);
    logger.info(`Admin logged out WhatsApp session for client ${tenantId}`);
    return res.status(200).json({
      status: 'success',
      message: `WhatsApp session for ${client.email || tenantId} disconnected successfully.`
    });
  } catch (err) {
    return res.status(500).json({ status: 'failed', reason: err.message });
  }
};

/**
 * DELETE /api/admin/clients/:tenantId
 * Admin endpoint to permanently delete a client account and all session/storage data
 */
exports.deleteClientAccount = async (req, res) => {
  const { tenantId } = req.params;

  // Security guard: Prevent deletion of administrator accounts
  if (tenantId === 'admin') {
    return res.status(403).json({
      status: 'failed',
      reason: 'Forbidden: Cannot delete the Master Administrator account.'
    });
  }

  try {
    const client = await db.getTenantById(tenantId);
    if (!client) {
      return res.status(404).json({
        status: 'failed',
        reason: `Client tenant '${tenantId}' does not exist or has already been deleted.`
      });
    }

    if (client.is_admin === 1) {
      return res.status(403).json({
        status: 'failed',
        reason: 'Forbidden: Cannot delete the Master Administrator account.'
      });
    }

    // 1. WhatsApp session & disk storage cleanup
    await whatsappService.deleteSessionData(tenantId);

    // 2. Transactional Database record deletion
    const success = await db.deleteTenant(tenantId);

    if (success) {
      // Audit log event
      logger.warn('[AUDIT LOG] Master Admin permanently deleted tenant account %s (%s)', tenantId, client.email || 'N/A');

      return res.status(200).json({
        status: 'success',
        message: `Tenant account '${client.email || tenantId}' and all associated sessions/data were permanently deleted.`
      });
    } else {
      return res.status(500).json({
        status: 'failed',
        reason: 'Failed to perform database deletion transaction.'
      });
    }
  } catch (err) {
    logger.error('Error in admin deleteClientAccount: %s', err.message);
    return res.status(500).json({ status: 'failed', reason: err.message });
  }
};

