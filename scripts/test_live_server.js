const http = require('http');

const PORT = 3005;
const BASE_URL = `http://localhost:${PORT}`;

function makeRequest(method, path, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const options = {
      method: method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
        ...headers
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ status: res.statusCode, data: json });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });

    req.on('error', (err) => reject(err));

    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

async function runLiveHttpTests() {
  console.log(`=== LIVE SERVER END-TO-END HTTP TEST ON PORT ${PORT} ===\n`);

  // 1. Admin Login
  console.log('[1/10] Testing Admin Login (POST /api/auth/admin/login)...');
  const adminLoginRes = await makeRequest('POST', '/api/auth/admin/login', {}, { password: 'admin123' });
  if (adminLoginRes.status !== 200 || !adminLoginRes.data.token) {
    console.error('FAILED: Admin login failed:', adminLoginRes.data);
    process.exit(1);
  }
  const adminToken = adminLoginRes.data.token;
  console.log(`PASSED: Admin Login Success. Token: ${adminToken.substring(0, 25)}...\n`);

  // 2. Google Client Login (Signup)
  console.log('[2/10] Testing Google Client Login (POST /api/auth/google)...');
  const liveEmail = `live_user_${Date.now()}@gmail.com`;
  const clientLoginRes = await makeRequest('POST', '/api/auth/google', {}, {
    email: liveEmail,
    name: 'Live Test Client',
    sub: 'google_live_123'
  });
  if (clientLoginRes.status !== 200 || !clientLoginRes.data.token) {
    console.error('FAILED: Client signup failed:', clientLoginRes.data);
    process.exit(1);
  }
  const clientToken = clientLoginRes.data.token;
  const tenantId = clientLoginRes.data.tenant.tenant_id;
  console.log(`PASSED: Client Signup Success. Tenant ID: ${tenantId}, Email: ${liveEmail}\n`);

  // 3. Client Dashboard Fetch
  console.log('[3/10] Testing Client Dashboard (GET /api/client/dashboard)...');
  const clientDashRes = await makeRequest('GET', '/api/client/dashboard', { 'Authorization': `Bearer ${clientToken}` });
  if (clientDashRes.status !== 200 || clientDashRes.data.status !== 'success') {
    console.error('FAILED: Client dashboard fetch failed:', clientDashRes.data);
    process.exit(1);
  }
  console.log(`PASSED: Client Dashboard fetched live. Remaining Days: ${clientDashRes.data.client.remaining_trial_days}, Credits: ${clientDashRes.data.credits.remaining}\n`);

  // 4. Admin Clients Directory Fetch
  console.log('[4/10] Testing Admin Clients List (GET /api/admin/clients)...');
  const adminClientsRes = await makeRequest('GET', `/api/admin/clients?_t=${Date.now()}`, { 'Authorization': `Bearer ${adminToken}` });
  if (adminClientsRes.status !== 200 || !adminClientsRes.data.clients) {
    console.error('FAILED: Admin clients list failed:', adminClientsRes.data);
    process.exit(1);
  }
  console.log(`PASSED: Admin retrieved ${adminClientsRes.data.clients.length} live client accounts.\n`);

  // 5. Action 1: Extend Trial Expiry
  console.log('[5/10] Live Testing Action 1: Extend Trial Expiry (POST /api/admin/clients/:tenantId/trial)...');
  const extendRes = await makeRequest('POST', `/api/admin/clients/${tenantId}/trial`, { 'Authorization': `Bearer ${adminToken}` }, { days: 20 });
  if (extendRes.status !== 200 || extendRes.data.status !== 'success') {
    console.error('FAILED: Extend Trial failed:', extendRes.data);
    process.exit(1);
  }
  console.log(`PASSED: ${extendRes.data.message}\n`);

  // 6. Action 2: Recharge Credits
  console.log('[6/10] Live Testing Action 2: Recharge Credits (POST /api/admin/clients/:tenantId/credits)...');
  const rechargeRes = await makeRequest('POST', `/api/admin/clients/${tenantId}/credits`, { 'Authorization': `Bearer ${adminToken}` }, { amount: 350, notes: 'Live Test Allocation' });
  if (rechargeRes.status !== 200 || rechargeRes.data.status !== 'success') {
    console.error('FAILED: Recharge Credits failed:', rechargeRes.data);
    process.exit(1);
  }
  console.log(`PASSED: ${rechargeRes.data.message}\n`);

  // 7. Action 3: Change Account Status
  console.log('[7/10] Live Testing Action 3: Change Account Status (POST /api/admin/clients/:tenantId/status)...');
  const statusRes = await makeRequest('POST', `/api/admin/clients/${tenantId}/status`, { 'Authorization': `Bearer ${adminToken}` }, { accountStatus: 'suspended' });
  if (statusRes.status !== 200 || statusRes.data.status !== 'success') {
    console.error('FAILED: Change Status failed:', statusRes.data);
    process.exit(1);
  }
  console.log(`PASSED: ${statusRes.data.message}\n`);

  // 8. Action 4: Disconnect WhatsApp
  console.log('[8/10] Live Testing Action 4: Disconnect WhatsApp (POST /api/admin/clients/:tenantId/whatsapp/logout)...');
  const logoutRes = await makeRequest('POST', `/api/admin/clients/${tenantId}/whatsapp/logout`, { 'Authorization': `Bearer ${adminToken}` });
  if (logoutRes.status !== 200 || logoutRes.data.status !== 'success') {
    console.error('FAILED: Disconnect WhatsApp failed:', logoutRes.data);
    process.exit(1);
  }
  console.log(`PASSED: ${logoutRes.data.message}\n`);

  // 9. Action 5: Delete Client Account
  console.log('[9/10] Live Testing Action 5: Delete Client Account (DELETE /api/admin/clients/:tenantId)...');
  const deleteRes = await makeRequest('DELETE', `/api/admin/clients/${tenantId}`, { 'Authorization': `Bearer ${adminToken}` });
  if (deleteRes.status !== 200 || deleteRes.data.status !== 'success') {
    console.error('FAILED: Delete Account failed:', deleteRes.data);
    process.exit(1);
  }
  console.log(`PASSED: ${deleteRes.data.message}\n`);

  // 10. Verify Deleted Tenant 404
  console.log('[10/10] Verifying Deleted Tenant Returns 404...');
  const detailRes = await makeRequest('GET', `/api/admin/clients/${tenantId}`, { 'Authorization': `Bearer ${adminToken}` });
  if (detailRes.status !== 404) {
    console.error(`FAILED: Expected 404 for deleted tenant, got ${detailRes.status}`);
    process.exit(1);
  }
  console.log('PASSED: Deleted tenant confirmed 404 Not Found.\n');

  console.log('===========================================================');
  console.log(' ALL 10 LIVE HTTP ENDPOINTS PASSED CLEANLY ON PORT 3005! ');
  console.log('===========================================================');
  process.exit(0);
}

runLiveHttpTests().catch(err => {
  console.error('LIVE HTTP TEST ERROR:', err);
  process.exit(1);
});
