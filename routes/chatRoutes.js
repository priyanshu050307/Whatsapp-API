const express = require('express');
const router = express.Router();
const chatController = require('../controllers/chatController');
const authMiddleware = require('../middleware/auth');
const multer = require('multer');

const upload = multer({ storage: multer.memoryStorage() });

// Authenticated Client Live WhatsApp Web Endpoints
router.use(authMiddleware);

router.get('/chats', chatController.getChats);
router.get('/chats/:chatId/messages', chatController.getMessages);
router.post('/chats/:chatId/send', upload.single('file'), chatController.sendMessage);
router.post('/chats/:chatId/read', chatController.markRead);

module.exports = router;
