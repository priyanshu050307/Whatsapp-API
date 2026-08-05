const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const config = require('../config/config');
const logger = require('./logger');

const dbDir = path.join(__dirname, '../logs');
const dbPath = path.join(dbDir, process.env.DB_FILENAME || 'database.db');

// Ensure db directory exists
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

let db = null;
let sqliteAvailable = false;
let dbInitPromise = null;

function init() {
  if (dbInitPromise) return dbInitPromise;

  dbInitPromise = new Promise((resolve, reject) => {
    if (!config.get().USE_SQLITE) {
      logger.info('SQLite is disabled in configuration. Using file-based logging fallback.');
      resolve(false);
      return;
    }

    try {
      const sqlite3 = require('sqlite3').verbose();
      db = new sqlite3.Database(dbPath, (err) => {
        if (err) {
          logger.error('Failed to connect to SQLite database: %s', err.message);
          reject(err);
        } else {
          logger.info('Connected to SQLite database at: %s', dbPath);
          initializeTables()
            .then(() => {
              sqliteAvailable = true;
              resolve(true);
            })
            .catch((initErr) => {
              reject(initErr);
            });
        }
      });
    } catch (err) {
      logger.warn('sqlite3 module could not be initialized. Running in fallback mode without SQLite. Reason: %s', err.message);
      sqliteAvailable = false;
      resolve(false);
    }
  });

  return dbInitPromise;
}

function initializeTables() {
  if (!db) return Promise.resolve();
  
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      // 1. Create message_logs table
      db.run(`
        CREATE TABLE IF NOT EXISTS message_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at TEXT NOT NULL,
          mobile TEXT NOT NULL,
          message TEXT NOT NULL,
          status TEXT NOT NULL,
          error TEXT,
          tenant_id TEXT DEFAULT 'default'
        )
      `, (err) => {
        if (err) {
          logger.error('Failed to create message_logs table: %s', err.message);
          return reject(err);
        }
        
        // Create standard indexes
        db.run('CREATE INDEX IF NOT EXISTS idx_status ON message_logs(status)');
        db.run('CREATE INDEX IF NOT EXISTS idx_created_at ON message_logs(created_at)');
        
        // Perform schema migration if tenant_id doesn't exist in existing database
        db.all("PRAGMA table_info(message_logs)", (pragmaErr, columns) => {
          if (pragmaErr) {
            logger.error('Failed to query message_logs table info: %s', pragmaErr.message);
            return reject(pragmaErr);
          }
          const hasTenantId = columns.some(col => col.name === 'tenant_id');
          if (!hasTenantId) {
            db.run("ALTER TABLE message_logs ADD COLUMN tenant_id TEXT DEFAULT 'default'", (alterErr) => {
              if (alterErr) {
                logger.error('Failed to migrate message_logs table (add tenant_id): %s', alterErr.message);
                return reject(alterErr);
              }
              logger.info('Migrated message_logs: Added tenant_id column.');
              db.run('CREATE INDEX IF NOT EXISTS idx_tenant_id ON message_logs(tenant_id)', (idxErr) => {
                if (idxErr) logger.error('Failed to create tenant_id index: %s', idxErr.message);
                createTenantsTable(resolve, reject);
              });
            });
          } else {
            db.run('CREATE INDEX IF NOT EXISTS idx_tenant_id ON message_logs(tenant_id)', (idxErr) => {
              if (idxErr) logger.error('Failed to create tenant_id index: %s', idxErr.message);
              createTenantsTable(resolve, reject);
            });
          }
        });
      });
    });
  });
}

function createTenantsTable(resolve, reject) {
  // 2. Create tenants table with full multi-tenant schema
  db.run(`
    CREATE TABLE IF NOT EXISTS tenants (
      tenant_id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      email TEXT,
      name TEXT,
      google_id TEXT,
      picture TEXT,
      account_status TEXT DEFAULT 'trial',
      plan_status TEXT DEFAULT 'free_trial',
      signup_date TEXT,
      trial_start_date TEXT,
      trial_expiry_date TEXT,
      last_login_at TEXT,
      is_admin INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `, (err) => {
    if (err) {
      logger.error('Failed to create tenants table: %s', err.message);
      return reject(err);
    }
    
    // Check missing columns for migration on existing databases
    db.all("PRAGMA table_info(tenants)", (pragmaErr, columns) => {
      if (pragmaErr) {
        logger.error('Failed to query tenants table info: %s', pragmaErr.message);
        return reject(pragmaErr);
      }

      const existingColNames = columns.map(c => c.name);
      const alterQueries = [];

      if (!existingColNames.includes('email')) alterQueries.push("ALTER TABLE tenants ADD COLUMN email TEXT");
      if (!existingColNames.includes('name')) alterQueries.push("ALTER TABLE tenants ADD COLUMN name TEXT");
      if (!existingColNames.includes('google_id')) alterQueries.push("ALTER TABLE tenants ADD COLUMN google_id TEXT");
      if (!existingColNames.includes('picture')) alterQueries.push("ALTER TABLE tenants ADD COLUMN picture TEXT");
      if (!existingColNames.includes('account_status')) alterQueries.push("ALTER TABLE tenants ADD COLUMN account_status TEXT DEFAULT 'trial'");
      if (!existingColNames.includes('plan_status')) alterQueries.push("ALTER TABLE tenants ADD COLUMN plan_status TEXT DEFAULT 'free_trial'");
      if (!existingColNames.includes('signup_date')) alterQueries.push("ALTER TABLE tenants ADD COLUMN signup_date TEXT");
      if (!existingColNames.includes('trial_start_date')) alterQueries.push("ALTER TABLE tenants ADD COLUMN trial_start_date TEXT");
      if (!existingColNames.includes('trial_expiry_date')) alterQueries.push("ALTER TABLE tenants ADD COLUMN trial_expiry_date TEXT");
      if (!existingColNames.includes('last_login_at')) alterQueries.push("ALTER TABLE tenants ADD COLUMN last_login_at TEXT");
      if (!existingColNames.includes('is_admin')) alterQueries.push("ALTER TABLE tenants ADD COLUMN is_admin INTEGER DEFAULT 0");

      const onSchemaComplete = () => {
        db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_email ON tenants(email) WHERE email IS NOT NULL', (idxErr) => {
          if (idxErr) logger.debug('Notice creating email unique index: %s', idxErr.message);
          createCreditsTable(resolve, reject);
        });
      };

      let completedAlters = 0;
      if (alterQueries.length === 0) {
        logger.debug('SQLite tenants table initialized & up-to-date.');
        onSchemaComplete();
      } else {
        alterQueries.forEach(query => {
          db.run(query, (alterErr) => {
            if (alterErr) {
              logger.warn('Column alter notice: %s (%s)', alterErr.message, query);
            }
            completedAlters++;
            if (completedAlters === alterQueries.length) {
              logger.info('Migrated tenants table with %d schema extensions.', alterQueries.length);
              onSchemaComplete();
            }
          });
        });
      }
    });
  });
}

function createCreditsTable(resolve, reject) {
  // 3. Create tenant_credits table
  db.run(`
    CREATE TABLE IF NOT EXISTS tenant_credits (
      tenant_id TEXT PRIMARY KEY,
      allocated_credits INTEGER DEFAULT 0,
      used_credits INTEGER DEFAULT 0,
      remaining_credits INTEGER DEFAULT 0,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(tenant_id) REFERENCES tenants(tenant_id) ON DELETE CASCADE
    )
  `, (err) => {
    if (err) {
      logger.error('Failed to create tenant_credits table: %s', err.message);
      return reject(err);
    }
    logger.debug('SQLite tenant_credits table initialized successfully.');
    createRechargeHistoryTable(resolve, reject);
  });
}

function createRechargeHistoryTable(resolve, reject) {
  // 4. Create recharge_history table
  db.run(`
    CREATE TABLE IF NOT EXISTS recharge_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      action TEXT NOT NULL,
      notes TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(tenant_id) REFERENCES tenants(tenant_id) ON DELETE CASCADE
    )
  `, (err) => {
    if (err) {
      logger.error('Failed to create recharge_history table: %s', err.message);
      return reject(err);
    }
    logger.debug('SQLite recharge_history table initialized successfully.');
    healMissingCredits(resolve, reject);
  });
}

function healMissingCredits(resolve, reject) {
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
  db.run(
    `INSERT INTO tenant_credits (tenant_id, allocated_credits, used_credits, remaining_credits, updated_at)
     SELECT tenant_id, 100, 0, 100, ? FROM tenants
     WHERE tenant_id NOT IN (SELECT tenant_id FROM tenant_credits)`,
    [timestamp],
    (err) => {
      if (err) {
        logger.error('Failed to heal missing credits: %s', err.message);
        return reject(err);
      }
      
      db.run(
        `INSERT INTO recharge_history (tenant_id, amount, action, notes, created_at)
         SELECT tenant_id, 100, 'allocate', 'Starter Credits Seeding', ? FROM tenants
         WHERE tenant_id NOT IN (SELECT DISTINCT tenant_id FROM recharge_history WHERE action = 'allocate')`,
        [timestamp],
        (histErr) => {
          if (histErr) {
            logger.error('Failed to log healed credits in history: %s', histErr.message);
          }
          resolve();
        }
      );
    }
  );
}

// Log message helper
function logMessage(tenantId, mobile, message, status, errorMsg = null) {
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
  
  if (sqliteAvailable && db) {
    return new Promise((resolve) => {
      db.run(
        `INSERT INTO message_logs (created_at, mobile, message, status, error, tenant_id) VALUES (?, ?, ?, ?, ?, ?)`,
        [timestamp, mobile, message, status, errorMsg, tenantId],
        function(err) {
          if (err) {
            logger.error('Failed to insert log into SQLite: %s', err.message);
            resolve(false);
          } else {
            resolve(this.lastID);
          }
        }
      );
    });
  }
  return Promise.resolve(false);
}

function updateLogStatus(logId, status, errorMsg = null) {
  if (sqliteAvailable && db && logId) {
    return new Promise((resolve) => {
      db.run(
        `UPDATE message_logs SET status = ?, error = ? WHERE id = ?`,
        [status, errorMsg, logId],
        function(err) {
          if (err) {
            logger.error('Failed to update SQLite message log status: %s', err.message);
            resolve(false);
          } else {
            resolve(true);
          }
        }
      );
    });
  }
  return Promise.resolve(false);
}

// Fetch logs helper
function getLogs(tenantId, limit = 100) {
  if (sqliteAvailable && db) {
    return new Promise((resolve) => {
      db.all(
        `SELECT * FROM message_logs WHERE tenant_id = ? ORDER BY id DESC LIMIT ?`,
        [tenantId, limit],
        (err, rows) => {
          if (err) {
            logger.error('Failed to query SQLite logs: %s', err.message);
            resolve([]);
          } else {
            resolve(rows);
          }
        }
      );
    });
  }
  return Promise.resolve([]);
}

// Get stats helper
function getStats(tenantId) {
  if (sqliteAvailable && db) {
    return new Promise((resolve) => {
      const today = new Date().toISOString().substring(0, 10) + '%';
      db.get(
        `SELECT 
          COUNT(*) as total,
          SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
         FROM message_logs 
         WHERE tenant_id = ? AND created_at LIKE ?`,
        [tenantId, today],
        (err, row) => {
          if (err) {
            logger.error('Failed to query stats from SQLite: %s', err.message);
            resolve({ total: 0, success: 0, failed: 0 });
          } else {
            resolve({
              total: row ? row.total : 0,
              success: row ? (row.success || 0) : 0,
              failed: row ? (row.failed || 0) : 0
            });
          }
        }
      );
    });
  }
  return Promise.resolve(null);
}

// Tenant Management Helpers
function addTenant(tenantId, username, password, channelId, options = {}) {
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const email = options.email || null;
  const name = options.name || null;
  const googleId = options.googleId || null;
  const picture = options.picture || null;
  const accountStatus = options.accountStatus || 'trial';
  const planStatus = options.planStatus || 'free_trial';
  const signupDate = options.signupDate || timestamp;
  const trialStartDate = options.trialStartDate || timestamp;
  
  // 15 days trial expiry default
  const trialDays = options.trialDays || config.get().DEFAULT_TRIAL_DAYS || 15;
  const expiryDateObj = new Date(Date.now() + trialDays * 24 * 60 * 60 * 1000);
  const trialExpiryDate = options.trialExpiryDate || expiryDateObj.toISOString().replace('T', ' ').substring(0, 19);
  const lastLoginAt = options.lastLoginAt || timestamp;
  const isAdmin = options.isAdmin ? 1 : 0;

  if (sqliteAvailable && db) {
    return new Promise((resolve) => {
      db.serialize(() => {
        db.run(
          `INSERT OR IGNORE INTO tenants (
            tenant_id, username, password, channel_id, email, name, google_id, picture, 
            account_status, plan_status, signup_date, trial_start_date, trial_expiry_date, last_login_at, is_admin, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            tenantId, username, password, channelId, email, name, googleId, picture,
            accountStatus, planStatus, signupDate, trialStartDate, trialExpiryDate, lastLoginAt, isAdmin, timestamp
          ],
          function(err) {
            if (err) {
              logger.error('Failed to add tenant to SQLite: %s', err.message);
              return resolve(false);
            }
            
            if (this.changes > 0) {
              const starterCredits = options.starterCredits !== undefined ? options.starterCredits : 100;
              db.run(
                `INSERT INTO tenant_credits (tenant_id, allocated_credits, used_credits, remaining_credits, updated_at) VALUES (?, ?, 0, ?, ?)`,
                [tenantId, starterCredits, starterCredits, timestamp],
                (credErr) => {
                  if (credErr) {
                    logger.error('Failed to initialize credits for new tenant: %s', credErr.message);
                  }
                  
                  db.run(
                    `INSERT INTO recharge_history (tenant_id, amount, action, notes, created_at) VALUES (?, ?, 'allocate', 'Starter Credits Seeding', ?)`,
                    [tenantId, starterCredits, timestamp],
                    (histErr) => {
                      if (histErr) {
                        logger.error('Failed to log starter credits: %s', histErr.message);
                      }
                      resolve(true);
                    }
                  );
                }
              );
            } else {
              resolve(false);
            }
          }
        );
      });
    });
  }
  return Promise.resolve(false);
}

function getTenantByEmail(email) {
  if (sqliteAvailable && db && email) {
    return new Promise((resolve) => {
      db.get(
        `SELECT * FROM tenants WHERE LOWER(email) = LOWER(?)`,
        [email.trim()],
        (err, row) => {
          if (err) {
            logger.error('Failed to query tenant by email: %s', err.message);
            resolve(null);
          } else {
            resolve(row ? checkAndUpdateTrialExpirySync(row) : null);
          }
        }
      );
    });
  }
  return Promise.resolve(null);
}

function createGoogleTenant(googleData) {
  const email = googleData.email.trim().toLowerCase();
  const name = googleData.name || email.split('@')[0];
  const googleId = googleData.sub || googleData.google_id || null;
  const picture = googleData.picture || null;
  
  const cleanPrefix = email.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 15);
  const tenantId = `tenant_${cleanPrefix}_${crypto.randomBytes(3).toString('hex')}`;

  const username = `u_${crypto.randomBytes(4).toString('hex')}`;
  const password = crypto.randomBytes(8).toString('hex');
  const channelId = `ch_${crypto.randomBytes(4).toString('hex')}`;

  return addTenant(tenantId, username, password, channelId, {
    email,
    name,
    googleId,
    picture,
    accountStatus: 'trial',
    planStatus: 'free_trial',
    starterCredits: 100
  }).then(success => {
    if (success) {
      return getTenantById(tenantId);
    }
    return null;
  });
}

function updateTenantLogin(tenantId, picture = null) {
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
  if (sqliteAvailable && db) {
    return new Promise((resolve) => {
      db.run(
        `UPDATE tenants SET last_login_at = ? ${picture ? ', picture = ?' : ''} WHERE tenant_id = ?`,
        picture ? [timestamp, picture, tenantId] : [timestamp, tenantId],
        (err) => {
          if (err) logger.error('Failed to update tenant login timestamp: %s', err.message);
          resolve(true);
        }
      );
    });
  }
  return Promise.resolve(false);
}

function checkAndUpdateTrialExpirySync(tenant) {
  if (!tenant || tenant.account_status !== 'trial' || !tenant.trial_expiry_date) {
    return tenant;
  }

  const now = new Date();
  const expiry = new Date(tenant.trial_expiry_date);
  
  if (now > expiry) {
    tenant.account_status = 'expired';
    tenant.plan_status = 'expired';
    if (sqliteAvailable && db) {
      db.run(
        `UPDATE tenants SET account_status = 'expired', plan_status = 'expired' WHERE tenant_id = ?`,
        [tenant.tenant_id],
        (err) => {
          if (err) logger.error('Failed to update trial expiry in database: %s', err.message);
        }
      );
    }
  }
  return tenant;
}

function updateTenantStatus(tenantId, accountStatus, planStatus) {
  if (sqliteAvailable && db) {
    return new Promise((resolve) => {
      db.run(
        `UPDATE tenants SET account_status = ?, plan_status = ? WHERE tenant_id = ?`,
        [accountStatus, planStatus || accountStatus, tenantId],
        function(err) {
          if (err) {
            logger.error('Failed to update tenant status: %s', err.message);
            resolve(false);
          } else {
            resolve(this.changes > 0);
          }
        }
      );
    });
  }
  return Promise.resolve(false);
}

function updateTrialExpiry(tenantId, newExpiryDate) {
  if (sqliteAvailable && db) {
    return new Promise((resolve) => {
      db.run(
        `UPDATE tenants SET trial_expiry_date = ?, account_status = 'trial', plan_status = 'free_trial' WHERE tenant_id = ?`,
        [newExpiryDate, tenantId],
        function(err) {
          if (err) {
            logger.error('Failed to update trial expiry date: %s', err.message);
            resolve(false);
          } else {
            resolve(this.changes > 0);
          }
        }
      );
    });
  }
  return Promise.resolve(false);
}

function getTenantByCredentials(username, password, channelId) {
  if (sqliteAvailable && db) {
    return new Promise((resolve) => {
      db.get(
        `SELECT * FROM tenants WHERE username = ? AND password = ? AND channel_id = ?`,
        [username, password, channelId],
        (err, row) => {
          if (err) {
            logger.error('Failed to query tenant credentials: %s', err.message);
            resolve(null);
          } else {
            resolve(row ? checkAndUpdateTrialExpirySync(row) : null);
          }
        }
      );
    });
  }
  return Promise.resolve(null);
}

function getTenantById(tenantId) {
  if (sqliteAvailable && db) {
    return new Promise((resolve) => {
      db.get(
        `SELECT * FROM tenants WHERE tenant_id = ?`,
        [tenantId],
        (err, row) => {
          if (err) {
            logger.error('Failed to query tenant by ID: %s', err.message);
            resolve(null);
          } else {
            resolve(row ? checkAndUpdateTrialExpirySync(row) : null);
          }
        }
      );
    });
  }
  return Promise.resolve(null);
}

function getAllTenants() {
  if (sqliteAvailable && db) {
    return new Promise((resolve) => {
      db.all(
        `SELECT * FROM tenants ORDER BY created_at DESC`,
        (err, rows) => {
          if (err) {
            logger.error('Failed to list tenants: %s', err.message);
            resolve([]);
          } else {
            const updatedRows = (rows || []).map(t => checkAndUpdateTrialExpirySync(t));
            resolve(updatedRows);
          }
        }
      );
    });
  }
  return Promise.resolve([]);
}

function getAllClientsWithDetails() {
  if (sqliteAvailable && db) {
    return new Promise((resolve) => {
      const query = `
        SELECT 
          t.*,
          COALESCE(c.allocated_credits, 0) as allocated_credits,
          COALESCE(c.used_credits, 0) as used_credits,
          COALESCE(c.remaining_credits, 0) as remaining_credits,
          (SELECT COUNT(*) FROM message_logs WHERE tenant_id = t.tenant_id AND status = 'success') as total_messages_sent
        FROM tenants t
        LEFT JOIN tenant_credits c ON t.tenant_id = c.tenant_id
        ORDER BY t.created_at DESC
      `;
      db.all(query, (err, rows) => {
        if (err) {
          logger.error('Failed to query all clients with details: %s', err.message);
          resolve([]);
        } else {
          const updatedRows = (rows || []).map(t => checkAndUpdateTrialExpirySync(t));
          resolve(updatedRows);
        }
      });
    });
  }
  return Promise.resolve([]);
}

function deleteTenant(tenantId) {
  if (sqliteAvailable && db) {
    return new Promise((resolve) => {
      db.serialize(() => {
        db.run('BEGIN TRANSACTION', (beginErr) => {
          if (beginErr) {
            logger.error('Failed to begin transaction for tenant deletion: %s', beginErr.message);
            return resolve(false);
          }

          db.run(`DELETE FROM message_logs WHERE tenant_id = ?`, [tenantId], (err1) => {
            if (err1) {
              logger.error('Error deleting message_logs: %s', err1.message);
              db.run('ROLLBACK');
              return resolve(false);
            }

            db.run(`DELETE FROM recharge_history WHERE tenant_id = ?`, [tenantId], (err2) => {
              if (err2) {
                logger.error('Error deleting recharge_history: %s', err2.message);
                db.run('ROLLBACK');
                return resolve(false);
              }

              db.run(`DELETE FROM tenant_credits WHERE tenant_id = ?`, [tenantId], (err3) => {
                if (err3) {
                  logger.error('Error deleting tenant_credits: %s', err3.message);
                  db.run('ROLLBACK');
                  return resolve(false);
                }

                db.run(`DELETE FROM tenants WHERE tenant_id = ?`, [tenantId], function(err4) {
                  if (err4) {
                    logger.error('Error deleting tenants record: %s', err4.message);
                    db.run('ROLLBACK');
                    return resolve(false);
                  }

                  db.run('COMMIT', (commitErr) => {
                    if (commitErr) {
                      logger.error('Failed to commit transaction for tenant deletion: %s', commitErr.message);
                      db.run('ROLLBACK');
                      return resolve(false);
                    }
                    logger.info(`[Tenant: ${tenantId}] Transaction committed: Permanently deleted tenant and all associated records.`);
                    resolve(true);
                  });
                });
              });
            });
          });
        });
      });
    });
  }
  return Promise.resolve(false);
}

function addCredits(tenantId, amount, notes) {
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
  if (sqliteAvailable && db) {
    return new Promise((resolve) => {
      db.serialize(() => {
        db.run(
          `INSERT INTO tenant_credits (tenant_id, allocated_credits, used_credits, remaining_credits, updated_at)
           VALUES (?, ?, 0, ?, ?)
           ON CONFLICT(tenant_id) DO UPDATE SET
             allocated_credits = allocated_credits + excluded.allocated_credits,
             remaining_credits = remaining_credits + excluded.remaining_credits,
             updated_at = excluded.updated_at`,
          [tenantId, amount, amount, timestamp],
          function(err) {
            if (err) {
              logger.error('Failed to update tenant credits: %s', err.message);
              return resolve(false);
            }
            
            db.run(
              `INSERT INTO recharge_history (tenant_id, amount, action, notes, created_at) VALUES (?, ?, 'allocate', ?, ?)`,
              [tenantId, amount, notes || 'Credit Allocation', timestamp],
              (histErr) => {
                if (histErr) {
                  logger.error('Failed to log credit recharge history: %s', histErr.message);
                }
                resolve(true);
              }
            );
          }
        );
      });
    });
  }
  return Promise.resolve(false);
}

function deductCredit(tenantId, amount = 1) {
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
  if (sqliteAvailable && db) {
    return new Promise((resolve) => {
      db.run(
        `UPDATE tenant_credits 
         SET used_credits = used_credits + ?, 
             remaining_credits = CASE WHEN remaining_credits >= ? THEN remaining_credits - ? ELSE 0 END,
             updated_at = ?
         WHERE tenant_id = ?`,
        [amount, amount, amount, timestamp, tenantId],
        function(err) {
          if (err) {
            logger.error('Failed to deduct tenant credit: %s', err.message);
            resolve(false);
          } else {
            resolve(this.changes > 0);
          }
        }
      );
    });
  }
  return Promise.resolve(false);
}

function getCreditBalance(tenantId) {
  if (sqliteAvailable && db) {
    return new Promise((resolve) => {
      db.get(
        `SELECT * FROM tenant_credits WHERE tenant_id = ?`,
        [tenantId],
        (err, row) => {
          if (err) {
            logger.error('Failed to get credit balance: %s', err.message);
            resolve(null);
          } else {
            resolve(row || { tenant_id: tenantId, allocated_credits: 0, used_credits: 0, remaining_credits: 0 });
          }
        }
      );
    });
  }
  return Promise.resolve(null);
}

function getRechargeHistory(tenantId) {
  if (sqliteAvailable && db) {
    return new Promise((resolve) => {
      db.all(
        `SELECT * FROM recharge_history WHERE tenant_id = ? ORDER BY created_at DESC`,
        [tenantId],
        (err, rows) => {
          if (err) {
            logger.error('Failed to get recharge history: %s', err.message);
            resolve([]);
          } else {
            resolve(rows || []);
          }
        }
      );
    });
  }
  return Promise.resolve([]);
}

function getGlobalRechargeHistory() {
  if (sqliteAvailable && db) {
    return new Promise((resolve) => {
      db.all(
        `SELECT * FROM recharge_history ORDER BY created_at DESC`,
        (err, rows) => {
          if (err) {
            logger.error('Failed to get global recharge history: %s', err.message);
            resolve([]);
          } else {
            resolve(rows || []);
          }
        }
      );
    });
  }
  return Promise.resolve([]);
}

function getUsageStats(tenantId) {
  if (sqliteAvailable && db) {
    return new Promise((resolve) => {
      const today = new Date().toISOString().substring(0, 10) + '%';
      const thisMonth = new Date().toISOString().substring(0, 7) + '%';
      db.get(
        `SELECT 
          SUM(CASE WHEN created_at LIKE ? AND status = 'success' THEN 1 ELSE 0 END) as today_count,
          SUM(CASE WHEN created_at LIKE ? AND status = 'success' THEN 1 ELSE 0 END) as month_count
         FROM message_logs WHERE tenant_id = ?`,
        [today, thisMonth, tenantId],
        (err, row) => {
          if (err) {
            logger.error('Failed to query usage stats: %s', err.message);
            resolve({ today: 0, month: 0 });
          } else {
            resolve({
              today: row ? (row.today_count || 0) : 0,
              month: row ? (row.month_count || 0) : 0
            });
          }
        }
      );
    });
  }
  return Promise.resolve({ today: 0, month: 0 });
}

module.exports = {
  init,
  isAvailable: () => sqliteAvailable,
  logMessage,
  updateLogStatus,
  getLogs,
  getRecentLogs: getLogs, // Alias for backwards compatibility
  getStats,
  addTenant,
  getTenantByEmail,
  createGoogleTenant,
  updateTenantLogin,
  updateTenantStatus,
  updateTrialExpiry,
  getTenantByCredentials,
  getTenantById,
  getAllTenants,
  getAllClientsWithDetails,
  deleteTenant,
  addCredits,
  deductCredit,
  getCreditBalance,
  getRechargeHistory,
  getGlobalRechargeHistory,
  getUsageStats,
  get dbInstance() { return db; }
};
