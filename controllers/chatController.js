const whatsappService = require('../services/whatsapp');
const logger = require('../services/logger');

function isValidChatId(chatId) {
  return typeof chatId === 'string' && /^[\w.\-@]{3,128}$/.test(chatId);
}

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
    return res.status(500).json({ status: 'failed', reason: 'Failed to fetch WhatsApp chats' });
  }
};

/**
 * GET /api/whatsapp/chats/:chatId/messages
 * Fetches message history for a specific conversation
 */
exports.getMessages = async (req, res) => {
  const tenantId = req.tenant.tenant_id;
  const { chatId } = req.params;
  if (!isValidChatId(chatId)) {
    return res.status(400).json({ status: 'failed', reason: 'Invalid chatId format' });
  }
  const rawLimit = parseInt(req.query.limit || 50, 10);
  const limit = Math.min(Math.max(isNaN(rawLimit) ? 50 : rawLimit, 1), 200);

  try {
    const messages = await whatsappService.getChatMessages(tenantId, chatId, limit);
    return res.status(200).json({ status: 'success', chatId, messages });
  } catch (err) {
    logger.error(`[Tenant: ${tenantId}] Failed to fetch messages for ${chatId}: %s`, err.message);
    return res.status(500).json({ status: 'failed', reason: 'Failed to fetch chat messages' });
  }
};

/**
 * POST /api/whatsapp/chats/:chatId/send
 * Sends real-time WhatsApp message to recipient in chat
 */
exports.sendMessage = async (req, res) => {
  const tenantId = req.tenant.tenant_id;
  const { chatId } = req.params;
  if (!isValidChatId(chatId)) {
    return res.status(400).json({ status: 'failed', reason: 'Invalid chatId format' });
  }
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
    return res.status(500).json({ status: 'failed', reason: 'Error sending chat message' });
  }
};

/**
 * POST /api/whatsapp/chats/:chatId/read
 * Marks chat conversation as seen/read
 */
exports.markRead = async (req, res) => {
  const tenantId = req.tenant.tenant_id;
  const { chatId } = req.params;
  if (!isValidChatId(chatId)) {
    return res.status(400).json({ status: 'failed', reason: 'Invalid chatId format' });
  }

  try {
    await whatsappService.markChatAsRead(tenantId, chatId);
    return res.status(200).json({ status: 'success', chatId });
  } catch (err) {
    return res.status(500).json({ status: 'failed', reason: 'Failed to mark chat as read' });
  }
};
