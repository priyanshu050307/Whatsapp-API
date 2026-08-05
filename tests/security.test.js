process.env.DB_FILENAME = 'test_database_security.db';
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

describe('=== Security Testing ===', () => {
  const tenantId = 'security_tenant';
  const username = 's_user';
  const password = 's_password';
  const channelId = 's_channel';

  before(async () => {
    const testDbPath = path.join(__dirname, '../logs/test_database_security.db');
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch (e) {}
    }
    
    await db.init();
    await db.addTenant(tenantId, username, password, channelId, {
      email: 'security@test.com',
      accountStatus: 'active'
    });

    sinon.stub(socketService, 'emitToTenant').returns(true);
    sinon.stub(whatsappService, 'getClientState').withArgs(tenantId).returns('READY');
    sinon.stub(whatsappService, 'sendWhatsAppMessage').resolves({
      id: { _serialized: 'sec_msg_123' }
    });
  });

  after(async () => {
    sinon.restore();
    const testDbPath = path.join(__dirname, '../logs/test_database_security.db');
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch (e) {}
    }
  });

  describe('1. Authentication & Authorization Integrity', () => {
    it('should block message requests without any credentials with 401 Unauthorized', async () => {
      const response = await request(app)
        .post('/message/new')
        .send({
          receiverMobileNo: '9820685562',
          message: 'Hello No Auth'
        });

      expect(response.status).to.equal(401);
      expect(response.body).to.have.property('status', 'failed');
      expect(response.body.reason).to.include('Credentials required');
    });

    it('should block message requests with incorrect legacy credentials with 401 Unauthorized', async () => {
      const response = await request(app)
        .post('/message/new')
        .send({
          username: username,
          password: 'wrong_password',
          channelId: channelId,
          receiverMobileNo: '9820685562',
          message: 'Hello Wrong Auth'
        });

      expect(response.status).to.equal(401);
      expect(response.body).to.have.property('status', 'failed');
    });

    it('should block access to admin APIs without JWT tokens', async () => {
      const response = await request(app)
        .get('/api/admin/clients');

      expect(response.status).to.equal(403);
    });
  });

  describe('2. Security Headers & CORS Verification', () => {
    it('should include Helmet security headers in HTTP responses', async () => {
      const response = await request(app).get('/');

      // Check standard Helmet security headers
      expect(response.headers).to.have.property('x-content-type-options', 'nosniff');
      expect(response.headers).to.have.property('x-frame-options', 'SAMEORIGIN');
      expect(response.headers).to.have.property('content-security-policy');
    });

    it('should allow cross-origin requests from any origin via CORS headers', async () => {
      const response = await request(app)
        .options('/message/new')
        .set('Origin', 'http://external-busy-instance.com')
        .set('Access-Control-Request-Method', 'POST');

      expect(response.headers).to.have.property('access-control-allow-origin', '*');
      expect(response.headers).to.have.property('access-control-allow-methods');
    });
  });

  describe('3. Input Injection Safety (SQLi & XSS)', () => {
    it('should prevent SQL Injection bypass in username/password parameters', async () => {
      // Attempt SQL Injection payload in username
      const response = await request(app)
        .post('/message/new')
        .send({
          username: "' OR '1'='1' --",
          password: password,
          channelId: channelId,
          receiverMobileNo: '9820685562',
          message: 'SQL Injection Test'
        });

      expect(response.status).to.equal(401);
      expect(response.body.status).to.equal('failed');
    });

    it('should safely log messages containing XSS payloads without execution risk', async () => {
      const xssPayload = "<script>alert('XSS Attack')</script>";
      
      const response = await request(app)
        .post('/message/new')
        .send({
          username: username,
          password: password,
          channelId: channelId,
          receiverMobileNo: '9820685562',
          message: xssPayload
        });

      expect(response.status).to.equal(200);

      // Verify that log entry was successfully written in the SQLite database as text
      const logs = await db.getLogs(tenantId, 1);
      expect(logs).to.have.lengthOf(1);
      expect(logs[0].message).to.equal(xssPayload);
    });
  });
});
