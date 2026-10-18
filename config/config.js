const fs = require('fs');
const path = require('path');
require('dotenv').config();

const configPath = path.join(__dirname, 'config.json');

const getDefaults = () => ({
  PORT: parseInt(process.env.PORT || '3000', 10),
  NODE_ENV: process.env.NODE_ENV || 'production',
  API_USERNAME: process.env.API_USERNAME || '14125037',
  API_PASSWORD: process.env.API_PASSWORD || '123456',
  API_CHANNEL_ID: process.env.API_CHANNEL_ID || '29979',
  RATE_LIMIT_WINDOW_MS: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10),
  RATE_LIMIT_MAX: parseInt(process.env.RATE_LIMIT_MAX || '1000', 10),
  PUPPETEER_HEADLESS: process.env.PUPPETEER_HEADLESS !== 'false',
  USE_SQLITE: process.env.USE_SQLITE !== 'false',
  SESSION_PATH: process.env.SESSION_PATH || './session',
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',
  JWT_SECRET: process.env.JWT_SECRET || 'whatsapp_gateway_secret_key_2026',
  MASTER_ADMIN_PASSWORD: process.env.MASTER_ADMIN_PASSWORD || 'admin123',
  DEFAULT_TRIAL_DAYS: parseInt(process.env.DEFAULT_TRIAL_DAYS || '15', 10),
  FIREBASE_API_KEY: process.env.FIREBASE_API_KEY || '',
  FIREBASE_AUTH_DOMAIN: process.env.FIREBASE_AUTH_DOMAIN || '',
  FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID || '',
  FIREBASE_STORAGE_BUCKET: process.env.FIREBASE_STORAGE_BUCKET || '',
  FIREBASE_MESSAGING_SENDER_ID: process.env.FIREBASE_MESSAGING_SENDER_ID || '',
  FIREBASE_APP_ID: process.env.FIREBASE_APP_ID || '',
  RAZORPAY_KEY_ID: process.env.RAZORPAY_KEY_ID || 'rzp_live_TCS1rtRLEUCNtj',
  RAZORPAY_KEY_SECRET: process.env.RAZORPAY_KEY_SECRET || 'x90x2I3C6cvgA8s0sAGnH0QZ'
});

let currentConfig = { ...getDefaults() };

const loadConfig = () => {
  const defaults = getDefaults();
  if (fs.existsSync(configPath)) {
    try {
      const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      // Merge saved configurations on top of env defaults
      currentConfig = { ...defaults, ...saved };
    } catch (err) {
      console.error('Failed to parse config.json, using environment defaults:', err.message);
      currentConfig = defaults;
    }
  } else {
    currentConfig = defaults;
  }
  return currentConfig;
};

const saveConfig = (newConfig) => {
  try {
    const dataToSave = {
      PORT: newConfig.PORT ? parseInt(newConfig.PORT, 10) : currentConfig.PORT,
      API_USERNAME: newConfig.API_USERNAME || currentConfig.API_USERNAME,
      API_PASSWORD: newConfig.API_PASSWORD || currentConfig.API_PASSWORD,
      API_CHANNEL_ID: newConfig.API_CHANNEL_ID || currentConfig.API_CHANNEL_ID,
      RATE_LIMIT_WINDOW_MS: newConfig.RATE_LIMIT_WINDOW_MS ? parseInt(newConfig.RATE_LIMIT_WINDOW_MS, 10) : currentConfig.RATE_LIMIT_WINDOW_MS,
      RATE_LIMIT_MAX: newConfig.RATE_LIMIT_MAX ? parseInt(newConfig.RATE_LIMIT_MAX, 10) : currentConfig.RATE_LIMIT_MAX,
      PUPPETEER_HEADLESS: newConfig.PUPPETEER_HEADLESS !== undefined ? !!newConfig.PUPPETEER_HEADLESS : currentConfig.PUPPETEER_HEADLESS,
      USE_SQLITE: newConfig.USE_SQLITE !== undefined ? !!newConfig.USE_SQLITE : currentConfig.USE_SQLITE,
      SESSION_PATH: newConfig.SESSION_PATH || currentConfig.SESSION_PATH
    };
    
    fs.writeFileSync(configPath, JSON.stringify(dataToSave, null, 2), 'utf8');
    currentConfig = dataToSave;
    return true;
  } catch (err) {
    console.error('Failed to save config.json:', err.message);
    throw err;
  }
};

// Execute initial load
loadConfig();

module.exports = {
  get: () => currentConfig,
  load: loadConfig,
  save: saveConfig
};
