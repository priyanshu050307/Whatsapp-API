const crypto = require('crypto');
const config = require('../config/config');
const logger = require('./logger');

/**
 * Plans Configuration mapping to the 6 WaToolcab tiers
 */
const PLANS = {
  test1: {
    id: 'test1',
    name: '1 Rupee Test Plan',
    amount: 1, // INR 1
    messages: 1,
    validityDays: 365
  },
  micro: {
    id: 'micro',
    name: 'Micro / Trial',
    amount: 499, // INR
    messages: 1000,
    validityDays: 365
  },
  starter: {
    id: 'starter',
    name: 'Starter',
    amount: 999, // INR
    messages: 2500,
    validityDays: 365
  },
  growth: {
    id: 'growth',
    name: 'Growth',
    amount: 1499, // INR
    messages: 4500,
    validityDays: 365
  },
  business: {
    id: 'business',
    name: 'Business',
    amount: 1999, // INR
    messages: 6500,
    validityDays: 365
  },
  pro: {
    id: 'pro',
    name: 'Pro Trader',
    amount: 2499, // INR
    messages: 8500,
    validityDays: 365
  },
  enterprise: {
    id: 'enterprise',
    name: 'Enterprise Max',
    amount: 2999, // INR
    messages: 10000,
    validityDays: 365
  }
};

/**
 * Creates an order directly using Razorpay HTTP API
 * Amount is passed in smallest currency unit (paise: INR * 100)
 */
async function createOrder(planId, tenantId, receiptId = null) {
  const plan = PLANS[planId];
  if (!plan) {
    throw new Error(`Invalid plan selected: "${planId}". Available plans: ${Object.keys(PLANS).join(', ')}`);
  }

  const activeConfig = config.get();
  const keyId = activeConfig.RAZORPAY_KEY_ID;
  const keySecret = activeConfig.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) {
    throw new Error('Razorpay API keys (RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET) are not configured.');
  }

  const receipt = receiptId || `rcpt_${tenantId}_${Date.now()}`.substring(0, 40);
  const amountInPaise = plan.amount * 100;

  const authHeader = 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64');
  const payload = {
    amount: amountInPaise,
    currency: 'INR',
    receipt: receipt,
    notes: {
      tenant_id: tenantId,
      plan_id: plan.id,
      plan_name: plan.name,
      messages: plan.messages
    }
  };

  const response = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: {
      'Authorization': authHeader,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json();

  if (!response.ok || !data.id) {
    logger.error('Razorpay Order Creation Failed: %o', data);
    throw new Error(data.error ? data.error.description : 'Failed to create order on Razorpay');
  }

  logger.info(`[Razorpay] Created order ${data.id} for tenant ${tenantId} (${plan.name} - ₹${plan.amount})`);

  return {
    orderId: data.id,
    amount: plan.amount,
    currency: 'INR',
    planId: plan.id,
    planName: plan.name,
    messages: plan.messages,
    keyId: keyId
  };
}

/**
 * Validates Razorpay Payment Signature using HMAC SHA256 (CWE-347 compliant)
 */
function verifyPaymentSignature(orderId, paymentId, signature) {
  const activeConfig = config.get();
  const keySecret = activeConfig.RAZORPAY_KEY_SECRET;

  if (!keySecret) {
    throw new Error('RAZORPAY_KEY_SECRET is not configured');
  }

  const generatedSignature = crypto
    .createHmac('sha256', keySecret)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');

  // Constant-time comparison to prevent timing attacks (CWE-208)
  const isMatch = crypto.timingSafeEqual(
    Buffer.from(generatedSignature, 'utf8'),
    Buffer.from(signature, 'utf8')
  );

  return isMatch;
}

module.exports = {
  PLANS,
  createOrder,
  verifyPaymentSignature
};
