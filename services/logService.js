const db = require('./db');
const logger = require('./logger');
const fs = require('fs');
const path = require('path');

const memoryLogsMap = new Map(); // tenantId -> Array of logs
const MAX_MEMORY_LOGS = 100;
const logsDir = path.resolve(__dirname, '../logs');

function getSafeLogFilePath(tenantId) {
  const safeId = String(tenantId || 'default').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeId) throw new Error('Invalid tenantId for log file');
  const resolved = path.resolve(logsDir, `messages_${safeId}.jsonl`);
  if (!resolved.startsWith(logsDir + path.sep)) {
    throw new Error('Path traversal blocked in logService');
  }
  return resolved;
}

// Helper to get or load memory logs for a tenant
function getTenantMemoryLogs(tenantId) {
  if (memoryLogsMap.has(tenantId)) {
    return memoryLogsMap.get(tenantId);
  }
  
  const tenantLogs = [];
  memoryLogsMap.set(tenantId, tenantLogs);
  
  // Load from tenant specific file if SQLite is not available
  if (!db.isAvailable()) {
    try {
      const logFilePath = getSafeLogFilePath(tenantId);
      if (fs.existsSync(logFilePath)) {
        const content = fs.readFileSync(logFilePath, 'utf8');
        const lines = content.trim().split('\n').filter(Boolean);
        const parsedLines = lines.map(line => {
          try {
            return JSON.parse(line);
          } catch (e) {
            return null;
          }
        }).filter(Boolean);
        // Keep only the most recent logs (reverse order: newest first)
        tenantLogs.push(...parsedLines.slice(-MAX_MEMORY_LOGS).reverse());
      }
    } catch (err) {
      logger.error('Failed to load local message log file for tenant %s: %s', tenantId, err.message);
    }
  }
  return tenantLogs;
}

async function logWhatsAppMessage(tenantId, mobile, message, status, errorMsg = null) {
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const logEntry = {
    created_at: timestamp,
    mobile,
    message,
    status,
    error: errorMsg,
    tenant_id: tenantId
  };

  let logId = null;
  // 1. Attempt to write to SQLite Database
  if (db.isAvailable()) {
    logId = await db.logMessage(tenantId, mobile, message, status, errorMsg);
  } else {
    // 2. Fallback: Add to memory array (newest first)
    const tenantLogs = getTenantMemoryLogs(tenantId);
    tenantLogs.unshift(logEntry);
    if (tenantLogs.length > MAX_MEMORY_LOGS) {
      tenantLogs.pop();
    }

    // 3. Fallback: Write log entry to JSON Lines backup file
    try {
      const logFilePath = getSafeLogFilePath(tenantId);
      fs.appendFileSync(logFilePath, JSON.stringify(logEntry) + '\n', 'utf8');
    } catch (err) {
      logger.error('Failed to append message to messages_%s.jsonl: %s', tenantId, err.message);
    }
  }

  // Log summary to the general Winston system log and auto-record to client directory
  if (status === 'success') {
    logger.info(`[Tenant: ${tenantId}] WhatsApp Sent Successfully: To=${mobile}, Status=${status}`);
    db.recordContact(tenantId, mobile, message).catch(err => {
      logger.debug('Error auto-recording contact: %s', err.message);
    });
  } else {
    logger.error(`[Tenant: ${tenantId}] WhatsApp Send Failed: To=${mobile}, Status=${status}, Error=${errorMsg}`);
  }

  return logId;
}

async function updateLogStatus(logId, status, errorMsg = null) {
  if (db.isAvailable() && logId) {
    const res = await db.updateLogStatus(logId, status, errorMsg);
    if (res) {
      if (status === 'success') {
        logger.info(`[LogUpdate] Message log ${logId} updated: Status=${status}`);
      } else {
        logger.error(`[LogUpdate] Message log ${logId} updated: Status=${status}, Error=${errorMsg}`);
      }
    }
    return res;
  }
  return false;
}

async function getRecentLogs(tenantId, limit = 100) {
  if (db.isAvailable()) {
    return await db.getLogs(tenantId, limit);
  } else {
    return getTenantMemoryLogs(tenantId).slice(0, limit);
  }
}

async function getStatsToday(tenantId) {
  if (db.isAvailable()) {
    const dbStats = await db.getStats(tenantId);
    if (dbStats) return dbStats;
  }
  
  // Memory fallback stats calculated dynamically
  const todayStr = new Date().toISOString().substring(0, 10);
  let total = 0;
  let success = 0;
  let failed = 0;

  const tenantLogs = getTenantMemoryLogs(tenantId);
  tenantLogs.forEach(log => {
    if (log.created_at && log.created_at.startsWith(todayStr)) {
      total++;
      if (log.status === 'success') success++;
      else if (log.status === 'failed') failed++;
    }
  });

  return { total, success, failed };
}

module.exports = {
  logWhatsAppMessage,
  updateLogStatus,
  getRecentLogs,
  getStatsToday
};
