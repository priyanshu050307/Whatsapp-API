const db = require('../services/db');
const whatsappService = require('../services/whatsapp');
const logService = require('../services/logService');

/**
 * GET /api/client/dashboard
 * Aggregates all live dashboard metrics for the authenticated client:
 * - Profile and Gmail account details
 * - 15-day Trial / Plan status and countdown
 * - WhatsApp connection status and QR code
 * - Credits and message usage statistics
 * - Recent transaction logs
 */
exports.getDashboard = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  const tenant = req.tenant;
  const tenantId = tenant.tenant_id;

  try {
    const waState = whatsappService.getClientState(tenantId);
    const waInfo = whatsappService.getClientInfo(tenantId);
    const qrData = whatsappService.getQrCodeData(tenantId);
    const balance = await db.getCreditBalance(tenantId);
    const usageStats = await db.getUsageStats(tenantId);
    const recentLogs = await logService.getRecentLogs(tenantId, 50);

    const now = new Date();
    const expiry = tenant.trial_expiry_date ? new Date(tenant.trial_expiry_date) : now;
    const remainingDays = Math.max(0, Math.ceil((expiry - now) / (1000 * 60 * 60 * 24)));

    // Auto-detect freeze condition: credits <= 0 OR plan expiry date in past
    let accountStatus = tenant.account_status || 'trial';
    if (balance && balance.remaining_credits <= 0 && accountStatus !== 'suspended') {
      accountStatus = 'frozen_credits';
    } else if (tenant.plan_status === 'paid' && tenant.plan_expiry_date && new Date(tenant.plan_expiry_date) < now && accountStatus !== 'suspended') {
      accountStatus = 'frozen_expired';
    } else if (tenant.plan_status === 'free_trial' && remainingDays <= 0 && accountStatus !== 'suspended') {
      accountStatus = 'expired';
    }

    // Sync status in DB if changed
    if (accountStatus !== tenant.account_status && accountStatus.startsWith('frozen')) {
      await db.updateTenantStatus(tenantId, accountStatus);
    }

    const isFrozen = accountStatus === 'frozen_credits' || accountStatus === 'frozen_expired' || accountStatus === 'expired';

    return res.status(200).json({
      status: 'success',
      client: {
        tenant_id: tenant.tenant_id,
        email: tenant.email || 'N/A',
        name: tenant.name || tenant.username,
        picture: tenant.picture,
        signup_date: tenant.signup_date || tenant.created_at,
        trial_start_date: tenant.trial_start_date || tenant.signup_date,
        trial_expiry_date: tenant.trial_expiry_date,
        remaining_trial_days: remainingDays,
        account_status: accountStatus,
        plan_status: tenant.plan_status || 'free_trial',
        current_plan: tenant.current_plan || 'trial',
        plan_expiry_date: tenant.plan_expiry_date || null,
        is_frozen: isFrozen,
        api_credentials: {
          username: tenant.username,
          password: tenant.password,
          channel_id: tenant.channel_id
        }
      },
      whatsapp: {
        state: waState,
        number: waInfo.number,
        pushname: waInfo.pushname,
        platform: waInfo.platform,
        wwebVersion: waInfo.wwebVersion,
        qrCode: qrData
      },
      credits: {
        allocated: balance ? balance.allocated_credits : 0,
        used: balance ? balance.used_credits : 0,
        remaining: balance ? balance.remaining_credits : 0,
        todayUsage: usageStats ? usageStats.today : 0,
        monthlyUsage: usageStats ? usageStats.month : 0
      },
      logs: recentLogs
    });

  } catch (err) {
    return res.status(500).json({
      status: 'failed',
      reason: err.message || 'Failed to aggregate client dashboard data'
    });
  }
};

/**
 * DELETE /api/client/account
 * Permanently deletes the authenticated client's account, destroys WhatsApp session, clears local files, and purges database rows.
 */
exports.deleteAccount = async (req, res) => {
  const tenant = req.tenant;
  const tenantId = tenant.tenant_id;
  const confirmCode = req.body && req.body.confirmCode;
  const confirmEmail = req.body && req.body.confirmEmail;

  if (confirmCode && confirmCode.toString().trim() !== 'DELETE') {
    return res.status(400).json({
      status: 'failed',
      reason: 'Confirmation text mismatch. Type "DELETE" to confirm deletion.'
    });
  }

  if (confirmEmail && confirmEmail.toString().trim().toLowerCase() !== (tenant.email || '').toLowerCase()) {
    return res.status(400).json({
      status: 'failed',
      reason: `Email mismatch: Please enter your exact email (${tenant.email}) to confirm deletion.`
    });
  }

  try {
    // 1. Destroy WhatsApp Web instance & delete session storage on disk
    await whatsappService.deleteSessionData(tenantId);

    // 2. Permanently delete DB records via transaction
    const success = await db.deleteTenant(tenantId);

    if (success) {
      return res.status(200).json({
        status: 'success',
        message: 'Your account and all associated WhatsApp session data have been permanently deleted.'
      });
    } else {
      return res.status(500).json({
        status: 'failed',
        reason: 'Failed to delete client database record.'
      });
    }
  } catch (err) {
    return res.status(500).json({
      status: 'failed',
      reason: err.message || 'Error occurred while deleting account'
    });
  }
};

