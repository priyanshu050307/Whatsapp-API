process.env.DB_FILENAME = 'test_database_multitenant.db';
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

describe('=== Multi-Tenant & Concurrency Testing ===', () => {
  // Tenant A config
  const tenantA = 'tenant_a';
  const userA = 'user_a';
  const passA = 'pass_a';
  const chanA = 'chan_a';

  // Tenant B config
  const tenantB = 'tenant_b';
  const userB = 'user_b';
  const passB = 'pass_b';
  const chanB = 'chan_b';

  before(async () => {
    const testDbPath = path.join(__dirname, '../logs/test_database_multitenant.db');
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch (e) {}
    }
    
    await db.init();

    // Create Tenant A & Tenant B with credits
    await db.addTenant(tenantA, userA, passA, chanA, { email: 'a@test.com', name: 'Tenant A', starterCredits: 50 });
    await db.addTenant(tenantB, userB, passB, chanB, { email: 'b@test.com', name: 'Tenant B', starterCredits: 30 });

    sinon.stub(socketService, 'emitToTenant').returns(true);
    
    // Stub states separately
    const stateStub = sinon.stub(whatsappService, 'getClientState');
    stateStub.withArgs(tenantA).returns('READY');
    stateStub.withArgs(tenantB).returns('READY');

    // Stub message sending
    sinon.stub(whatsappService, 'sendWhatsAppMessage').resolves({
      id: { _serialized: 'multi_msg_123' },
      timestamp: Math.floor(Date.now() / 1000)
    });
  });

  after(async () => {
    sinon.restore();
    const testDbPath = path.join(__dirname, '../logs/test_database_multitenant.db');
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch (e) {}
    }
  });

  describe('1. Client Isolation Verification', () => {
    it('should completely isolate Tenant A logs from Tenant B', async () => {
      // Send a message as Tenant A
      const responseA = await request(app)
        .post('/message/new')
        .send({
          username: userA,
          password: passA,
          channelId: chanA,
          receiverMobileNo: '9820685562',
          message: 'Hello Tenant A'
        });
      expect(responseA.status).to.equal(200);

      // Verify Tenant A has 1 log
      const logsA = await db.getLogs(tenantA);
      expect(logsA).to.have.lengthOf(1);
      expect(logsA[0].message).to.equal('Hello Tenant A');

      // Verify Tenant B has 0 logs
      const logsB = await db.getLogs(tenantB);
      expect(logsB).to.have.lengthOf(0);

      // Verify credits are deducted independently
      const balanceA = await db.getCreditBalance(tenantA);
      expect(balanceA.remaining_credits).to.equal(49); // 50 - 1

      const balanceB = await db.getCreditBalance(tenantB);
      expect(balanceB.remaining_credits).to.equal(30); // Unchanged
    });
  });

  describe('2. Concurrent Request Handling', () => {
    it('should process simultaneous messages from different tenants without locks or session leaks', async () => {
      // Send 5 requests concurrently (3 from Tenant A, 2 from Tenant B)
      const requests = [
        request(app).post('/message/new').send({ username: userA, password: passA, channelId: chanA, receiverMobileNo: '9820685562', message: 'A1' }),
        request(app).post('/message/new').send({ username: userB, password: passB, channelId: chanB, receiverMobileNo: '9820685563', message: 'B1' }),
        request(app).post('/message/new').send({ username: userA, password: passA, channelId: chanA, receiverMobileNo: '9820685562', message: 'A2' }),
        request(app).post('/message/new').send({ username: userB, password: passB, channelId: chanB, receiverMobileNo: '9820685563', message: 'B2' }),
        request(app).post('/message/new').send({ username: userA, password: passA, channelId: chanA, receiverMobileNo: '9820685562', message: 'A3' })
      ];

      const results = await Promise.all(requests);
      
      // Verify all completed successfully
      results.forEach(res => {
        expect(res.status).to.equal(200);
        expect(res.body.status).to.equal('success');
      });

      // Verify Tenant A has 4 logs total (1 previous + 3 concurrent)
      const logsA = await db.getLogs(tenantA);
      expect(logsA).to.have.lengthOf(4);

      // Verify Tenant B has 2 logs total (0 previous + 2 concurrent)
      const logsB = await db.getLogs(tenantB);
      expect(logsB).to.have.lengthOf(2);

      // Verify final credit balances
      const balanceA = await db.getCreditBalance(tenantA);
      expect(balanceA.remaining_credits).to.equal(46); // 50 - 4

      const balanceB = await db.getCreditBalance(tenantB);
      expect(balanceB.remaining_credits).to.equal(28); // 30 - 2
    });
  });
});
