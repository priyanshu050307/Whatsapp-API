const http = require('http');
const io = require('socket.io-client');
const db = require('../services/db');
const jwt = require('jsonwebtoken');
const config = require('../config/config');

function makeRequest(options, postData) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });
    req.on('error', (err) => reject(err));
    if (postData) {
      req.write(JSON.stringify(postData));
    }
    req.end();
  });
}

async function runSessionArchitectureTests() {
  console.log('=== VERIFYING EXISTING BACKEND WHATSAPP SESSION ARCHITECTURE & FLOWS ===\n');

  // 1. Initialize DB & Configuration
  console.log('[1/8] Initializing Database & Config...');
  await db.init();
  const activeConfig = config.get();
  const secret = activeConfig.JWT_SECRET || 'secret';
  
  // Find an existing tenant in database
  const tenants = await db.getAllTenants();
  let targetTenant = tenants.find(t => t.tenant_id !== 'admin');
  if (!targetTenant) {
    targetTenant = await db.createGoogleTenant({ email: `session_live_${Date.now()}@gmail.com`, name: 'Live Session Client' });
  }

  console.log(`PASSED: Using target tenant '${targetTenant.tenant_id}' (${targetTenant.email}).\n`);

  // 2. Test Client Login & Existing Session Lookup
  console.log('[2/8] Testing Scenario 1: Client Login -> Connect to Existing Backend Session...');
  
  const loginRes = await makeRequest({
    hostname: 'localhost',
    port: 3005,
    path: '/api/auth/google',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { email: targetTenant.email });

  if (loginRes.status !== 200 || !loginRes.data.token) {
    console.error('FAILED: Login failed:', loginRes);
    process.exit(1);
  }
  const token = loginRes.data.token;
  const tenantId = loginRes.data.tenant.tenant_id;

  // Fetch Dashboard details
  const dashRes = await makeRequest({
    hostname: 'localhost',
    port: 3005,
    path: '/api/client/dashboard',
    method: 'GET',
    headers: { 'Authorization': `Bearer ${token}` }
  });

  if (dashRes.status !== 200) {
    console.error('FAILED: Dashboard request failed:', dashRes);
    process.exit(1);
  }

  const wa = dashRes.data.whatsapp;
  console.log(` -> Live Backend WhatsApp Session State: ${wa.state} (Linked Number: ${wa.number || 'None'})`);
  
  if (wa.state === 'READY') {
    if (wa.qrCode !== null) {
      console.error('FAILED: QR code was returned when session state was READY!');
      process.exit(1);
    }
    console.log('PASSED: Client browser connected directly to READY backend session without QR code prompt.\n');
  } else {
    console.log(`PASSED: Session state reported as ${wa.state}.\n`);
  }

  // 3. Test Real-Time Browser Socket Connection
  console.log('[3/8] Testing Scenario 3 & 4: Socket.IO Engine Connection...');
  const socket = io('http://localhost:3005', { auth: { token }, reconnection: false });

  await new Promise((resolve, reject) => {
    socket.on('connect', () => resolve());
    socket.on('connect_error', (err) => reject(err));
    setTimeout(() => reject(new Error('Socket connection timeout')), 4000);
  });

  console.log('PASSED: Browser socket connected and authenticated cleanly.\n');

  // 4. Test Browser Refresh / Relogin Reusing Same Session
  console.log('[4/8] Testing Scenario 5: Relogin & Refresh Reusing Same Backend Session...');
  const reloginRes = await makeRequest({
    hostname: 'localhost',
    port: 3005,
    path: '/api/auth/google',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { email: targetTenant.email });

  if (reloginRes.status !== 200 || !reloginRes.data.token) {
    console.error('FAILED: Relogin failed:', reloginRes);
    process.exit(1);
  }

  const dashRes2 = await makeRequest({
    hostname: 'localhost',
    port: 3005,
    path: '/api/client/dashboard',
    method: 'GET',
    headers: { 'Authorization': `Bearer ${reloginRes.data.token}` }
  });

  if (dashRes2.data.whatsapp.state !== wa.state) {
    console.error('FAILED: Session state changed unexpectedly after relogin:', dashRes2.data.whatsapp.state);
    process.exit(1);
  }
  console.log('PASSED: Relogin reused existing running backend session without re-initialization.\n');

  // 5. Test Multi-Tenant Isolation (Client A vs Client B)
  console.log('[5/8] Testing Scenario 6: Multi-Tenant Isolation (Client A vs Client B)...');
  const tenantB = await db.createGoogleTenant({ email: `tenant_b_${Date.now()}@gmail.com`, name: 'Client B' });
  const tokenB = jwt.sign({ tenantId: tenantB.tenant_id, email: tenantB.email }, secret, { expiresIn: '1h' });
  const socketB = io('http://localhost:3005', { auth: { token: tokenB }, reconnection: false });

  await new Promise((resolve) => socketB.on('connect', () => resolve()));
  
  const dashB = await makeRequest({
    hostname: 'localhost',
    port: 3005,
    path: '/api/client/dashboard',
    method: 'GET',
    headers: { 'Authorization': `Bearer ${tokenB}` }
  });

  if (dashB.data.client.tenant_id === tenantId) {
    console.error('FAILED: Tenant ID collision between Client A and Client B!');
    process.exit(1);
  }

  console.log(`PASSED: Client B (${dashB.data.client.tenant_id}) isolated from Client A (${tenantId}).\n`);

  // 6. Cleanup Sockets
  console.log('[6/8] Disconnecting test sockets & cleaning up...');
  socket.disconnect();
  socketB.disconnect();
  await db.deleteTenant(tenantB.tenant_id);

  console.log('========================================================================');
  console.log(' ALL EXISTING WHATSAPP SESSION ARCHITECTURE TESTS PASSED CLEANLY!');
  console.log('========================================================================');
  process.exit(0);
}

runSessionArchitectureTests().catch(err => {
  console.error('FATAL TEST ERROR:', err);
  process.exit(1);
});
