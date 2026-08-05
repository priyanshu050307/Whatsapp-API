process.env.DB_FILENAME = 'test_database_performance.db';
process.env.NODE_ENV = 'test';

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');
const sinon = require('sinon');

const logger = require('../services/logger');
const whatsappService = require('../services/whatsapp');
const db = require('../services/db');

describe('=== Performance & Resource Configuration Testing ===', () => {
  const tenantId = 'perf_tenant';

  before(async () => {
    const testDbPath = path.join(__dirname, '../logs/test_database_performance.db');
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch (e) {}
    }
    await db.init();
    await db.addTenant(tenantId, 'perf_user', 'perf_pass', 'perf_chan');
  });

  after(async () => {
    sinon.restore();
    const testDbPath = path.join(__dirname, '../logs/test_database_performance.db');
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch (e) {}
    }
  });

  describe('1. Winston Daily Log Rotation Configuration Audit', () => {
    it('should confirm daily rotate transports are correctly configured for app and error logs', () => {
      // Find DailyRotateFile transports
      const rotateTransports = logger.transports.filter(t => t.options && t.options.filename);
      expect(rotateTransports).to.have.lengthOf(2);

      rotateTransports.forEach(t => {
        // Assert file size bounds are capped to 20MB
        expect(t.options.maxSize).to.equal('20m');
        // Assert zipped archive option is active to conserve disk space
        expect(t.options.zippedArchive).to.be.true;
      });

      // App log settings check
      const appLogTransport = rotateTransports.find(t => t.options.filename.includes('app-'));
      expect(appLogTransport.options.maxFiles).to.equal('14d'); // 14 days rotation limit

      // Error log settings check
      const errorLogTransport = rotateTransports.find(t => t.options.filename.includes('error-'));
      expect(errorLogTransport.options.maxFiles).to.equal('30d'); // 30 days rotation limit
    });
  });

  describe('2. Connection & Execution Timeouts', () => {
    it('should trigger getChatById timeout fallback when WhatsApp Web takes too long to respond', async () => {
      // Seed the session in the internal sessions map
      const session = whatsappService.getOrCreateSession(tenantId);
      session.clientState = 'READY';
      session.client = {
        getChatById: () => new Promise(resolve => setTimeout(resolve, 15000)) // Takes 15s to resolve (longer than 8s limit)
      };
      session.messageQueue = [];

      const warnLoggerSpy = sinon.spy(require('../services/logger'), 'warn');

      // Trigger message retrieval (which invokes the getChatById race)
      // Since it is stubbed to take 15s, it will timeout at 8s and trigger getChatMessages warning log
      const messages = await whatsappService.getChatMessages(tenantId, '919820685562@c.us', 10);

      // Verify that it timed out and logged the warning message
      expect(warnLoggerSpy.called).to.be.true;
      expect(warnLoggerSpy.firstCall.args[0]).to.include('getChatMessages() primary failed');
      expect(warnLoggerSpy.firstCall.args[0]).to.include('timeout');

      // The fallback should still execute and return empty array/queue messages safely without throwing unhandled rejection
      expect(messages).to.be.an('array');

      // Clean up session in internal sessions map
      session.client = null;
      session.clientState = 'DISCONNECTED';
      warnLoggerSpy.restore();
    });
  });
});
