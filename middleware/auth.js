const jwt = require('jsonwebtoken');
const db = require('../services/db');
const config = require('../config/config');

/**
 * Dual Authentication Middleware
 * Supports:
 * 1. Bearer JWT Token in Authorization header (or x-access-token / token query) for Web Dashboard
 * 2. Legacy API credentials (username, password, channel_id) for Busy Accounting Software
 * 
 * Enforces account status restrictions (suspended/expired).
 */
module.exports = async (req, res, next) => {
  let tenant = null;

  // 1. Try Bearer JWT Authentication first
  const authHeader = req.headers['authorization'] || req.headers['x-access-token'];
  let token = null;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  } else if (req.query && req.query.token) {
    token = req.query.token;
  } else if (req.body && req.body.token) {
    token = req.body.token;
  }

  if (token) {
    try {
      const decoded = jwt.verify(token, config.get().JWT_SECRET);
      if (decoded && decoded.tenantId) {
        tenant = await db.getTenantById(decoded.tenantId);
      }
    } catch (err) {
      return res.status(401).json({
        status: 'failed',
        reason: 'Unauthorized: Invalid or expired session token'
      });
    }
  }

  // 2. Fallback to Legacy API Credentials Authentication if no valid JWT
  if (!tenant) {
    const findCredential = (keys) => {
      for (const key of keys) {
        const foundKey = Object.keys(req.query).find(k => k.toLowerCase() === key.toLowerCase());
        if (foundKey && req.query[foundKey] !== undefined) return req.query[foundKey];
      }
      if (req.body) {
        for (const key of keys) {
          const foundKey = Object.keys(req.body).find(k => k.toLowerCase() === key.toLowerCase());
          if (foundKey && req.body[foundKey] !== undefined) return req.body[foundKey];
        }
      }
      for (const key of keys) {
        const foundKey = Object.keys(req.headers).find(k => k.toLowerCase() === key.toLowerCase());
        if (foundKey && req.headers[foundKey] !== undefined) return req.headers[foundKey];
      }
      return null;
    };

    const rawUsername = findCredential(['username', 'user']);
    const rawPassword = findCredential(['password', 'pass', 'pwd']);
    const rawChannelId = findCredential(['channelid', 'channelId', 'channelID', 'channel_id']);

    if (rawUsername !== null && rawPassword !== null && rawChannelId !== null) {
      const username = String(rawUsername).trim();
      const password = String(rawPassword).trim();
      const channelid = String(rawChannelId).trim();

      if (username && password && channelid) {
        try {
          tenant = await db.getTenantByCredentials(username, password, channelid);
        } catch (err) {
          return res.status(500).json({
            status: 'failed',
            reason: 'Internal server error validating credentials'
          });
        }
      }
    }
  }

  if (!tenant) {
    return res.status(401).json({
      status: 'failed',
      reason: 'Unauthorized: Valid Session Token or API Credentials required'
    });
  }

  // 3. Enforce Account Status Restrictions
  if (tenant.account_status === 'suspended') {
    return res.status(403).json({
      status: 'failed',
      reason: 'Account Suspended: Your account has been suspended by administration. Please contact support.'
    });
  }

  // Restrict message sending if trial is expired and plan is not active
  const isMessageEndpoint = req.path.includes('/message');
  if (isMessageEndpoint && tenant.account_status === 'expired' && tenant.plan_status !== 'paid' && tenant.plan_status !== 'active') {
    return res.status(402).json({
      status: 'failed',
      reason: 'Trial Expired: Your 15-day free trial has expired. Please upgrade your subscription plan to send WhatsApp messages.'
    });
  }

  req.tenant = tenant;
  return next();
};
