const db = require('../services/db');
const whatsappService = require('../services/whatsapp');

async function cleanupTestTenants() {
  await db.init();
  const testTenantIds = [
    'tenant_flow_test_17855_1a8855',
    'tenant_tenantb_1785563_2d4e39',
    'tenant_tenantc_1785563_8cab92',
    'tenant_tenanta_1785563_81554e',
    'test_ps_tenant',
    'tenant2',
    'default'
  ];

  console.log('=== CLEANING UP UNNECESSARY TEST ACCOUNTS ===\n');

  for (const tid of testTenantIds) {
    console.log(`Deleting session and data for tenant: ${tid}...`);
    await whatsappService.deleteSessionData(tid);
    await db.deleteTenant(tid);
    console.log(`-> Successfully removed ${tid}\n`);
  }

  const remaining = await db.getAllClientsWithDetails();
  console.log('=== REMAINING ACTIVE CLIENT ACCOUNTS ===');
  remaining.forEach(c => {
    console.log(`- Tenant ID: ${c.tenant_id} | Email: ${c.email || 'N/A'} | Name: ${c.name || 'N/A'}`);
  });

  process.exit(0);
}

cleanupTestTenants().catch(err => {
  console.error('Cleanup Error:', err);
  process.exit(1);
});
