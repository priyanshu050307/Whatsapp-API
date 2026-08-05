const whatsappService = require('../services/whatsapp');
const logger = require('../services/logger');

/**
 * GET /api/whatsapp/chats
 * Fetches real-time WhatsApp Web chat list for authenticated tenant
 */
exports.getChats = async (req, res) => {
  const tenantId = req.tenant.tenant_id;
  try {
    const chats = await whatsappService.getChats(tenantId);
    return res.status(200).json({ status: 'success', chats });
  } catch (err) {
    logger.error(`[Tenant: ${tenantId}] Failed to fetch WhatsApp chats: %s`, err.message);
    return res.status(500).json({ status: 'failed', reason: err.message });
  }
};

/**
 * GET /api/whatsapp/chats/:chatId/messages
 * Fetches message history for a specific conversation
 */
exports.getMessages = async (req, res) => {
  const tenantId = req.tenant.tenant_id;
  const { chatId } = req.params;
  const limit = parseInt(req.query.limit || 50, 10);

  try {
    const messages = await whatsappService.getChatMessages(tenantId, chatId, limit);
    return res.status(200).json({ status: 'success', chatId, messages });
  } catch (err) {
    logger.error(`[Tenant: ${tenantId}] Failed to fetch messages for ${chatId}: %s`, err.message);
    return res.status(500).json({ status: 'failed', reason: err.message });
  }
};

/**
 * POST /api/whatsapp/chats/:chatId/send
 * Sends real-time WhatsApp message to recipient in chat
 */
exports.sendMessage = async (req, res) => {
  const tenantId = req.tenant.tenant_id;
  const { chatId } = req.params;
  const body = req.body.body || req.body.message;
  const file = req.file;

  if (!body && !file) {
    return res.status(400).json({ status: 'failed', reason: 'Message body or file attachment is required.' });
  }

  try {
    const msg = await whatsappService.sendMessageToChat(tenantId, chatId, body, file);
    return res.status(200).json({ status: 'success', message: msg });
  } catch (err) {
    logger.error(`[Tenant: ${tenantId}] Error sending chat message to ${chatId}: %s`, err.message);
    return res.status(500).json({ status: 'failed', reason: err.message });
  }
};

/**
 * POST /api/whatsapp/chats/:chatId/read
 * Marks chat conversation as seen/read
 */
exports.markRead = async (req, res) => {
  const tenantId = req.tenant.tenant_id;
  const { chatId } = req.params;

  try {
    await whatsappService.markChatAsRead(tenantId, chatId);
    return res.status(200).json({ status: 'success', chatId });
  } catch (err) {
    return res.status(500).json({ status: 'failed', reason: err.message });
  }
};
