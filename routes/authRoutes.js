const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const authMiddleware = require('../middleware/auth');

// Google OAuth Login / Signup
router.post('/google', authController.googleLogin);

// Firebase Public Config for Client App
router.get('/firebase-config', authController.getFirebaseConfig);

// Master Admin Login
router.post('/admin/login', authController.adminLogin);

// Get current authenticated user context
router.get('/me', authMiddleware, authController.getMe);

module.exports = router;
