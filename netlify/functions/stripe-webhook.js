// ============================================
// STRIPE WEBHOOK - Tracks subscription conversions
// ============================================

const crypto = require('crypto');

let GOOGLE_SERVICE_ACCOUNT_EMAIL;
let GOOGLE_PRIVATE_KEY;

try {
  const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '{}');
  GOOGLE_SERVICE_ACCOUNT_EMAIL = serviceAccount.client_email;
  GOOGLE_PRIVATE_KEY = serviceAccount.private_key;
} catch (e) {}

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// Star bonus amounts
const STAR_BONUSES = {
  'standard': 40000,
  'pro': 80000
};

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    // Verify Stripe signature (skip if no signature header - for testing)
    const sig = event.headers['stripe-signature'];
    const body = event.body;
    
    if (sig && !verifyStripeSignature(body, sig, STRIPE_WEBHOOK_SECRET)) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid signature' }) };
    }

    const stripeEvent = JSON.parse(body);

    // Only process successful subscription events
    if (stripeEvent.type !== 'customer.subscription.created' && 
        stripeEvent.type !== 'checkout.session.completed') {
      return { statusCode: 200, headers, body: JSON.stringify({ received: true, skipped: true }) };
    }

    // Extract subscription data
    const subscription = stripeEvent.data.object;
    const metadata = subscription.metadata || {};
    
    const subscriberWallet = metadata.wallet_address || '';
    const subscriberUsername = metadata.username || '';
    const subscriberEmail = subscription.customer_email || metadata.email || '';
    const subscriberPrivyId = metadata.privy_user_id || '';
    const subscriberUserId = metadata.user_id || '';
    
    // Determine tier from product name
    let tier = 'standard';
    
    // Try to get product name from subscription items
    const items = subscription.items?.data || [];
    if (items.length > 0) {
      const productName = (items[0].price?.product?.name || items[0].plan?.nickname || '').toLowerCase();
      if (productName.includes('pro')) {
        tier = 'pro';
      } else if (productName.includes('standard')) {
        tier = 'standard';
      }
    }
    
    // Also check if product name is directly on the object (checkout sessions)
    const productNameDirect = (subscription.display_items?.[0]?.custom?.name || 
                              subscription.line_items?.data?.[0]?.description || '').toLowerCase();
    if (productNameDirect.includes('pro')) {
      tier = 'pro';
    } else if (productNameDirect.includes('standard')) {
      tier = 'standard';
    }
    
    // Fallback to metadata if set
    if (metadata.tier) {
      tier = metadata.tier.toLowerCase();
    }

    if (!subscriberWallet) {
      console.log('No wallet in metadata, skipping');
      return { statusCode: 200, headers, body: JSON.stringify({ received: true, skipped: 'no_wallet' }) };
    }

    // Get Google token
    const accessToken = await getGoogleToken();

    // Look up inviter from ClaimedInvites
    const inviterData = await findInviter(accessToken, subscriberWallet);

    // Only track if this subscriber was invited by someone
    if (!inviterData.wallet) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ 
          received: true, 
          skipped: 'not_invited',
          subscriber: subscriberWallet
        })
      };
    }

    // Calculate star bonus
    const starsBonus = STAR_BONUSES[tier];

    // Write to Conversions sheet
    const conversionRow = [
      subscriberWallet,
      subscriberUsername,
      subscriberEmail,
      tier,
      new Date().toISOString(),
      'stripe',
      inviterData.wallet || '',
      inviterData.username || '',
      starsBonus,
      'pending'
    ];

    await appendToSheet(accessToken, 'Conversions', conversionRow);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ 
        success: true, 
        subscriber: subscriberWallet,
        tier,
        inviter: inviterData.wallet,
        starsBonus
      })
    };

  } catch (error) {
    console.error('Webhook error:', error);
    return {
      statusCode: 200, // Return 200 so Stripe doesn't retry
      headers,
      body: JSON.stringify({ error: error.message })
    };
  }
};

// Verify Stripe webhook signature
function verifyStripeSignature(payload, sig, secret) {
  if (!secret) return true; // Skip verification if no secret set (for testing)
  
  try {
    const elements = sig.split(',');
    const timestamp = elements.find(e => e.startsWith('t=')).substring(2);
    const signature = elements.find(e => e.startsWith('v1=')).substring(3);
    
    const signedPayload = `${timestamp}.${payload}`;
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(signedPayload)
      .digest('hex');
    
    return signature === expectedSignature;
  } catch (e) {
    return false;
  }
}

// Find who invited this wallet
async function findInviter(accessToken, subscriberWallet) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/ClaimedInvites!A:B`;
  const response = await fetch(url, {
    headers: { 'Authorization': `Bearer ${accessToken}` }
  });
  
  if (!response.ok) return { wallet: '', username: '' };
  
  const data = await response.json();
  const rows = data.values || [];
  
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0]?.toLowerCase() === subscriberWallet.toLowerCase()) {
      return { 
        wallet: rows[i][1] || '',
        username: '' // We don't have inviter username in ClaimedInvites currently
      };
    }
  }
  
  return { wallet: '', username: '' };
}

// Append row to sheet
async function appendToSheet(accessToken, sheetName, rowData) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${sheetName}!A:J:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
  await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ values: [rowData] })
  });
}

// Google auth
async function getGoogleToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: GOOGLE_SERVICE_ACCOUNT_EMAIL,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  };
  
  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signingInput = `${headerB64}.${payloadB64}`;
  
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(signingInput);
  const signature = sign.sign(GOOGLE_PRIVATE_KEY, 'base64url');
  
  const jwt = `${signingInput}.${signature}`;
  
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
  });
  
  const data = await response.json();
  if (!data.access_token) throw new Error('No access token');
  return data.access_token;
}
