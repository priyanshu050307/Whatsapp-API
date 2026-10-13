const jwt = require('jsonwebtoken');
const https = require('https');
const crypto = require('crypto');
const db = require('../services/db');
const whatsappService = require('../services/whatsapp');
const config = require('../config/config');
const logger = require('../services/logger');

/**
 * Constant-time string comparison to prevent timing side-channel attacks
 */
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const hashA = crypto.createHash('sha256').update(a).digest();
  const hashB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

/**
 * Verify Google OAuth2 ID Token via Google OAuth TokenInfo API
 */
function verifyGoogleOAuthToken(idToken) {
  return new Promise((resolve, reject) => {
    const url = `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`;
    https.get(url, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (res.statusCode === 200 && parsed.email) {
            resolve({
              email: parsed.email,
              name: parsed.name || parsed.email.split('@')[0],
              picture: parsed.picture || null,
              sub: parsed.sub || null
            });
          } else {
            reject(new Error(parsed.error_description || 'Invalid Google OAuth ID token'));
          }
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Verify Firebase ID Token via Google Identity Toolkit REST API
 */
function verifyFirebaseIdToken(idToken, apiKey) {
  return new Promise((resolve, reject) => {
    if (!apiKey || apiKey.startsWith('mock')) {
      return reject(new Error('Firebase API key not configured'));
    }
    const postData = JSON.stringify({ idToken });
    const req = https.request({
      hostname: 'identitytoolkit.googleapis.com',
      path: `/v1/accounts:lookup?key=${encodeURIComponent(apiKey)}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (res.statusCode === 200 && parsed.users && parsed.users.length > 0 && parsed.users[0].email) {
            const u = parsed.users[0];
            resolve({
              email: u.email,
              name: u.displayName || u.email.split('@')[0],
              picture: u.photoUrl || null,
              sub: u.localId || null
            });
          } else {
            const errMsg = (parsed.error && parsed.error.message) || 'Invalid Firebase ID token';
            reject(new Error(errMsg));
          }
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

/**
 * Verify token using Firebase Identity Toolkit first, then Google OAuth2 TokenInfo
 */
async function verifyGoogleToken(idToken) {
  const activeConfig = config.get();
  if (activeConfig.FIREBASE_API_KEY && !activeConfig.FIREBASE_API_KEY.startsWith('mock')) {
    try {
      return await verifyFirebaseIdToken(idToken, activeConfig.FIREBASE_API_KEY);
    } catch (firebaseErr) {
      logger.debug('Firebase token lookup did not match, trying Google OAuth tokeninfo: %s', firebaseErr.message);
    }
  }
  return await verifyGoogleOAuthToken(idToken);
}

// SECURITY: decodeJwtPayload helper intentionally removed.
// Decoding a JWT WITHOUT verifying its signature is an authentication bypass —
// it would allow any attacker to craft a base64-encoded payload and gain access.
// Cryptographic token verification (verifyGoogleToken) is the ONLY accepted path.

/**
 * POST /api/auth/google
 * Handles Gmail / Google OAuth authentication
 */
exports.googleLogin = async (req, res) => {
  try {
    const { idToken, credential } = req.body;
    let googleUser = null;
    const tokenToVerify = idToken || credential;

    if (!tokenToVerify) {
      return res.status(400).json({
        status: 'failed',
        reason: 'Google authentication failed: Valid ID token is required.'
      });
    }

    try {
      googleUser = await verifyGoogleToken(tokenToVerify);
    } catch (tokenErr) {
      // SECURITY: Do NOT fall back to raw JWT decoding — that would bypass signature verification.
      logger.warn('Google token verification failed: %s', tokenErr.message);
      return res.status(401).json({
        status: 'failed',
        reason: 'Google authentication failed: Token verification failed. Please try signing in again.'
      });
    }

    if (!googleUser || !googleUser.email) {
      return res.status(400).json({
        status: 'failed',
        reason: 'Google authentication failed: Email address is required.'
      });
    }

    const userEmail = googleUser.email.trim().toLowerCase();
    let tenant = await db.getTenantByEmail(userEmail);
    let isNewClient = false;

    if (!tenant) {
      // Create new client with 15-day trial
      logger.info(`Creating new tenant for Google email: ${userEmail}`);
      tenant = await db.createGoogleTenant({
        email: userEmail,
        name: googleUser.name || userEmail.split('@')[0],
        google_id: googleUser.sub || null,
        picture: googleUser.picture || null
      });
      isNewClient = true;

      if (!tenant) {
        return res.status(500).json({
          status: 'failed',
          reason: 'Failed to create client account for ' + userEmail
        });
      }

      // Initialize WhatsApp Web client session for new tenant
      whatsappService.initClient(tenant.tenant_id);
    } else {
      // Existing client account loaded
      logger.info(`Loaded existing tenant (${tenant.tenant_id}) for email: ${userEmail}`);
      await db.updateTenantLogin(tenant.tenant_id, googleUser.picture || tenant.picture);

      // Ensure WhatsApp client session is running for this tenant
      const currentState = whatsappService.getClientState(tenant.tenant_id);
      if (currentState === 'DISCONNECTED') {
        whatsappService.initClient(tenant.tenant_id);
      }
    }

    // Generate JWT Session Token
    const activeConfig = config.get();
    const tokenPayload = {
      tenantId: tenant.tenant_id,
      email: tenant.email,
      isAdmin: tenant.is_admin === 1
    };

    const sessionToken = jwt.sign(tokenPayload, activeConfig.JWT_SECRET, { expiresIn: '7d' });

    // Calculate remaining trial days
    const now = new Date();
    const expiry = tenant.trial_expiry_date ? new Date(tenant.trial_expiry_date) : now;
    const remainingDays = Math.max(0, Math.ceil((expiry - now) / (1000 * 60 * 60 * 24)));

    return res.status(200).json({
      status: 'success',
      token: sessionToken,
      isNewClient,
      tenant: {
        tenant_id: tenant.tenant_id,
        email: tenant.email,
        name: tenant.name,
        picture: tenant.picture,
        account_status: tenant.account_status,
        plan_status: tenant.plan_status,
        signup_date: tenant.signup_date,
        trial_start_date: tenant.trial_start_date,
        trial_expiry_date: tenant.trial_expiry_date,
        remaining_trial_days: remainingDays,
        api_username: tenant.username,
        api_password: tenant.password,
        api_channel_id: tenant.channel_id
      }
    });

  } catch (err) {
    logger.error('Error in googleLogin controller: %s', err.stack || err.message);
    return res.status(500).json({
      status: 'failed',
      reason: 'Google authentication error'
    });
  }
};

/**
 * POST /api/auth/admin/login
 * Handles Master Admin login with constant-time password verification
 */
exports.adminLogin = async (req, res) => {
  const { password } = req.body;
  const activeConfig = config.get();
  const expectedPassword = String(activeConfig.MASTER_ADMIN_PASSWORD || 'admin123').trim();

  if (!password || !safeCompare(String(password).trim(), expectedPassword)) {
    logger.warn('Failed Master Admin login attempt from IP: %s', req.ip);
    return res.status(401).json({
      status: 'failed',
      reason: 'Invalid Admin Password'
    });
  }

  const tokenPayload = {
    tenantId: 'admin',
    isAdmin: true
  };

  const adminToken = jwt.sign(tokenPayload, activeConfig.JWT_SECRET, { expiresIn: '1d' });

  return res.status(200).json({
    status: 'success',
    token: adminToken,
    message: 'Admin authenticated successfully'
  });
};

/**
 * GET /api/auth/me
 * Returns profile details for current authenticated session
 */
exports.getMe = async (req, res) => {
  const tenant = req.tenant;
  const now = new Date();
  const expiry = tenant.trial_expiry_date ? new Date(tenant.trial_expiry_date) : now;
  const remainingDays = Math.max(0, Math.ceil((expiry - now) / (1000 * 60 * 60 * 24)));

  return res.status(200).json({
    status: 'success',
    tenant: {
      tenant_id: tenant.tenant_id,
      email: tenant.email,
      name: tenant.name,
      picture: tenant.picture,
      account_status: tenant.account_status,
      plan_status: tenant.plan_status,
      signup_date: tenant.signup_date,
      trial_start_date: tenant.trial_start_date,
      trial_expiry_date: tenant.trial_expiry_date,
      remaining_trial_days: remainingDays,
      api_username: tenant.username,
      api_password: tenant.password,
      api_channel_id: tenant.channel_id
    }
  });
};

/**
 * GET /api/auth/firebase-config
 * Exposes public client-side Firebase configurations to the web console
 */
exports.getFirebaseConfig = (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  const activeConfig = config.get();
  return res.status(200).json({
    status: 'success',
    config: {
      apiKey: activeConfig.FIREBASE_API_KEY || 'mock-api-key-replace-in-env',
      authDomain: activeConfig.FIREBASE_AUTH_DOMAIN || 'mock-project.firebaseapp.com',
      projectId: activeConfig.FIREBASE_PROJECT_ID || 'mock-project',
      storageBucket: activeConfig.FIREBASE_STORAGE_BUCKET || 'mock-project.appspot.com',
      messagingSenderId: activeConfig.FIREBASE_MESSAGING_SENDER_ID || '1234567890',
      appId: activeConfig.FIREBASE_APP_ID || '1:1234567890:web:abcdef123456',
      googleClientId: activeConfig.GOOGLE_CLIENT_ID || '170139879508-nrvotmb3dc1sh807uv0sngm57cvgjaql.apps.googleusercontent.com'
    }
  });
};
