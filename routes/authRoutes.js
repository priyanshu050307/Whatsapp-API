const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const authMiddleware = require('../middleware/auth');
const security = require('../middleware/security');

// Google OAuth Login / Signup (rate-limited against abuse)
router.post('/google', security.authLimiter, authController.googleLogin);

// Firebase Public Config for Client App
router.get('/firebase-config', authController.getFirebaseConfig);

// Master Admin Login (strictly rate-limited against brute-force attacks)
router.post('/admin/login', security.authLimiter, authController.adminLogin);

// Get current authenticated user context
router.get('/me', authMiddleware, authController.getMe);

module.exports = router;
