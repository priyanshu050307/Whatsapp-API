const db = require('../services/db');
const whatsappService = require('../services/whatsapp');
const adminController = require('../controllers/adminController');

async function testAllAdminActionOptions() {
  console.log('=== VERIFYING ALL 5 ADMIN PANEL ACTIONS DROPDOWN OPTIONS ===\n');

  // 1. Initialize Database
  console.log('[Init] Initializing Database...');
  await db.init();
  console.log('PASSED: SQLite DB Ready.\n');

  // Seed test tenant
  const email = 'action_test_' + Date.now() + '@gmail.com';
  const tenant = await db.createGoogleTenant({ email, name: 'Action Test User' });
  const tenantId = tenant.tenant_id;
  console.log(`[Seed] Created test client: ${tenantId} (${email})\n`);

  // Helper mock res object
  function createMockRes() {
    return {
      statusCode: null,
      responseData: null,
      status: function(code) { this.statusCode = code; return this; },
      json: function(data) { this.responseData = data; return this; }
    };
  }

  // -------------------------------------------------------------
  // ACTION 1: Extend Trial Expiry (cyan calendar icon)
  // -------------------------------------------------------------
  console.log('[1/5] Testing Action Option 1: "Extend Trial Expiry"...');
  let req1 = { params: { tenantId }, body: { days: 30 } };
  let res1 = createMockRes();
  await adminController.extendTrial(req1, res1);

  if (res1.statusCode !== 200 || !res1.responseData || res1.responseData.status !== 'success') {
    console.error('FAILED: Extend Trial Expiry option failed:', res1.responseData);
    process.exit(1);
  }

  const updatedTenant1 = await db.getTenantById(tenantId);
  const now = new Date();
  const expDate = new Date(updatedTenant1.trial_expiry_date);
  const daysDiff = Math.round((expDate - now) / (1000 * 60 * 60 * 24));
  if (daysDiff < 40) { // 15 initial + 30 added = ~45 days
    console.error(`FAILED: Expected trial expiry to be extended by 30 days, got ${daysDiff} days`);
    process.exit(1);
  }
  console.log(`PASSED: Trial expiry successfully extended. New Expiry Date: ${updatedTenant1.trial_expiry_date} (${daysDiff} days remaining).\n`);

  // -------------------------------------------------------------
  // ACTION 2: Recharge Credits (yellow coin icon)
  // -------------------------------------------------------------
  console.log('[2/5] Testing Action Option 2: "Recharge Credits"...');
  let req2 = { params: { tenantId }, body: { amount: 500, notes: 'Automated Test Recharge' } };
  let res2 = createMockRes();
  await adminController.rechargeCredits(req2, res2);

  if (res2.statusCode !== 200 || !res2.responseData || res2.responseData.status !== 'success') {
    console.error('FAILED: Recharge Credits option failed:', res2.responseData);
    process.exit(1);
  }

  const creds2 = await db.getCreditBalance(tenantId);
  if (creds2.remaining_credits !== 600) { // 100 starter + 500 added
    console.error(`FAILED: Expected 600 remaining credits, got ${creds2.remaining_credits}`);
    process.exit(1);
  }
  console.log(`PASSED: Credits recharged successfully. Allocated: ${creds2.allocated_credits}, Remaining: ${creds2.remaining_credits}.\n`);

  // -------------------------------------------------------------
  // ACTION 3: Change Account Status (blue shield icon)
  // -------------------------------------------------------------
  console.log('[3/5] Testing Action Option 3: "Change Account Status"...');
  
  // 3a. Suspend Account
  let req3a = { params: { tenantId }, body: { accountStatus: 'suspended' } };
  let res3a = createMockRes();
  await adminController.updateClientStatus(req3a, res3a);
  if (res3a.statusCode !== 200 || res3a.responseData.status !== 'success') {
    console.error('FAILED: Change Account Status to suspended failed:', res3a.responseData);
    process.exit(1);
  }
  let tenant3a = await db.getTenantById(tenantId);
  if (tenant3a.account_status !== 'suspended') {
    console.error(`FAILED: Expected DB status 'suspended', got '${tenant3a.account_status}'`);
    process.exit(1);
  }
  console.log('   - Sub-Test A: Successfully updated account status to "SUSPENDED".');

  // 3b. Activate Account
  let req3b = { params: { tenantId }, body: { accountStatus: 'active' } };
  let res3b = createMockRes();
  await adminController.updateClientStatus(req3b, res3b);
  let tenant3b = await db.getTenantById(tenantId);
  if (tenant3b.account_status !== 'active') {
    console.error(`FAILED: Expected DB status 'active', got '${tenant3b.account_status}'`);
    process.exit(1);
  }
  console.log('   - Sub-Test B: Successfully updated account status to "ACTIVE".');
  console.log('PASSED: Account Status toggle completed and verified in database.\n');

  // -------------------------------------------------------------
  // ACTION 4: Disconnect WhatsApp (yellow power icon)
  // -------------------------------------------------------------
  console.log('[4/5] Testing Action Option 4: "Disconnect WhatsApp"...');
  let req4 = { params: { tenantId } };
  let res4 = createMockRes();
  await adminController.logoutClientSession(req4, res4);

  if (res4.statusCode !== 200 || !res4.responseData || res4.responseData.status !== 'success') {
    console.error('FAILED: Disconnect WhatsApp option failed:', res4.responseData);
    process.exit(1);
  }

  const waState4 = whatsappService.getClientState(tenantId);
  if (waState4 !== 'DISCONNECTED') {
    console.error(`FAILED: Expected WhatsApp state DISCONNECTED, got ${waState4}`);
    process.exit(1);
  }
  console.log(`PASSED: WhatsApp session disconnected successfully. Current WhatsApp Status: ${waState4}.\n`);

  // -------------------------------------------------------------
  // ACTION 5: Delete Client Account (red trash icon)
  // -------------------------------------------------------------
  console.log('[5/5] Testing Action Option 5: "Delete Client Account"...');
  let req5 = { params: { tenantId } };
  let res5 = createMockRes();
  await adminController.deleteClientAccount(req5, res5);

  if (res5.statusCode !== 200 || !res5.responseData || res5.responseData.status !== 'success') {
    console.error('FAILED: Delete Client Account option failed:', res5.responseData);
    process.exit(1);
  }

  const deletedTenant5 = await db.getTenantById(tenantId);
  if (deletedTenant5 !== null) {
    console.error('FAILED: Deleted tenant was still found in database!');
    process.exit(1);
  }
  console.log('PASSED: Delete Client Account transaction completed. Tenant record permanently purged from database.\n');

  console.log('========================================================================');
  console.log(' ALL 5 ADMIN ACTION DROPDOWN OPTIONS TESTED AND VERIFIED SUCCESSFULLY!');
  console.log('========================================================================');
  process.exit(0);
}

testAllAdminActionOptions().catch(err => {
  console.error('FATAL ERROR:', err);
  process.exit(1);
});
