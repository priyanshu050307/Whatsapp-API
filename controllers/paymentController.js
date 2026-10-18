const razorpayService = require('../services/razorpayService');
const db = require('../services/db');
const logger = require('../services/logger');

/**
 * GET /api/payment/plans
 * Returns all active plans and their details
 */
exports.getPlans = (req, res) => {
  return res.status(200).json({
    status: 'success',
    plans: razorpayService.PLANS
  });
};

/**
 * POST /api/payment/create-order
 * Creates Razorpay order for authenticated tenant
 */
exports.createOrder = async (req, res) => {
  try {
    const tenantId = req.tenant.tenant_id;
    const { planId } = req.body;

    if (!planId) {
      return res.status(400).json({
        status: 'failed',
        reason: 'planId is required'
      });
    }

    const orderData = await razorpayService.createOrder(planId, tenantId);

    // Save pending payment record in database
    await db.recordPaymentOrder(
      tenantId,
      orderData.orderId,
      orderData.amount,
      orderData.planId,
      orderData.planName,
      orderData.messages
    );

    return res.status(200).json({
      status: 'success',
      order: orderData,
      client: {
        name: req.tenant.name || req.tenant.username,
        email: req.tenant.email || '',
        mobile: ''
      }
    });
  } catch (err) {
    logger.error('Order creation error: %s', err.message);
    return res.status(500).json({
      status: 'failed',
      reason: err.message || 'Internal server error creating payment order'
    });
  }
};

/**
 * POST /api/payment/verify-payment
 * Verifies Razorpay HMAC signature and upgrades tenant plan
 */
exports.verifyPayment = async (req, res) => {
  try {
    const { orderId, paymentId, signature } = req.body;

    if (!orderId || !paymentId || !signature) {
      return res.status(400).json({
        status: 'failed',
        reason: 'orderId, paymentId, and signature are required for payment verification'
      });
    }

    // 1. Verify HMAC SHA256 Signature
    const isValid = razorpayService.verifyPaymentSignature(orderId, paymentId, signature);
    if (!isValid) {
      logger.warn(`[Payment Fraud Attempt] Invalid signature received for order ${orderId}, payment ${paymentId}`);
      return res.status(400).json({
        status: 'failed',
        reason: 'Payment verification failed: Invalid transaction signature'
      });
    }

    // 2. Fulfill order, unfreeze tenant, extend validity, allocate credits
    const fulfillment = await db.fulfillPaymentOrder(orderId, paymentId, signature);

    logger.info(`[Payment Success] Order ${orderId} verified. Tenant ${fulfillment.tenantId} activated on plan ${fulfillment.planName}`);

    return res.status(200).json({
      status: 'success',
      message: `Payment successful! Your account is active with ${fulfillment.messagesAllocated} messages valid for 1 year.`,
      fulfillment
    });
  } catch (err) {
    logger.error('Payment verification error: %s', err.message);
    return res.status(500).json({
      status: 'failed',
      reason: err.message || 'Internal server error verifying payment'
    });
  }
};

/**
 * GET /api/payment/history
 * Returns payment transactions for the authenticated tenant
 */
exports.getHistory = async (req, res) => {
  try {
    const tenantId = req.tenant.tenant_id;
    const history = await db.getPaymentsByTenant(tenantId);
    return res.status(200).json({
      status: 'success',
      payments: history
    });
  } catch (err) {
    logger.error('Payment history error: %s', err.message);
    return res.status(500).json({
      status: 'failed',
      reason: 'Failed to retrieve payment history'
    });
  }
};
