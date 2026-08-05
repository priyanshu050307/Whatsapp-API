const express = require('express');
const router = express.Router();
const clientController = require('../controllers/clientController');
const authMiddleware = require('../middleware/auth');

router.get('/dashboard', authMiddleware, clientController.getDashboard);
router.delete('/account', authMiddleware, clientController.deleteAccount);

module.exports = router;

