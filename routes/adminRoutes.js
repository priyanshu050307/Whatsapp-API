const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const adminAuth = require('../middleware/adminAuth');

// All routes require Admin privileges
router.use(adminAuth);

// Client Management Endpoints
router.get('/clients', adminController.getClients);
router.get('/clients/:tenantId', adminController.getClientDetails);
router.post('/clients/:tenantId/status', adminController.updateClientStatus);
router.post('/clients/:tenantId/trial', adminController.extendTrial);
router.post('/clients/:tenantId/credits', adminController.rechargeCredits);
router.post('/clients/:tenantId/whatsapp/logout', adminController.logoutClientSession);
router.delete('/clients/:tenantId', adminController.deleteClientAccount);

// Contact Directory & Leads Export Endpoints
router.get('/clients/:tenantId/contacts/export', adminController.exportClientContacts);
router.get('/clients/:tenantId/contacts', adminController.getClientContacts);
router.get('/contacts/export', adminController.exportAllContacts);

module.exports = router;
