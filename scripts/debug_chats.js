/**
 * Quick diagnostic: test chat retrieval directly against running server
 * Run: node scripts/debug_chats.js
 */

const http = require('http');

// We need to get a token first - use the auth endpoint
function httpRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function run() {
  console.log('\n======== WhatsApp Chat API Diagnostic ========\n');

  // Step 1: Check whatsapp service status directly
  const whatsappService = require('../services/whatsapp');
  
  // Find all sessions
  const db = require('../services/db');
  const tenants = await db.getAllTenants();
  
  console.log(`Total tenants: ${tenants.length}`);
  
  for (const tenant of tenants) {
    const state = whatsappService.getClientState(tenant.tenant_id);
    const info = whatsappService.getClientInfo(tenant.tenant_id);
    
    if (state === 'READY') {
      console.log(`\n[READY] Tenant: ${tenant.tenant_id}`);
      console.log(`  Phone: ${info.number}, Name: ${info.pushname}`);
      
      // Test getChats directly
      console.log(`  Testing getChats()...`);
      try {
        const chats = await whatsappService.getChats(tenant.tenant_id);
        console.log(`  getChats() returned: ${chats.length} chats`);
        if (chats.length > 0) {
          console.log(`  First 3 chats:`);
          chats.slice(0, 3).forEach(c => {
            console.log(`    - ${c.name} (${c.id}) | ${c.lastMessage?.body?.substring(0, 30)}`);
          });
        } else {
          console.log(`  ⚠️  NO CHATS RETURNED - investigating...`);
          
          // Try direct client.getChats()
          const sessions = require('../services/whatsapp');
          // We can't access session directly but let's check queue length
          const qLen = whatsappService.getQueueLength(tenant.tenant_id);
          console.log(`  Message queue length: ${qLen}`);
          
          // Check logs
          const logs = await db.getRecentLogs(tenant.tenant_id, 10);
          console.log(`  Recent DB logs: ${logs.length}`);
          if (logs.length > 0) {
            logs.slice(0, 3).forEach(l => {
              console.log(`    - ${l.mobile}: ${l.message?.substring(0, 30)}`);
            });
          }
        }
      } catch (err) {
        console.error(`  getChats() ERROR: ${err.message}`);
        console.error(err.stack);
      }
    } else {
      console.log(`[${state}] Tenant: ${tenant.tenant_id.substring(0, 30)}...`);
    }
  }
  
  process.exit(0);
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
