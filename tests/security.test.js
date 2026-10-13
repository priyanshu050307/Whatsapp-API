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

  describe('4. Authentication Bypass & Path Traversal Regression Tests', () => {
    it('should block Google login attempts that omit idToken and pass raw email payload', async () => {
      const response = await request(app)
        .post('/api/auth/google')
        .send({
          email: 'security@test.com',
          name: 'AttackerSpoof',
          googleId: 'spoof_123'
        });

      expect(response.status).to.equal(400);
      expect(response.body).to.have.property('status', 'failed');
    });

    it('should block Google login attempts with forged/unsigned base64 JWT payloads', async () => {
      const fakeHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64');
      const fakePayload = Buffer.from(JSON.stringify({ email: 'security@test.com', sub: '12345' })).toString('base64');
      const forgedToken = `${fakeHeader}.${fakePayload}.forged_signature`;

      const response = await request(app)
        .post('/api/auth/google')
        .send({ idToken: forgedToken });

      expect(response.status).to.equal(401);
      expect(response.body).to.have.property('status', 'failed');
    });

    it('should block Path Traversal payloads in tenantId during registration', async () => {
      const response = await request(app)
        .post('/api/tenants')
        .set('x-admin-password', 'admin123')
        .send({
          tenantId: '../../etc/malicious_dir',
          username: 'pt_user',
          password: 'pt_password',
          channelId: '12345678'
        });

      expect(response.status).to.equal(400);
      expect(response.body.status).to.equal('failed');
      expect(response.body.reason).to.include('alphanumeric');
    });

    it('should neutralize CSV Formula Injection payloads in admin contact exports', async () => {
      const formulaPayload = "=HYPERLINK(\"http://evil.example/steal\", \"Click\")";
      await db.recordContact(tenantId, '919999988888', formulaPayload);

      const response = await request(app)
        .get(`/api/admin/clients/${tenantId}/contacts/export`)
        .set('x-admin-password', 'admin123');

      expect(response.status).to.equal(200);
      // Formula beginning with '=' must be prefixed with single quote "'" inside the CSV cell
      expect(response.text).to.include(`"'=HYPERLINK`);
    });

    it('should not leak Node.js version or OS platform in /status responses', async () => {
      const response = await request(app)
        .get('/status')
        .query({ username, password, channelid: channelId });

      expect(response.status).to.equal(200);
      expect(response.body).to.not.have.property('nodeVersion');
      expect(response.body).to.not.have.property('platformOS');
      expect(response.headers).to.not.have.property('x-powered-by');
    });
  });
});
