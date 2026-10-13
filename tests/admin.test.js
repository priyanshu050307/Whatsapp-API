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

  describe('7. System Tenant Registration Validation', () => {
    it('should successfully register tenant with valid numeric channelId of at most 8 digits', async () => {
      const initStub = sinon.stub(whatsappService, 'initClient').returns();

      const response = await request(app)
        .post('/api/tenants')
        .set('x-admin-password', 'admin123')
        .send({
          tenantId: 'reg_valid_tenant',
          username: 'valid_user',
          password: 'valid_password',
          channelId: '12345678'
        });

      expect(response.status).to.equal(201);
      expect(response.body).to.have.property('status', 'success');
      initStub.restore();
    });

    it('should reject registration if channelId is non-numeric', async () => {
      const response = await request(app)
        .post('/api/tenants')
        .set('x-admin-password', 'admin123')
        .send({
          tenantId: 'reg_invalid_tenant_1',
          username: 'invalid_user_1',
          password: 'invalid_password_1',
          channelId: 'ch12345'
        });

      expect(response.status).to.equal(400);
      expect(response.body).to.have.property('status', 'failed');
      expect(response.body.reason).to.include('must be a numeric value');
    });

    it('should reject registration if channelId length is greater than 8 digits', async () => {
      const response = await request(app)
        .post('/api/tenants')
        .set('x-admin-password', 'admin123')
        .send({
          tenantId: 'reg_invalid_tenant_2',
          username: 'invalid_user_2',
          password: 'invalid_password_2',
          channelId: '123456789'
        });

      expect(response.status).to.equal(400);
      expect(response.body).to.have.property('status', 'failed');
      expect(response.body.reason).to.include('at most 8 digits');
    });
  });

  describe('8. Contact Directory & Leads Export Validation', () => {
    const dirTenantId = 'dir_test_tenant';

    before(async () => {
      await db.addTenant(dirTenantId, 'dir_user', 'dir_pass', '88776655', {
        email: 'dir_test@example.com',
        name: 'BUSY User Enterprise'
      });
      await db.recordContact(dirTenantId, '919876543210', 'Happy Diwali Greeting Invoice #102');
      await db.recordContact(dirTenantId, '919876543211', 'Payment Reminder Alert');
    });

    it('should return contacts JSON list for a respective client', async () => {
      const response = await request(app)
        .get(`/api/admin/clients/${dirTenantId}/contacts`)
        .set('x-admin-password', 'admin123');

      expect(response.status).to.equal(200);
      expect(response.body).to.have.property('status', 'success');
      expect(response.body.contacts).to.be.an('array');
      expect(response.body.totalContacts).to.equal(2);
      expect(response.body.contacts[0]).to.have.property('mobile');
    });

    it('should export contacts CSV for the respective client with valid headers and data', async () => {
      const response = await request(app)
        .get(`/api/admin/clients/${dirTenantId}/contacts/export`)
        .set('x-admin-password', 'admin123');

      expect(response.status).to.equal(200);
      expect(response.headers['content-type']).to.include('text/csv');
      expect(response.headers['content-disposition']).to.include('attachment');
      expect(response.headers['content-disposition']).to.include('.csv');
      expect(response.text).to.include('Mobile Number');
      expect(response.text).to.include('919876543210');
      expect(response.text).to.include('Happy Diwali Greeting Invoice #102');
      expect(response.text).to.include('dir_test@example.com');
    });

    it('should export all contacts across all clients as CSV', async () => {
      const response = await request(app)
        .get('/api/admin/contacts/export')
        .set('x-admin-password', 'admin123');

      expect(response.status).to.equal(200);
      expect(response.headers['content-type']).to.include('text/csv');
      expect(response.headers['content-disposition']).to.include('attachment');
      expect(response.text).to.include('Mobile Number');
      expect(response.text).to.include('919876543210');
    });
  });
});
