const { expect } = require('chai');
const sinon = require('sinon');
const jwt = require('jsonwebtoken');
const { sanitizeAndFormatNumber } = require('../services/numberHelper');
const authMiddleware = require('../middleware/auth');
const db = require('../services/db');
const config = require('../config/config');

describe('=== Unit Testing ===', () => {
  
  describe('1. Number Helper & Sanitizer (services/numberHelper.js)', () => {
    it('should strip spaces, dashes, brackets, and plus signs', () => {
      const inputs = [
        '+91 98765-43210',
        '91 (98765) 43210',
        '+91-9876543210',
        ' +91 (987) 654-3210 '
      ];
      inputs.forEach(input => {
        expect(sanitizeAndFormatNumber(input)).to.equal('919876543210@c.us');
      });
    });

    it('should strip leading zero for Indian numbers', () => {
      expect(sanitizeAndFormatNumber('09876543210')).to.equal('919876543210@c.us');
    });

    it('should prefix 10-digit Indian numbers with country code 91', () => {
      expect(sanitizeAndFormatNumber('9876543210')).to.equal('919876543210@c.us');
    });

    it('should validate non-Indian international formats (7 to 15 digits)', () => {
      // Valid international inputs
      expect(sanitizeAndFormatNumber('1234567')).to.equal('1234567@c.us');
      expect(sanitizeAndFormatNumber('123456789012345')).to.equal('123456789012345@c.us');
    });

    it('should return null and warn on invalid inputs', () => {
      expect(sanitizeAndFormatNumber('')).to.be.null;
      expect(sanitizeAndFormatNumber('123')).to.be.null; // too short
      expect(sanitizeAndFormatNumber('1234567890123456')).to.be.null; // too long
      expect(sanitizeAndFormatNumber('abc-def-ghij')).to.be.null; // non-numeric
    });
  });

  describe('2. Database Interface Mocks (services/db.js)', () => {
    let dbInitStub, logMsgStub, getTenantStub;

    beforeEach(() => {
      dbInitStub = sinon.stub(db, 'init').resolves(true);
      logMsgStub = sinon.stub(db, 'logMessage').resolves(123);
      getTenantStub = sinon.stub(db, 'getTenantById').resolves({
        tenant_id: 'test_tenant',
        username: 'test_user',
        account_status: 'trial'
      });
    });

    before(() => {
      // Stub the logger so tests run quietly
      sinon.stub(require('../services/logger'), 'warn');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should call init successfully and resolve true', async () => {
      const res = await db.init();
      expect(res).to.be.true;
      expect(dbInitStub.calledOnce).to.be.true;
    });

    it('should call logMessage successfully and return a log ID', async () => {
      const res = await db.logMessage('test_tenant', '919876543210', 'hello', 'success');
      expect(res).to.equal(123);
      expect(logMsgStub.calledOnce).to.be.true;
      expect(logMsgStub.firstCall.args).to.deep.equal(['test_tenant', '919876543210', 'hello', 'success']);
    });

    it('should call getTenantById and retrieve tenant details', async () => {
      const tenant = await db.getTenantById('test_tenant');
      expect(tenant).to.have.property('tenant_id', 'test_tenant');
      expect(getTenantStub.calledOnce).to.be.true;
    });
  });

  describe('3. Authentication Middleware (middleware/auth.js)', () => {
    let req, res, next, getTenantByIdStub, getTenantByCredsStub;
    const testSecret = 'test_secret_key';

    beforeEach(() => {
      sinon.stub(config, 'get').returns({ JWT_SECRET: testSecret });
      getTenantByIdStub = sinon.stub(db, 'getTenantById');
      getTenantByCredsStub = sinon.stub(db, 'getTenantByCredentials');

      req = {
        headers: {},
        query: {},
        body: {},
        path: '/message/new'
      };
      
      res = {
        statusCode: 200,
        responseData: null,
        status(code) {
          this.statusCode = code;
          return this;
        },
        json(data) {
          this.responseData = data;
          return this;
        }
      };

      next = sinon.spy();
    });

    afterEach(() => {
      sinon.restore();
    });

    it('should parse legacy API credentials case-insensitively from query parameters', async () => {
      req.query = {
        USERNAME: 'test_user',
        PassWord: 'test_password',
        ChannelID: 'test_channel'
      };

      getTenantByCredsStub.resolves({
        tenant_id: 'tenant_123',
        account_status: 'active'
      });

      await authMiddleware(req, res, next);

      expect(getTenantByCredsStub.calledOnce).to.be.true;
      expect(getTenantByCredsStub.firstCall.args).to.deep.equal(['test_user', 'test_password', 'test_channel']);
      expect(req.tenant).to.have.property('tenant_id', 'tenant_123');
      expect(next.calledOnce).to.be.true;
    });

    it('should parse legacy API credentials from request headers', async () => {
      req.headers = {
        username: 'header_user',
        password: 'header_password',
        channelid: 'header_channel'
      };

      getTenantByCredsStub.resolves({
        tenant_id: 'tenant_header',
        account_status: 'active'
      });

      await authMiddleware(req, res, next);

      expect(getTenantByCredsStub.calledOnce).to.be.true;
      expect(getTenantByCredsStub.firstCall.args).to.deep.equal(['header_user', 'header_password', 'header_channel']);
      expect(req.tenant).to.have.property('tenant_id', 'tenant_header');
      expect(next.calledOnce).to.be.true;
    });

    it('should authenticate valid JWT Bearer tokens successfully', async () => {
      const token = jwt.sign({ tenantId: 'tenant_jwt' }, testSecret, { expiresIn: '1h' });
      req.headers['authorization'] = `Bearer ${token}`;

      getTenantByIdStub.resolves({
        tenant_id: 'tenant_jwt',
        account_status: 'active'
      });

      await authMiddleware(req, res, next);

      expect(getTenantByIdStub.calledOnceWith('tenant_jwt')).to.be.true;
      expect(req.tenant).to.have.property('tenant_id', 'tenant_jwt');
      expect(next.calledOnce).to.be.true;
    });

    it('should return 401 Unauthorized for expired or malformed JWT tokens', async () => {
      // Expired token
      const expiredToken = jwt.sign({ tenantId: 'tenant_jwt' }, testSecret, { expiresIn: '-1s' });
      req.headers['authorization'] = `Bearer ${expiredToken}`;

      await authMiddleware(req, res, next);

      expect(res.statusCode).to.equal(401);
      expect(res.responseData.reason).to.include('Invalid or expired session token');
      expect(next.called).to.be.false;
    });

    it('should return 403 Forbidden for suspended accounts', async () => {
      req.query = { username: 'user', password: 'pwd', channelid: 'cid' };
      getTenantByCredsStub.resolves({
        tenant_id: 'suspended_tenant',
        account_status: 'suspended'
      });

      await authMiddleware(req, res, next);

      expect(res.statusCode).to.equal(403);
      expect(res.responseData.reason).to.include('Account Suspended');
      expect(next.called).to.be.false;
    });

    it('should return 402 Payment Required for expired trial accounts on message routes', async () => {
      req.query = { username: 'user', password: 'pwd', channelid: 'cid' };
      req.path = '/message/new';
      getTenantByCredsStub.resolves({
        tenant_id: 'expired_tenant',
        account_status: 'expired',
        plan_status: 'free_trial'
      });

      await authMiddleware(req, res, next);

      expect(res.statusCode).to.equal(402);
      expect(res.responseData.reason).to.include('Trial Expired');
      expect(next.called).to.be.false;
    });
  });

  describe('4. Automated Update & Self-Healing Engine (services/whatsapp.js & scripts/update-whatsapp.js)', () => {
    const whatsappService = require('../services/whatsapp');
    const updater = require('../scripts/update-whatsapp');

    it('should validate legitimate SemVer strings and block shell injection payloads (CWE-78)', () => {
      expect(updater.isValidSemver('1.34.7')).to.be.true;
      expect(updater.isValidSemver('1.35.0-alpha.1')).to.be.true;
      expect(updater.isValidSemver('1.34.7; rm -rf /')).to.be.false;
      expect(updater.isValidSemver('1.34.7 && whoami')).to.be.false;
      expect(updater.isValidSemver('$(malicious)')).to.be.false;
      expect(updater.isValidSemver('')).to.be.false;
    });

    it('should detect installed whatsapp-web.js version and verify runtime media patch', () => {
      const installed = updater.getInstalledVersion();
      expect(installed).to.be.a('string');
      expect(updater.isValidSemver(installed)).to.be.true;
      expect(updater.applyMediaPatch()).to.be.true;
    });

    it('should monitor .wwebjs_cache and expose libraryVersionStatus', () => {
      const cacheSummary = whatsappService.pruneAndMonitorWWebCache(3);
      expect(cacheSummary).to.have.property('totalFound').that.is.a('number');
      expect(cacheSummary.kept).to.be.an('array');
      expect(cacheSummary.kept.length).to.be.at.most(3);

      const status = whatsappService.getLibraryVersionStatus();
      expect(status).to.have.property('updateAvailable').that.is.a('boolean');
      expect(status).to.have.property('cachedWWebVersions').that.is.an('array');
    });
  });
});
