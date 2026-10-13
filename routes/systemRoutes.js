const express = require('express');
const router = express.Router();
const systemController = require('../controllers/systemController');
const authMiddleware = require('../middleware/auth');
const adminAuth = require('../middleware/adminAuth');

// Legacy administrative endpoints
router.get('/status', authMiddleware, systemController.getStatus);
router.get('/qr', authMiddleware, systemController.getQrCode);
router.get('/logout', authMiddleware, systemController.logout);
router.get('/restart', authMiddleware, systemController.restart);

// Dashboard supporting API endpoints
router.get('/api/logs', authMiddleware, systemController.getLogs);
router.get('/api/config', authMiddleware, systemController.getConfig);
router.post('/api/config', authMiddleware, systemController.saveConfig);

// Tenant registration endpoint (master admin only)
router.post('/api/tenants', adminAuth, systemController.registerTenant);

// Credits Management API Endpoints
router.post('/api/admin/credits/recharge', adminAuth, systemController.rechargeCredits);
router.get('/api/credits/history', authMiddleware, systemController.getRechargeHistory);

const clientController = require('../controllers/clientController');

// Account Deletion API Endpoint
router.delete('/api/account', authMiddleware, clientController.deleteAccount);

module.exports = router;
