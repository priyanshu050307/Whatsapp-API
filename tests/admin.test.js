process.env.DB_FILENAME = 'test_database_admin.db';
process.env.NODE_ENV = 'test';

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { expect } = require('chai');
const sinon = require('sinon');

const { app } = require('../app');
const db = require('../services/db');
const whatsappService = require('../services/whatsapp');
const socketService = require('../services/socketService');

describe('=== Admin Actions Endpoint Testing ===', () => {
  const tenantId = 'admin_test_tenant';
  const username = 'admin_t_user';
  const password = 'admin_t_password';
  const channelId = 'admin_t_channel';
  const adminPassword = 'admin123'; // Default master admin password

  before(async () => {
    const testDbPath = path.join(__dirname, '../logs/test_database_admin.db');
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch (e) {}
    }
    
    await db.init();
    await db.addTenant(tenantId, username, password, channelId, {
      email: 'admin_test@example.com',
      name: 'Admin Test Client',
      accountStatus: 'trial',
      starterCredits: 100
    });

    sinon.stub(socketService, 'emitToTenant').returns(true);
  });

  after(async () => {
    sinon.restore();
    const testDbPath = path.join(__dirname, '../logs/test_database_admin.db');
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch (e) {}
    }
  });

  describe('1. Clients Listing & Details', () => {
    it('should list all clients when authenticated as admin', async () => {
      const response = await request(app)
        .get('/api/admin/clients')
        .set('x-admin-password', adminPassword);

      expect(response.status).to.equal(200);
      expect(response.body).to.have.property('status', 'success');
      expect(response.body.clients).to.be.an('array');
      expect(response.body.clients.length).to.be.at.least(1);
    });

    it('should get detailed client profile', async () => {
      const response = await request(app)
        .get(`/api/admin/clients/${tenantId}`)
        .set('x-admin-password', adminPassword);

      expect(response.status).to.equal(200);
      expect(response.body).to.have.property('status', 'success');
      expect(response.body.client).to.have.property('tenant_id', tenantId);
    });
  });

  describe('2. Change Account Status', () => {
    it('should change account status to suspended', async () => {
      const response = await request(app)
        .post(`/api/admin/clients/${tenantId}/status`)
        .set('x-admin-password', adminPassword)
        .send({ accountStatus: 'suspended' });

      expect(response.status).to.equal(200);
      expect(response.body).to.have.property('status', 'success');
      expect(response.body.message).to.include('suspended');

      // Verify db update
      const client = await db.getTenantById(tenantId);
      expect(client.account_status).to.equal('suspended');
    });

    it('should return 400 for invalid status', async () => {
      const response = await request(app)
        .post(`/api/admin/clients/${tenantId}/status`)
        .set('x-admin-password', adminPassword)
        .send({ accountStatus: 'invalid_status_value' });

      expect(response.status).to.equal(400);
    });
  });

  describe('3. Extend Trial Expiry', () => {
    it('should extend trial expiry date by number of days', async () => {
      const response = await request(app)
        .post(`/api/admin/clients/${tenantId}/trial`)
        .set('x-admin-password', adminPassword)
        .send({ days: 10 });

      expect(response.status).to.equal(200);
      expect(response.body).to.have.property('status', 'success');
      expect(response.body).to.have.property('newExpiryDate');
    });
  });

  describe('4. Recharge Credits', () => {
    it('should recharge credits for a client', async () => {
      const response = await request(app)
        .post(`/api/admin/clients/${tenantId}/credits`)
        .set('x-admin-password', adminPassword)
        .send({ amount: 50, notes: 'Test recharge' });

      expect(response.status).to.equal(200);
      expect(response.body).to.have.property('status', 'success');

      // Verify database credits recharged
      const balance = await db.getCreditBalance(tenantId);
      expect(balance.remaining_credits).to.equal(150); // 100 starter + 50 recharge
    });
  });

  describe('5. Disconnect WhatsApp Session', () => {
    it('should trigger logout/disconnect client session', async () => {
      const logoutStub = sinon.stub(whatsappService, 'logoutSession').resolves();

      const response = await request(app)
        .post(`/api/admin/clients/${tenantId}/whatsapp/logout`)
        .set('x-admin-password', adminPassword);

      expect(response.status).to.equal(200);
      expect(response.body).to.have.property('status', 'success');
      
      expect(logoutStub.calledOnceWith(tenantId)).to.be.true;
      logoutStub.restore();
    });
  });

  describe('6. Delete Client Account', () => {
    it('should permanently delete client account', async () => {
      const deleteStub = sinon.stub(whatsappService, 'deleteSessionData').resolves();

      const response = await request(app)
        .delete(`/api/admin/clients/${tenantId}`)
        .set('x-admin-password', adminPassword);

      expect(response.status).to.equal(200);
      expect(response.body).to.have.property('status', 'success');
      expect(response.body.message).to.include('permanently deleted');

      // Verify database record deleted
      const client = await db.getTenantById(tenantId);
      expect(client).to.be.null;

      expect(deleteStub.calledOnceWith(tenantId)).to.be.true;
      deleteStub.restore();
    });
  });
});
