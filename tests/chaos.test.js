process.env.DB_FILENAME = 'test_database_chaos.db';
process.env.NODE_ENV = 'test';

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { expect } = require('chai');
const sinon = require('sinon');

const { app, server, gracefulShutdown } = require('../app');
const db = require('../services/db');
const logService = require('../services/logService');
const whatsappService = require('../services/whatsapp');
const socketService = require('../services/socketService');

describe('=== Chaos & Resiliency Testing ===', () => {
  const tenantId = 'chaos_tenant';
  const username = 'c_user';
  const password = 'c_password';
  const channelId = 'c_channel';

  before(async () => {
    const testDbPath = path.join(__dirname, '../logs/test_database_chaos.db');
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch (e) {}
    }
    
    await db.init();
    await db.addTenant(tenantId, username, password, channelId, {
      email: 'chaos@test.com',
      accountStatus: 'active'
    });

    sinon.stub(socketService, 'emitToTenant').returns(true);
    sinon.stub(whatsappService, 'getClientState').withArgs(tenantId).returns('READY');
    sinon.stub(whatsappService, 'sendWhatsAppMessage').resolves({
      id: { _serialized: 'chaos_msg_123' }
    });
  });

  after(async () => {
    sinon.restore();
    
    // Cleanup databases and JSONL fallback log files
    const testDbPath = path.join(__dirname, '../logs/test_database_chaos.db');
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch (e) {}
    }

    const fallbackLogPath = path.join(__dirname, `../logs/messages_${tenantId}.jsonl`);
    if (fs.existsSync(fallbackLogPath)) {
      try { fs.unlinkSync(fallbackLogPath); } catch (e) {}
    }
  });

  describe('1. Global Process Uncaught Exceptions handling', () => {
    it('should log uncaught exceptions and prevent process exit', () => {
      const errorMsg = 'Simulated uncaught exception in Puppeteer thread';
      const loggerSpy = sinon.spy(require('../services/logger'), 'error');

      // Find the uncaughtException listener from app.js
      const listeners = process.listeners('uncaughtException');
      const appListener = listeners.find(l => l.toString().includes('UNCAUGHT EXCEPTION'));
      expect(appListener).to.not.be.undefined;

      // Call it manually to avoid propagating to Mocha
      appListener(new Error(errorMsg));

      expect(loggerSpy.called).to.be.true;
      expect(loggerSpy.firstCall.args[0]).to.include('UNCAUGHT EXCEPTION');
      expect(loggerSpy.firstCall.args[1]).to.include(errorMsg);
      
      loggerSpy.restore();
    });

    it('should log unhandled rejections and prevent process exit', () => {
      const rejectionReason = 'Simulated unhandled promise rejection in WWebJS';
      const loggerSpy = sinon.spy(require('../services/logger'), 'error');

      // Find the unhandledRejection listener from app.js
      const listeners = process.listeners('unhandledRejection');
      const appListener = listeners.find(l => l.toString().includes('UNHANDLED REJECTION'));
      expect(appListener).to.not.be.undefined;

      // Call it manually
      appListener(rejectionReason);

      expect(loggerSpy.called).to.be.true;
      expect(loggerSpy.firstCall.args[0]).to.include('UNHANDLED REJECTION');
      expect(loggerSpy.firstCall.args[1]).to.include(rejectionReason);

      loggerSpy.restore();
    });
  });

  describe('2. Database Failure & Fallback Mode', () => {
    it('should fall back to local JSONL logging when database is unavailable', async () => {
      // Clean up existing fallback file if any
      const fallbackLogPath = path.join(__dirname, `../logs/messages_${tenantId}.jsonl`);
      if (fs.existsSync(fallbackLogPath)) {
        fs.unlinkSync(fallbackLogPath);
      }

      // Stub database availability to false (simulates sqlite connection lock/failure)
      const dbAvailStub = sinon.stub(db, 'isAvailable').returns(false);

      const response = await request(app)
        .post('/message/new')
        .send({
          username: username,
          password: password,
          channelId: channelId,
          receiverMobileNo: '9820685562',
          message: 'Fallback Log Entry'
        });

      // API request should still succeed (200 OK)
      expect(response.status).to.equal(200);

      // Verify that local fallback log file was created
      expect(fs.existsSync(fallbackLogPath)).to.be.true;

      // Verify log contents are written as JSON lines
      const content = fs.readFileSync(fallbackLogPath, 'utf8');
      expect(content).to.include('Fallback Log Entry');
      expect(content).to.include(tenantId);

      dbAvailStub.restore();
    });
  });

  describe('3. Graceful Shutdown Signal handling', () => {
    it('should invoke destroyClient for all tenants and close http server on SIGINT', async () => {
      const destroyStub = sinon.stub(whatsappService, 'destroyClient').resolves();
      const processExitStub = sinon.stub(process, 'exit');
      const serverCloseStub = sinon.stub(server, 'close').callsArg(0);

      // Call gracefulShutdown directly
      await gracefulShutdown();

      expect(destroyStub.called).to.be.true;
      expect(serverCloseStub.calledOnce).to.be.true;
      expect(processExitStub.calledOnceWith(0)).to.be.true;
      
      destroyStub.restore();
      processExitStub.restore();
      serverCloseStub.restore();
    });
  });
});
