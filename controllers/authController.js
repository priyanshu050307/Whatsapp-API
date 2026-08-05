const jwt = require('jsonwebtoken');
const https = require('https');
const db = require('../services/db');
const whatsappService = require('../services/whatsapp');
const config = require('../config/config');
const logger = require('../services/logger');

/**
 * Verify Google ID Token via Google OAuth TokenInfo API
 */
function verifyGoogleToken(idToken) {
  return new Promise((resolve, reject) => {
    const url = `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`;
    https.get(url, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (res.statusCode === 200 && parsed.email) {
            resolve(parsed);
          } else {
            reject(new Error(parsed.error_description || 'Invalid Google ID token'));
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
 * Helper to parse JWT payload without signature check (for client side GIS credential decode fallback)
 */
function decodeJwtPayload(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1], 'base64').toString('utf8');
    return JSON.parse(payload);
  } catch (e) {
    return null;
  }
}

/**
 * POST /api/auth/google
 * Handles Gmail / Google OAuth authentication
 */
exports.googleLogin = async (req, res) => {
  try {
    const { idToken, credential, email, name, picture, googleId } = req.body;
    let googleUser = null;
    const tokenToVerify = idToken || credential;

    if (tokenToVerify) {
      try {
        googleUser = await verifyGoogleToken(tokenToVerify);
      } catch (tokenErr) {
        logger.warn('Google online token verification failed, attempting payload decoding: %s', tokenErr.message);
        googleUser = decodeJwtPayload(tokenToVerify);
      }
    }

    // Fallback if client passed raw profile fields (e.g., local dev or direct auth)
    if (!googleUser && email) {
      googleUser = {
        email,
        name: name || email.split('@')[0],
        picture: picture || null,
        sub: googleId || null
      };
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
      reason: err.message || 'Google authentication error'
    });
  }
};

/**
 * POST /api/auth/admin/login
 * Handles Master Admin login
 */
exports.adminLogin = async (req, res) => {
  const { password } = req.body;
  const activeConfig = config.get();
  const expectedPassword = activeConfig.MASTER_ADMIN_PASSWORD || 'admin123';

  if (!password || password.toString().trim() !== expectedPassword.toString().trim()) {
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
