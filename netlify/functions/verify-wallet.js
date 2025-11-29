// ============================================================
// FILE: netlify/functions/verify-wallet.js
// Verifies wallet ownership via signature before allowing code generation
// ============================================================

const { ethers } = require('ethers');

const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000;
const RATE_LIMIT_MAX = 10;

// Store verified sessions (in production, use Redis or similar)
// Format: { visitorId visitorId visitorId: { wallet, timestamp, expires } }
const verifiedSessions = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const record = rateLimitMap.get(ip);
  if (!record || now - record.timestamp > RATE_LIMIT_WINDOW) {
    rateLimitMap.set(ip, { timestamp: now, count: 1 });
    return false;
  }
  record.count++;
  return record.count > RATE_LIMIT_MAX;
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const clientIP = event.headers['x-forwarded-for'] || 'unknown';
  if (isRateLimited(clientIP)) {
    return { statusCode: 429, headers, body: JSON.stringify({ error: 'Too many requests' }) };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { wallet, signature, message, sessionId } = body;

  if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid wallet' }) };
  }

  if (!signature || !message || !sessionId) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing signature, message, or sessionId' }) };
  }

  try {
    // Verify the signature
    const recoveredAddress = ethers.verifyMessage(message, signature);

    // Check if recovered address matches claimed wallet
    if (recoveredAddress.toLowerCase() !== wallet.toLowerCase()) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Signature does not match wallet' }) };
    }

    // Verify message contains the correct wallet and is recent
    if (!message.includes(wallet.slice(0, 6)) || !message.includes(wallet.slice(-4))) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid message format' }) };
    }

    // Store verified session (expires in 10 minutes)
    const expires = Date.now() + (10 * 60 * 1000);
    verifiedSessions.set(sessionId, {
      wallet: wallet.toLowerCase(),
      expires: expires
    });

    // Clean up old sessions
    for (const [key, value] of verifiedSessions.entries()) {
      if (value.expires < Date.now()) {
        verifiedSessions.delete(key);
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        verified: true,
        expiresIn: 600 // 10 minutes
      })
    };

  } catch (error) {
    console.error('Error verifying signature:', error);
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid signature' }) };
  }
};

// Export for use by generate-code function
module.exports.verifiedSessions = verifiedSessions;
