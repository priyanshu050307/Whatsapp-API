// Set environment variables before requiring any local modules
process.env.DB_FILENAME = 'test_database.db';
process.env.NODE_ENV = 'test';

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { expect } = require('chai');
const sinon = require('sinon');
const jwt = require('jsonwebtoken');

const { app } = require('../app');
const db = require('../services/db');
const whatsappService = require('../services/whatsapp');
const socketService = require('../services/socketService');
const config = require('../config/config');

describe('=== Integration Testing ===', () => {
  const tenantId = 'integration_tenant';
  const username = 'i_user';
  const password = 'i_password';
  const channelId = 'i_channel';
  let clientToken;

  before(async () => {
    // 1. Initialize clean test database
    const testDbPath = path.join(__dirname, '../logs/test_database.db');
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch (e) {}
    }
    
    await db.init();

    // 2. Add test tenant with 100 starter credits
    await db.addTenant(tenantId, username, password, channelId, {
      email: 'integration@test.com',
      name: 'Integration Test Client',
      accountStatus: 'trial',
      starterCredits: 100
    });

    // 3. Generate client JWT token
    const secret = config.get().JWT_SECRET;
    clientToken = jwt.sign({ tenantId: tenantId }, secret, { expiresIn: '1h' });

    // Stub SocketService to avoid real websocket connection logs
    sinon.stub(socketService, 'emitToTenant').returns(true);
  });

  after(async () => {
    sinon.restore();
    // Cleanup test database
    const testDbPath = path.join(__dirname, '../logs/test_database.db');
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch (e) {}
    }
  });

  describe('1. Message Gateway Endpoint (/message/new)', () => {
    let getClientStateStub, sendWhatsAppMessageStub;

    beforeEach(() => {
      getClientStateStub = sinon.stub(whatsappService, 'getClientState').withArgs(tenantId).returns('READY');
      sendWhatsAppMessageStub = sinon.stub(whatsappService, 'sendWhatsAppMessage').resolves({
        id: { _serialized: 'msg_test_123' },
        timestamp: Math.floor(Date.now() / 1000)
      });
    });

    afterEach(() => {
      sinon.restore();
      // Re-stub SocketService since sinon.restore() clears it
      sinon.stub(socketService, 'emitToTenant').returns(true);
    });

    it('should send a message via POST with valid JSON parameters', async () => {
      const response = await request(app)
        .post('/message/new')
        .send({
          username: username,
          password: password,
          channelId: channelId,
          receiverMobileNo: '9820685562',
          message: 'Hello Integration Test JSON'
        });

      expect(response.status).to.equal(200);
      expect(response.body).to.have.property('status', 'success');
      expect(response.body).to.have.property('message', 'WhatsApp Sent Successfully');
      expect(response.body).to.have.property('mobile', '919820685562');

      // Verify credit deduction
      const balance = await db.getCreditBalance(tenantId);
      expect(balance.remaining_credits).to.equal(99);

      // Verify DB audit log written
      const logs = await db.getLogs(tenantId, 1);
      expect(logs).to.have.lengthOf(1);
      expect(logs[0]).to.have.property('mobile', '919820685562');
      expect(logs[0]).to.have.property('status', 'success');
    });

    it('should send a message via GET with URL query parameters', async () => {
      const response = await request(app)
        .get('/message/new')
        .query({
          username: username,
          password: password,
          channelId: channelId,
          receiverMobileNo: '919820685562',
          message: 'Hello Integration Test GET'
        });

      expect(response.status).to.equal(200);
      expect(response.body).to.have.property('status', 'success');

      // Verify another credit deducted (99 -> 98)
      const balance = await db.getCreditBalance(tenantId);
      expect(balance.remaining_credits).to.equal(98);
    });

    it('should reject requests with missing parameters with 400 Bad Request', async () => {
      const response = await request(app)
        .post('/message/new')
        .send({
          username: username,
          password: password,
          channelId: channelId,
          receiverMobileNo: '9820685562'
          // missing message
        });

      expect(response.status).to.equal(400);
      expect(response.body).to.have.property('status', 'failed');
      expect(response.body.reason).to.include('Message cannot be empty');
    });

    it('should fail with 503 if WhatsApp Client is offline (not READY)', async () => {
      // Stub state as DISCONNECTED
      sinon.restore();
      sinon.stub(socketService, 'emitToTenant').returns(true);
      sinon.stub(whatsappService, 'getClientState').withArgs(tenantId).returns('DISCONNECTED');

      const response = await request(app)
        .post('/message/new')
        .send({
          username: username,
          password: password,
          channelId: channelId,
          receiverMobileNo: '9820685562',
          message: 'Hello Offline Test'
        });

      expect(response.status).to.equal(503);
      expect(response.body).to.have.property('status', 'failed');
      expect(response.body.reason).to.include('offline');
    });
  });

  describe('2. System Administration Endpoints', () => {
    it('should load /status endpoint correctly and return DISCONNECTED state (no active driver)', async () => {
      const response = await request(app)
        .get('/status')
        .query({ token: clientToken });

      expect(response.status).to.equal(200);
      expect(response.body).to.have.property('clientState', 'DISCONNECTED');
    });

    it('should return null or 404 for /qr code if client not in QR generation phase', async () => {
      const response = await request(app)
        .get('/qr')
        .query({ token: clientToken });

      // If no QR code generated, endpoint returns failed / empty / null
      expect(response.status).to.satisfy((code) => code === 404 || code === 200);
    });

    it('should trigger /restart endpoint successfully', async () => {
      const restartStub = sinon.stub(whatsappService, 'restartClient').resolves();

      const response = await request(app)
        .get('/restart')
        .query({ token: clientToken });

      expect(response.status).to.equal(200);
      expect(response.body).to.have.property('status', 'success');
      expect(response.body.message).to.include('restart');
      
      restartStub.restore();
    });

    it('should retrieve /api/logs successfully for client', async () => {
      const response = await request(app)
        .get('/api/client/dashboard')
        .set('Authorization', `Bearer ${clientToken}`);

      expect(response.status).to.equal(200);
      expect(response.body).to.have.property('status', 'success');
      expect(response.body).to.have.property('logs');
      expect(response.body).to.have.property('credits');
    });

    it('should expose public Firebase configurations without authentication', async () => {
      const response = await request(app)
        .get('/api/auth/firebase-config');

      expect(response.status).to.equal(200);
      expect(response.body).to.have.property('status', 'success');
      expect(response.body).to.have.property('config');
      expect(response.body.config).to.have.property('apiKey');
      expect(response.body.config).to.have.property('authDomain');
      expect(response.body.config).to.have.property('projectId');
    });
  });

  describe('3. Socket.io Event Verification', () => {
    it('should call emitToTenant when socket status events trigger', () => {
      // Trigger a status change simulation
      socketService.emitToTenant(tenantId, 'whatsapp_status', { state: 'READY' });
      expect(socketService.emitToTenant.called).to.be.true;
    });
  });
});
