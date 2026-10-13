const whatsappService = require('../services/whatsapp');
const logService = require('../services/logService');
const { sanitizeAndFormatNumber } = require('../services/numberHelper');
const db = require('../services/db');

/**
 * Handles GET & POST /message/new
 * Validates, formats number, sends message, logs, and returns standard response formats.
 */
exports.sendMessage = async (req, res) => {
  const tenantId = req.tenant.tenant_id;

  // Check credit balance
  const balance = await db.getCreditBalance(tenantId);
  if (!balance || balance.remaining_credits <= 0) {
    const receiverMobileNo = req.query.receiverMobileNo || req.body.receiverMobileNo || 'unknown';
    const messageText = req.query.message || req.body.message || '';
    await logService.logWhatsAppMessage(tenantId, receiverMobileNo, messageText, 'failed', 'Insufficient message credits');
    
    return res.status(402).json({
      status: 'failed',
      reason: `Insufficient message credits. Balance: ${balance ? balance.remaining_credits : 0}. Please contact administration for a recharge.`
    });
  }

  // Extract inputs from query parameters (GET) or request body (POST)
  const receiverMobileNo = req.query.receiverMobileNo || req.body.receiverMobileNo;
  const messageText = req.query.message || req.body.message;

  // 1. Validate Inputs
  if (!receiverMobileNo) {
    return res.status(400).json({
      status: 'failed',
      reason: 'receiverMobileNo is required'
    });
  }

  if (!messageText) {
    return res.status(400).json({
      status: 'failed',
      reason: 'Message cannot be empty'
    });
  }

  // Extract a clean raw string of the mobile for logging/errors
  const cleanRawMobile = receiverMobileNo.toString().replace(/[\s\-\+\(\)]/g, '');

  // 2. Process and Sanitize Number
  const formattedJID = sanitizeAndFormatNumber(receiverMobileNo);
  
  if (!formattedJID) {
    // Log failure in database/logs
    await logService.logWhatsAppMessage(tenantId, cleanRawMobile, messageText, 'failed', 'Invalid Number');
    return res.status(400).json({
      status: 'failed',
      reason: 'Invalid Number'
    });
  }

  // Extracted JID standard number (e.g. 919876543210)
  const standardizedMobile = formattedJID.replace('@c.us', '');

  // 3. Verify WhatsApp Connection Status
  const clientState = whatsappService.getClientState(tenantId);
  if (clientState !== 'READY') {
    const errorMsg = `WhatsApp client not ready (Status: ${clientState})`;
    await logService.logWhatsAppMessage(tenantId, standardizedMobile, messageText, 'failed', errorMsg);
    return res.status(503).json({
      status: 'failed',
      reason: 'WhatsApp connection offline'
    });
  }

  // 4. Send Message via WhatsApp Service
  try {
    const file = (req.files && req.files.length > 0) ? req.files[0] : null;
    
    // Deduct credit (1 per message sent: 2 if both file and message caption exist, otherwise 1)
    const creditsToDeduct = (file && messageText) ? 2 : 1;
    await db.deductCredit(tenantId, creditsToDeduct);
    
    // Log initial message entry
    const logId = await logService.logWhatsAppMessage(tenantId, standardizedMobile, messageText, 'success');

    // Send via WhatsApp Service with logId and deductedCredits attached directly
    const result = await whatsappService.sendWhatsAppMessage(tenantId, formattedJID, messageText, file, logId, creditsToDeduct);

    if (result && result.queueItem) {
      result.queueItem.logId = logId;
      result.queueItem.deductedCredits = creditsToDeduct;
    }
    
    const now = new Date();
    // Convert to Indian Standard Time or standard format YYYY-MM-DD HH:mm:ss
    const formattedTime = now.toISOString().replace('T', ' ').substring(0, 19);

    return res.status(200).json({
      status: 'success',
      message: 'WhatsApp Sent Successfully',
      mobile: standardizedMobile,
      time: formattedTime
    });
  } catch (err) {
    // Log failure details
    await logService.logWhatsAppMessage(tenantId, standardizedMobile, messageText, 'failed', err.message);
    
    return res.status(500).json({
      status: 'failed',
      reason: err.message || 'WhatsApp sending failed'
    });
  }
};
