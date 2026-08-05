const http = require('http');

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

async function verifyAuthFlows() {
  console.log('=== VERIFYING CLIENT & ADMIN AUTHENTICATION FLOWS (LIVE SERVER PORT 3005) ===\n');

  // 1. Test Client Google Login
  console.log('[1/5] Testing Client Sign-In (Google OAuth Payload)...');
  const testEmail = `zoho_ui_test_${Date.now()}@gmail.com`;
  const clientRes = await makeRequest({
    hostname: 'localhost',
    port: 3005,
    path: '/api/auth/google',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { email: testEmail, name: 'Zoho SaaS Test User' });

  if (clientRes.status !== 200 || !clientRes.data.token) {
    console.error('FAILED: Client Google Login Failed:', clientRes);
    process.exit(1);
  }
  const clientToken = clientRes.data.token;
  console.log(`PASSED: Client Sign-In Success. Token received for tenant ${clientRes.data.tenant.tenant_id}.\n`);

  // 2. Test Admin Login with Valid Master Password
  console.log('[2/5] Testing Admin Sign-In with Valid Master Password ("admin123")...');
  const adminRes = await makeRequest({
    hostname: 'localhost',
    port: 3005,
    path: '/api/auth/admin/login',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { password: 'admin123' });

  if (adminRes.status !== 200 || !adminRes.data.token) {
    console.error('FAILED: Admin Login Failed:', adminRes);
    process.exit(1);
  }
  const adminToken = adminRes.data.token;
  console.log('PASSED: Master Admin Sign-In Success. Valid JWT Admin Session Token generated.\n');

  // 3. Test Client Dashboard Access
  console.log('[3/5] Testing Client Dashboard Access with Client Bearer Token...');
  const dashRes = await makeRequest({
    hostname: 'localhost',
    port: 3005,
    path: '/api/client/dashboard',
    method: 'GET',
    headers: { 'Authorization': `Bearer ${clientToken}` }
  });

  if (dashRes.status !== 200 || dashRes.data.status !== 'success') {
    console.error('FAILED: Client Dashboard Access Failed:', dashRes);
    process.exit(1);
  }
  console.log(`PASSED: Client Dashboard Loaded cleanly for email ${dashRes.data.client.email}.\n`);

  // 4. Test Admin Clients Directory Access
  console.log('[4/5] Testing Admin Directory Access with Admin Bearer Token...');
  const adminDirRes = await makeRequest({
    hostname: 'localhost',
    port: 3005,
    path: '/api/admin/clients',
    method: 'GET',
    headers: { 'Authorization': `Bearer ${adminToken}` }
  });

  if (adminDirRes.status !== 200 || adminDirRes.data.status !== 'success') {
    console.error('FAILED: Admin Directory Access Failed:', adminDirRes);
    process.exit(1);
  }
  console.log(`PASSED: Admin Directory Loaded cleanly. Total Clients: ${adminDirRes.data.clients.length}.\n`);

  // 5. Test Admin Invalid Password Handling
  console.log('[5/5] Testing Admin Invalid Password Validation (Should return HTTP 401)...');
  const invalidAdminRes = await makeRequest({
    hostname: 'localhost',
    port: 3005,
    path: '/api/auth/admin/login',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { password: 'wrong_password_123' });

  if (invalidAdminRes.status !== 401 || invalidAdminRes.data.status !== 'failed') {
    console.error('FAILED: Invalid Admin Password was not rejected cleanly:', invalidAdminRes);
    process.exit(1);
  }
  console.log(`PASSED: Invalid Password Rejected with clear reason: "${invalidAdminRes.data.reason}".\n`);

  // Cleanup test client
  console.log('[Cleanup] Removing temporary test client account...');
  await makeRequest({
    hostname: 'localhost',
    port: 3005,
    path: `/api/admin/clients/${clientRes.data.tenant.tenant_id}`,
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${adminToken}` }
  });

  console.log('========================================================================');
  console.log(' ALL CLIENT & ADMIN AUTHENTICATION FLOWS PASSED PERFECTLY!');
  console.log('========================================================================');
  process.exit(0);
}

verifyAuthFlows().catch(err => {
  console.error('FATAL TEST ERROR:', err);
  process.exit(1);
});
