#!/usr/bin/env node
/**
 * Automated Updater & Maintenance Script for whatsapp-web.js
 *
 * Usage:
 *   node scripts/update-whatsapp.js              # Check & update if a newer version exists
 *   node scripts/update-whatsapp.js --check      # Check only (no installation)
 *   node scripts/update-whatsapp.js --force      # Force reinstall & re-patch
 *   node scripts/update-whatsapp.js --reload     # Update & trigger zero-downtime PM2 reload
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const LOGS_DIR = path.join(ROOT, 'logs');
const BACKUP_DIR = path.join(LOGS_DIR, 'backups');
const LOG_FILE = path.join(LOGS_DIR, 'update.log');

function ensureDirs() {
  if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function log(msg) {
  ensureDirs();
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch (e) {
    // Ignore file logging error if directory is locked
  }
}

const SEMVER_REGEX = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function isValidSemver(version) {
  return typeof version === 'string' && SEMVER_REGEX.test(version.trim());
}

function fetchJson(url, timeoutMs = 8000) {
  const maxBytes = 1024 * 1024; // 1 MB max response guard
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'whatsapp-busy-gateway-updater',
        'Accept': 'application/json'
      }
    }, (res) => {
      if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
      }
      let data = '';
      let receivedBytes = 0;
      res.on('data', chunk => {
        receivedBytes += chunk.length;
        if (receivedBytes > maxBytes) {
          req.destroy(new Error(`Response exceeded ${maxBytes} bytes limit`));
          return;
        }
        data += chunk;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Timeout after ${timeoutMs}ms fetching ${url}`));
    });
  });
}

function getInstalledVersion() {
  const pkgPath = path.join(ROOT, 'node_modules', 'whatsapp-web.js', 'package.json');
  if (!fs.existsSync(pkgPath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
}

function pruneWWebCache(maxKeep = 3) {
  const cacheDir = path.join(ROOT, '.wwebjs_cache');
  if (!fs.existsSync(cacheDir)) return { totalFound: 0, kept: [], pruned: [] };

  const htmlFiles = fs.readdirSync(cacheDir)
    .filter(f => f.endsWith('.html'))
    .map(name => {
      const fullPath = path.join(cacheDir, name);
      const stat = fs.statSync(fullPath);
      return { name, fullPath, mtimeMs: stat.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const toKeep = htmlFiles.slice(0, maxKeep).map(f => f.name);
  const toPrune = htmlFiles.slice(maxKeep);
  const pruned = [];

  for (const file of toPrune) {
    try {
      fs.unlinkSync(file.fullPath);
      pruned.push(file.name);
    } catch (err) {
      log(`Notice: could not delete old cache file ${file.name}: ${err.message}`);
    }
  }

  return { totalFound: htmlFiles.length, kept: toKeep, pruned };
}

function applyMediaPatch() {
  const utilsPath = path.join(ROOT, 'node_modules', 'whatsapp-web.js', 'src', 'util', 'Injected', 'Utils.js');
  if (!fs.existsSync(utilsPath)) {
    log('Notice: Utils.js not found; skipping media patch check.');
    return false;
  }

  let content = fs.readFileSync(utilsPath, 'utf8');
  let modified = false;

  if (!content.includes('delete mediaOptions.id;')) {
    content = content.replace(
      'delete options.sendMediaAsSticker;',
      'delete options.sendMediaAsSticker;\n            delete mediaOptions.id;\n            delete mediaOptions.__x_id;'
    );
    modified = true;
  }

  if (!content.includes('// Fix: WhatsApp Web MobX memoization getter collision')) {
    content = content.replace(
      '...extraOptions,\n        };',
      '...extraOptions,\n        };\n\n        // Fix: WhatsApp Web MobX memoization getter collision on media send (#2271)\n        delete message.__x_id;\n        message.id = newMsgKey;'
    );
    modified = true;
  }

  if (modified) {
    fs.writeFileSync(utilsPath, content, 'utf8');
    log('Applied runtime media memoization patch to whatsapp-web.js Utils.js');
  } else {
    log('Verified whatsapp-web.js Utils.js media patch is already present.');
  }
  return true;
}

async function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes('--check');
  const forceUpdate = args.includes('--force');
  const reloadPm2 = args.includes('--reload');

  const installed = getInstalledVersion();
  log(`Installed whatsapp-web.js: ${installed ? 'v' + installed : 'not installed'}`);

  // Prune & inspect .wwebjs_cache
  const cacheSummary = pruneWWebCache(3);
  log(`Cached WhatsApp Web builds (${cacheSummary.totalFound} total, keeping ${cacheSummary.kept.length}): ${cacheSummary.kept.join(', ') || 'none'}`);
  if (cacheSummary.pruned.length > 0) {
    log(`Pruned ${cacheSummary.pruned.length} stale cached build(s): ${cacheSummary.pruned.join(', ')}`);
  }

  let latestNpm = null;
  let latestGithub = null;

  const [npmRes, ghRes] = await Promise.allSettled([
    fetchJson('https://registry.npmjs.org/whatsapp-web.js/latest'),
    fetchJson('https://api.github.com/repos/pedroslopez/whatsapp-web.js/releases/latest')
  ]);

  if (npmRes.status === 'fulfilled' && npmRes.value?.version) {
    const candidate = String(npmRes.value.version).trim();
    if (isValidSemver(candidate)) {
      latestNpm = candidate;
      log(`Latest npm version:        v${latestNpm}`);
    } else {
      log('Warning: Ignored malformed version string from npm registry.');
    }
  } else {
    log(`Warning: Could not fetch npm registry version (${npmRes.reason?.message || 'unknown error'})`);
  }

  if (ghRes.status === 'fulfilled' && ghRes.value?.tag_name) {
    const candidate = String(ghRes.value.tag_name).replace(/^v/i, '').trim();
    if (isValidSemver(candidate)) {
      latestGithub = candidate;
      log(`Latest GitHub release:     v${latestGithub}`);
    }
  }

  const targetVersion = latestNpm || latestGithub;
  if (!targetVersion || !isValidSemver(targetVersion)) {
    log('Error: Unable to determine a valid SemVer release version from npm or GitHub.');
    process.exit(1);
  }

  if (installed === targetVersion && !forceUpdate) {
    log('whatsapp-web.js is already up-to-date. Verifying runtime patch integrity...');
    applyMediaPatch();
    return;
  }

  if (checkOnly) {
    log(`Update available: v${installed} -> v${targetVersion}. Run without --check to install.`);
    return;
  }

  // Backup package.json and package-lock.json before updating
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const pkgPath = path.join(ROOT, 'package.json');
  const lockPath = path.join(ROOT, 'package-lock.json');
  const pkgBackup = path.join(BACKUP_DIR, `package-${stamp}.json`);
  const lockBackup = path.join(BACKUP_DIR, `package-lock-${stamp}.json`);

  try {
    if (fs.existsSync(pkgPath)) fs.copyFileSync(pkgPath, pkgBackup);
    if (fs.existsSync(lockPath)) fs.copyFileSync(lockPath, lockBackup);
    log(`Backed up package manifests to logs/backups/`);
  } catch (backupErr) {
    log(`Warning: Failed to backup package manifests: ${backupErr.message}`);
  }

  log(`Updating whatsapp-web.js (${installed || 'none'} -> ${targetVersion})...`);
  try {
    execSync(`npm install whatsapp-web.js@${targetVersion} --save`, {
      cwd: ROOT,
      stdio: 'inherit'
    });
    const newInstalled = getInstalledVersion();
    log(`Updated whatsapp-web.js successfully to v${newInstalled}`);

    // Re-apply runtime patch immediately
    applyMediaPatch();

    if (reloadPm2) {
      log('Triggering zero-downtime PM2 reload...');
      try {
        execSync('pm2 reload ecosystem.config.js --update-env', {
          cwd: ROOT,
          stdio: 'inherit'
        });
        log('PM2 reload completed successfully.');
      } catch (pm2Err) {
        log(`Warning: PM2 reload command failed (${pm2Err.message}). Restart manually if running under PM2.`);
      }
    } else {
      log('Note: Restart or reload the gateway (pm2 reload ecosystem.config.js --update-env) to load the updated package in memory.');
    }
  } catch (err) {
    log(`Update failed: ${err.message}. Restoring backup package manifests...`);
    try {
      if (fs.existsSync(pkgBackup)) fs.copyFileSync(pkgBackup, pkgPath);
      if (fs.existsSync(lockBackup)) fs.copyFileSync(lockBackup, lockPath);
    } catch (restoreErr) {
      log(`Failed to restore package manifests: ${restoreErr.message}`);
    }
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  isValidSemver,
  getInstalledVersion,
  pruneWWebCache,
  applyMediaPatch
};
