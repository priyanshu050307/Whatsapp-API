const io = require('socket.io-client');
const http = require('http');
const db = require('../services/db');
const jwt = require('jsonwebtoken');
const config = require('../config/config');

async function verifyRealTimeEngine() {
  console.log('=== VERIFYING REAL-TIME SOCKET.IO ENGINE & WHATSAPP WEB INTEGRATION ===\n');

  // 1. Initialize DB & Configuration
  console.log('[1/5] Initializing Database & Auth Configuration...');
  await db.init();
  const activeConfig = config.get();
  const secret = activeConfig.JWT_SECRET || 'secret';
  console.log('PASSED: Database & Auth Config Ready.\n');

  // 2. Generate Tokens for Tenant A and Tenant B
  console.log('[2/5] Seeding Tenant A and Tenant B with Isolated Tokens...');
  const tenantA = await db.createGoogleTenant({ email: `socket_a_${Date.now()}@gmail.com`, name: 'Tenant A' });
  const tenantB = await db.createGoogleTenant({ email: `socket_b_${Date.now()}@gmail.com`, name: 'Tenant B' });

  const tokenA = jwt.sign({ tenantId: tenantA.tenant_id, email: tenantA.email }, secret, { expiresIn: '1h' });
  const tokenB = jwt.sign({ tenantId: tenantB.tenant_id, email: tenantB.email }, secret, { expiresIn: '1h' });

  console.log(`PASSED: Generated JWTs for Tenant A (${tenantA.tenant_id}) & Tenant B (${tenantB.tenant_id}).\n`);

  // 3. Test Live Socket.IO Authentication & Multi-Tenant Isolation
  console.log('[3/5] Connecting Sockets for Tenant A and Tenant B to Live Server (http://localhost:3005)...');
  
  const socketA = io('http://localhost:3005', { auth: { token: tokenA }, reconnection: false });
  const socketB = io('http://localhost:3005', { auth: { token: tokenB }, reconnection: false });

  let receivedMessageA = false;
  let receivedMessageB = false;

  await new Promise((resolve, reject) => {
    let connectedCount = 0;
    
    socketA.on('connect', () => {
      connectedCount++;
      if (connectedCount === 2) resolve();
    });

    socketB.on('connect', () => {
      connectedCount++;
      if (connectedCount === 2) resolve();
    });

    socketA.on('connect_error', (err) => reject(new Error('Socket A connection failed: ' + err.message)));
    socketB.on('connect_error', (err) => reject(new Error('Socket B connection failed: ' + err.message)));

    setTimeout(() => reject(new Error('Socket connection timed out')), 5000);
  });

  console.log('PASSED: Sockets connected and authenticated for both Tenant A and Tenant B.\n');

  // 4. Test Multi-Tenant Event Isolation (Triggering message via API for Tenant A)
  console.log('[4/5] Testing Real-Time Event Isolation (Emitting event to Tenant A)...');
  
  socketA.on('whatsapp_message', (data) => {
    console.log(' -> Socket A received real-time event:', data.body);
    receivedMessageA = true;
  });

  socketB.on('whatsapp_message', (data) => {
    console.log(' -> ERROR: Socket B received Tenant A message!', data.body);
    receivedMessageB = true;
  });

  // Make HTTP API request as Tenant A to trigger real-time socket event on server
  const req = http.request({
    hostname: 'localhost',
    port: 3005,
    path: '/api/test/emit-socket',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${tokenA}`
    }
  });
  req.write(JSON.stringify({
    id: 'test_msg_001',
    chatId: '919876543210@c.us',
    body: 'Hello Tenant A Real-Time WhatsApp Message'
  }));
  req.end();

  await new Promise(r => setTimeout(r, 1500));

  if (!receivedMessageA) {
    console.error('FAILED: Tenant A socket did not receive its real-time message!');
    process.exit(1);
  }
  if (receivedMessageB) {
    console.error('FAILED: Tenant B socket leaked Tenant A data! Tenant Isolation violated!');
    process.exit(1);
  }

  console.log('PASSED: Multi-Tenant Isolation Verified: Event received ONLY by Tenant A socket.\n');

  // 5. Cleanup Sockets & Test Accounts
  console.log('[5/5] Disconnecting Sockets & Cleaning Up Test Records...');
  socketA.disconnect();
  socketB.disconnect();
  await db.deleteTenant(tenantA.tenant_id);
  await db.deleteTenant(tenantB.tenant_id);

  console.log('================================================================');
  console.log(' ALL REAL-TIME SOCKET.IO & TENANT ISOLATION TESTS PASSED CLEANLY!');
  console.log('================================================================');
  process.exit(0);
}

verifyRealTimeEngine().catch(err => {
  console.error('FATAL REAL-TIME VERIFICATION ERROR:', err);
  process.exit(1);
});
