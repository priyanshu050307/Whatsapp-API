module.exports = {
  apps: [
    {
      name: 'whatsapp-gateway',
      script: 'app.js',
      instances: 1, // Fork mode to prevent session caches and SQLite lock contentions
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '1G', // Guard against Puppeteer chromium memory leaks
      env: {
        NODE_ENV: 'development',
        PORT: 3005
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3005,
        MASTER_ADMIN_PASSWORD: 'master_admin_pass'
      },
      error_file: 'logs/pm2-error.log',
      out_file: 'logs/pm2-out.log',
      merge_logs: true,
      time: true
    }
  ]
};
