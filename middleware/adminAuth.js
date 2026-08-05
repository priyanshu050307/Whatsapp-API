const jwt = require('jsonwebtoken');
const config = require('../config/config');

/**
 * Admin Authentication Middleware
 * Protects administrative routes. Accepts:
 * - Admin Bearer JWT token (payload isAdmin === true)
 * - Header `x-admin-password` matching MASTER_ADMIN_PASSWORD
 */
module.exports = (req, res, next) => {
  const activeConfig = config.get();
  const expectedAdminPassword = activeConfig.MASTER_ADMIN_PASSWORD || 'admin123';

  // 1. Check x-admin-password header
  const adminPasswordHeader = req.headers['x-admin-password'] || (req.body && req.body.adminPassword);
  if (adminPasswordHeader && adminPasswordHeader.toString().trim() === expectedAdminPassword.toString().trim()) {
    req.isAdmin = true;
    return next();
  }

  // 2. Check Bearer JWT token
  const authHeader = req.headers['authorization'] || req.headers['x-access-token'];
  let token = null;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  } else if (req.query && req.query.token) {
    token = req.query.token;
  }

  if (token) {
    try {
      const decoded = jwt.verify(token, activeConfig.JWT_SECRET);
      if (decoded && decoded.isAdmin) {
        req.isAdmin = true;
        return next();
      }
    } catch (err) {
      return res.status(401).json({
        status: 'failed',
        reason: 'Unauthorized: Invalid or expired Admin session token'
      });
    }
  }

  return res.status(403).json({
    status: 'failed',
    reason: 'Forbidden: Admin authorization required'
  });
};
