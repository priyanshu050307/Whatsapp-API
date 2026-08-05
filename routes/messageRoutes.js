const express = require('express');
const router = express.Router();
const messageController = require('../controllers/messageController');
const authMiddleware = require('../middleware/auth');

// Support both GET query parameters and POST JSON bodies for sending messages
router.route('/new')
  .get(authMiddleware, messageController.sendMessage)
  .post(authMiddleware, messageController.sendMessage);

module.exports = router;
