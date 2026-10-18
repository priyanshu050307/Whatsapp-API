const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const config = require('../config/config');

// Setup General API Rate Limiting using active settings
const activeConfig = config.get();
const limiter = rateLimit({
  windowMs: activeConfig.RATE_LIMIT_WINDOW_MS || 900000, // default: 15 minutes
  max: activeConfig.RATE_LIMIT_MAX || 1000, // default: max 1000 requests per window
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 'failed',
    reason: 'Too many requests from this IP. Please try again later.'
  }
});

// Strict Rate Limiter for Authentication Endpoints (prevents brute-force attacks)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: parseInt(process.env.AUTH_RATE_LIMIT_MAX || '25', 10), // max 25 login attempts per 15 min per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 'failed',
    reason: 'Too many authentication attempts from this IP. Please try again after 15 minutes.'
  }
});

// Configure Cross-Origin Resource Sharing (CORS)
// Note: 'origin: *' cannot be combined with 'credentials: true' per W3C CORS specification.
// Since authentication uses Bearer tokens / API headers rather than cookies, credentials is only enabled when a specific origin is configured.
const configuredOrigin = process.env.CORS_ORIGIN || '*';
const corsOptions = {
  origin: configuredOrigin,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type', 
    'Authorization', 
    'X-Access-Token',
    'X-Admin-Password',
    'X-API-Username', 
    'X-API-Password', 
    'X-API-ChannelID',
    'X-API-Channel-ID'
  ],
  credentials: configuredOrigin !== '*'
};

// Configure Helmet Security Headers
// We specify a CSP policy that allows loading Bootstrap 5, Google Fonts, and Firebase Auth resources
const helmetMiddleware = helmet({
  crossOriginOpenerPolicy: false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'", 
        "https://cdn.jsdelivr.net", 
        "https://www.gstatic.com", 
        "https://apis.google.com",
        "https://accounts.google.com",
        "https://*.firebaseapp.com",
        "https://checkout.razorpay.com",
        "https://*.razorpay.com"
      ],
      styleSrc: [
        "'self'", 
        "'unsafe-inline'", 
        "https://cdn.jsdelivr.net", 
        "https://fonts.googleapis.com"
      ],
      fontSrc: [
        "'self'", 
        "data:",
        "https://cdn.jsdelivr.net", 
        "https://fonts.gstatic.com"
      ],
      imgSrc: [
        "'self'", 
        "data:", 
        "blob:", 
        "https://*.googleusercontent.com",
        "https://*.gravatar.com",
        "https://*.firebasestorage.app",
        "https://*.razorpay.com"
      ],
      connectSrc: [
        "'self'", 
        "ws:", 
        "wss:", 
        "https://identitytoolkit.googleapis.com", 
        "https://securetoken.googleapis.com", 
        "https://*.firebaseapp.com",
        "https://*.firebasestorage.app",
        "https://cdn.jsdelivr.net",
        "https://www.gstatic.com",
        "https://apis.google.com",
        "https://accounts.google.com",
        "https://*.googleapis.com",
        "https://api.razorpay.com",
        "https://*.razorpay.com"
      ],
      frameSrc: [
        "'self'", 
        "https://*.firebaseapp.com",
        "https://accounts.google.com",
        "https://api.razorpay.com",
        "https://checkout.razorpay.com",
        "https://*.razorpay.com"
      ],
      objectSrc: ["'none'"],
      baseUri: ["'self'"]
    }
  }
});

module.exports = {
  limiter,
  authLimiter,
  cors: cors(corsOptions),
  helmet: helmetMiddleware
};
