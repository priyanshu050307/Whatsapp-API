const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/paymentController');
const authMiddleware = require('../middleware/auth');

// Public route to list plans
router.get('/plans', paymentController.getPlans);

// Authenticated payment routes
router.post('/create-order', authMiddleware, paymentController.createOrder);
router.post('/verify-payment', authMiddleware, paymentController.verifyPayment);
router.get('/history', authMiddleware, paymentController.getHistory);

module.exports = router;
