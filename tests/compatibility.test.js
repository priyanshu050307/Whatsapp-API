process.env.DB_FILENAME = 'test_database_compatibility.db';
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

describe('=== Compatibility Testing (Busy Accounting Software) ===', () => {
  const tenantId = 'compat_tenant';
  const username = 'compat_user';
  const password = 'compat_password';
  const channelId = 'compat_channel';

  before(async () => {
    const testDbPath = path.join(__dirname, '../logs/test_database_compatibility.db');
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch (e) {}
    }
    
    await db.init();
    await db.addTenant(tenantId, username, password, channelId, {
      email: 'compat@test.com',
      accountStatus: 'active'
    });
  });

  after(async () => {
    const testDbPath = path.join(__dirname, '../logs/test_database_compatibility.db');
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch (e) {}
    }
  });

  beforeEach(() => {
    sinon.stub(socketService, 'emitToTenant').returns(true);
    sinon.stub(whatsappService, 'getClientState').returns('READY');
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('1. Busy Accounting HTTP Parameter Compatibility', () => {
    it('should successfully handle Busy\'s exact URL GET parameter format', async () => {
      const sendWhatsAppMessageStub = sinon.stub(whatsappService, 'sendWhatsAppMessage').resolves({
        id: { _serialized: 'compat_msg_123' },
        timestamp: Math.floor(Date.now() / 1000)
      });

      // Emulate Busy format (newlines, spaces, and currency symbols URL encoded)
      // Message: "Invoice No: 123\nDate: 2026-08-02\nAmount: Rs. 15,000\nThank you!"
      const busyMessage = 'Invoice No: 123\nDate: 2026-08-02\nAmount: Rs. 15,000\nThank you!';
      const encodedMessage = encodeURIComponent(busyMessage);

      const response = await request(app)
        .get(`/message/new?username=${username}&password=${password}&channelid=${channelId}&receiverMobileNo=9820685562&message=${encodedMessage}`);

      expect(response.status).to.equal(200);
      expect(response.body).to.have.property('status', 'success');
      expect(response.body).to.have.property('message', 'WhatsApp Sent Successfully');
      expect(response.body).to.have.property('mobile', '919820685562');

      // Assert that the message received by sendWhatsAppMessage was decoded correctly
      expect(sendWhatsAppMessageStub.calledOnce).to.be.true;
      expect(sendWhatsAppMessageStub.firstCall.args[2]).to.equal(busyMessage);
    });

    it('should successfully parse legacy channel ID parameters regardless of casing', async () => {
      const sendWhatsAppMessageStub = sinon.stub(whatsappService, 'sendWhatsAppMessage').resolves({
        id: { _serialized: 'compat_msg_456' }
      });

      // Query parameter uses "channelid" in all lowercase
      const response = await request(app)
        .get('/message/new')
        .query({
          username: username,
          password: password,
          channelid: channelId,
          receiverMobileNo: '9820685562',
          message: 'Casing compatibility check'
        });

      expect(response.status).to.equal(200);
      expect(response.body).to.have.property('status', 'success');
    });
  });
});
