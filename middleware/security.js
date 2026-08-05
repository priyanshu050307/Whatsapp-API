const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const config = require('../config/config');

// Setup Rate Limiting using active settings
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

// Configure Cross-Origin Resource Sharing (CORS)
const corsOptions = {
  origin: '*', // Allows connections from integration software clients
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type', 
    'Authorization', 
    'X-API-Username', 
    'X-API-Password', 
    'X-API-ChannelID',
    'X-API-Channel-ID'
  ],
  credentials: true
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
        "'unsafe-inline'", 
        "https://cdn.jsdelivr.net", 
        "https://www.gstatic.com", 
        "https://apis.google.com",
        "https://accounts.google.com",
        "https://*.firebaseapp.com"
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
        "https://*.googleusercontent.com"
      ],
      connectSrc: [
        "'self'", 
        "ws:", 
        "wss:", 
        "https://identitytoolkit.googleapis.com", 
        "https://securetoken.googleapis.com", 
        "https://*.firebaseapp.com",
        "https://cdn.jsdelivr.net",
        "https://www.gstatic.com",
        "https://apis.google.com",
        "https://accounts.google.com",
        "https://*.googleapis.com"
      ],
      frameSrc: [
        "'self'", 
        "https://*.firebaseapp.com",
        "https://accounts.google.com"
      ]
    }
  }
});

module.exports = {
  limiter,
  cors: cors(corsOptions),
  helmet: helmetMiddleware
};
