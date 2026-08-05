const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '../logs/database.db');
const BACKUP_DIR = path.join(__dirname, '../logs/backups');

function runBackup() {
  console.log('Starting SQLite database backup...');
  
  if (!fs.existsSync(DB_PATH)) {
    console.error(`Database file not found at: ${DB_PATH}`);
    process.exit(1);
  }
  
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
  
  const timestamp = new Date().toISOString().replace(/[:T]/g, '-').substring(0, 19);
  const backupPath = path.join(BACKUP_DIR, `database-${timestamp}.db`);
  
  try {
    fs.copyFileSync(DB_PATH, backupPath);
    console.log(`Backup completed successfully: ${backupPath}`);
    
    // Cleanup backups older than 30 days
    cleanupOldBackups();
  } catch (err) {
    console.error('Backup failed:', err.message);
    process.exit(1);
  }
}

function cleanupOldBackups() {
  const files = fs.readdirSync(BACKUP_DIR);
  const now = Date.now();
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  
  files.forEach(file => {
    if (file.startsWith('database-') && file.endsWith('.db')) {
      const filePath = path.join(BACKUP_DIR, file);
      const stats = fs.statSync(filePath);
      
      if (now - stats.mtimeMs > THIRTY_DAYS_MS) {
        fs.unlinkSync(filePath);
        console.log(`Deleted old backup file: ${file}`);
      }
    }
  });
}

runBackup();
