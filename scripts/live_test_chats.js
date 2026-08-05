/**
 * Direct live test of WhatsApp getChats - bypasses HTTP layer
 * Run AFTER the main server to test the same session state
 * node scripts/live_test_chats.js
 */

const db = require('../services/db');
const whatsappService = require('../services/whatsapp');
const { Client, LocalAuth } = require('whatsapp-web.js');
const path = require('path');
const fs = require('fs');
const config = require('../config/config');

async function testDirectChats() {
  console.log('\n=== Live WhatsApp Chat Test ===\n');
  
  await db.init();
  
  const targetTenantId = 'tenant_rkv_busy_gmail__8d0dcc';
  const sessionPath = path.resolve(config.get().SESSION_PATH || './session', targetTenantId);
  
  console.log(`Target tenant: ${targetTenantId}`);
  console.log(`Session path: ${sessionPath}`);
  console.log(`Session path exists: ${fs.existsSync(sessionPath)}`);
  
  if (!fs.existsSync(sessionPath)) {
    console.error('ERROR: Session path does not exist. WhatsApp has never been authenticated for this tenant.');
    process.exit(1);
  }
  
  // Create a fresh client instance to test directly
  console.log('\nCreating fresh WhatsApp client...');
  
  const execPath = (() => {
    const p = path.join(process.env.USERPROFILE || 'C:\\Users\\Admin', '.cache\\puppeteer\\chrome\\win64-146.0.7680.31\\chrome-win64\\chrome.exe');
    return fs.existsSync(p) ? p : 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  })();
  
  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: targetTenantId,
      dataPath: path.resolve(config.get().SESSION_PATH || './session')
    }),
    puppeteer: {
      headless: true,
      executablePath: execPath,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--single-process'],
    }
  });
  
  client.on('loading_screen', (percent, msg) => {
    console.log(`Loading: ${percent}% - ${msg}`);
  });
  
  client.on('authenticated', () => console.log('✓ Authenticated!'));
  
  client.on('ready', async () => {
    console.log('✓ Client READY!\n');
    
    const info = client.info;
    console.log(`Connected number: ${info?.me?.user}`);
    console.log(`Pushname: ${info?.pushname}`);
    
    console.log('\nFetching chats...');
    try {
      const chats = await client.getChats();
      console.log(`✓ getChats() returned: ${chats.length} chats\n`);
      
      if (chats.length > 0) {
        console.log('First 5 chats:');
        chats.slice(0, 5).forEach(c => {
          console.log(`  ${c.name || c.id.user} | ${c.id._serialized} | unread:${c.unreadCount}`);
        });
      } else {
        console.log('⚠️  0 chats returned from getChats()');
        
        // Try DOM evaluation
        console.log('\nTrying Puppeteer Store evaluation...');
        try {
          const storeInfo = await client.pupPage.evaluate(() => {
            const store = window.Store;
            if (!store) return { error: 'window.Store is null/undefined' };
            if (!store.Chat) return { error: 'window.Store.Chat is null/undefined' };
            const models = store.Chat.models;
            if (!models) return { error: 'window.Store.Chat.models is null/undefined' };
            return { count: models.length, type: typeof models };
          });
          console.log('Store evaluation result:', JSON.stringify(storeInfo));
          
          if (storeInfo.count > 0) {
            const firstFew = await client.pupPage.evaluate(() => {
              return window.Store.Chat.models.slice(0, 5).map(m => ({
                id: m.id?._serialized || m.id,
                name: m.name || m.formattedTitle,
                unread: m.unreadCount
              }));
            });
            console.log('Store chats:', JSON.stringify(firstFew, null, 2));
          }
        } catch (storeErr) {
          console.error('Store evaluation error:', storeErr.message);
        }
      }
    } catch (err) {
      console.error('getChats() ERROR:', err.message);
      console.error(err.stack);
    }
    
    await client.destroy();
    console.log('\nClient destroyed. Test complete.');
    process.exit(0);
  });
  
  client.on('auth_failure', (msg) => {
    console.error('Auth failure:', msg);
    process.exit(1);
  });
  
  client.on('disconnected', (reason) => {
    console.warn('Client disconnected:', reason);
    process.exit(1);
  });
  
  console.log('Initializing client...');
  await client.initialize();
}

testDirectChats().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
