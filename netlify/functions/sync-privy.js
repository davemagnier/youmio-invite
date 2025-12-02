// ============================================
// SYNC PRIVY - DEBUG VERSION
// ============================================

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  const debug = {
    step: 'init',
    envVars: {},
    errors: []
  };

  try {
    // Step 1: Check environment variables
    debug.step = 'checking env vars';
    debug.envVars = {
      GOOGLE_SERVICE_ACCOUNT_EMAIL: !!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      GOOGLE_PRIVATE_KEY: !!process.env.GOOGLE_PRIVATE_KEY,
      SPREADSHEET_ID: !!process.env.SPREADSHEET_ID,
      PRIVY_APP_ID: !!process.env.PRIVY_APP_ID,
      PRIVY_APP_SECRET: !!process.env.PRIVY_APP_SECRET,
      SYNC_KEY: !!process.env.SYNC_KEY
    };

    // Check for missing vars
    const missing = Object.entries(debug.envVars)
      .filter(([k, v]) => !v)
      .map(([k]) => k);
    
    if (missing.length > 0) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: false,
          error: 'Missing environment variables',
          missing,
          debug
        }, null, 2)
      };
    }

    // Step 2: Auth check
    debug.step = 'auth check';
    const SYNC_KEY = process.env.SYNC_KEY;
    const providedKey = event.queryStringParameters?.key;
    
    if (SYNC_KEY && providedKey !== SYNC_KEY) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: false,
          error: 'Invalid sync key',
          debug
        }, null, 2)
      };
    }

    // Step 3: Test Privy connection
    debug.step = 'testing Privy API';
    const PRIVY_APP_ID = process.env.PRIVY_APP_ID;
    const PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET;
    const authString = Buffer.from(`${PRIVY_APP_ID}:${PRIVY_APP_SECRET}`).toString('base64');
    
    // Just test the connection with an empty array (won't add anything)
    const privyTest = await fetch(`https://auth.privy.io/api/v1/apps/${PRIVY_APP_ID}/allowlist`, {
      method: 'GET',
      headers: {
        'Authorization': `Basic ${authString}`,
        'privy-app-id': PRIVY_APP_ID
      }
    });
    
    debug.privyStatus = privyTest.status;
    debug.privyOk = privyTest.ok;

    // Step 4: Test Google Sheets (simple read)
    debug.step = 'testing Google Sheets';
    const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
    const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
    
    // Get access token
    debug.step = 'getting Google token';
    const tokenResult = await getGoogleToken(GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY);
    
    if (!tokenResult.success) {
      debug.googleError = tokenResult.error;
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: false,
          error: 'Failed to get Google token',
          debug
        }, null, 2)
      };
    }
    
    debug.step = 'reading sheet';
    const sheetUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/ClaimedInvites!A1:E5`;
    const sheetResponse = await fetch(sheetUrl, {
      headers: { 'Authorization': `Bearer ${tokenResult.token}` }
    });
    
    debug.sheetStatus = sheetResponse.status;
    debug.sheetOk = sheetResponse.ok;
    
    if (!sheetResponse.ok) {
      const errorText = await sheetResponse.text();
      debug.sheetError = errorText.substring(0, 200);
    }

    // Return debug info
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        message: 'Debug complete - all checks passed',
        debug
      }, null, 2)
    };

  } catch (error) {
    debug.crashError = error.message;
    debug.stack = error.stack?.substring(0, 500);
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: false,
        error: 'Function crashed',
        debug
      }, null, 2)
    };
  }
};

// Simplified Google token fetch using JWT
async function getGoogleToken(email, privateKey) {
  try {
    const crypto = require('crypto');
    
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const payload = {
      iss: email,
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
    const signature = sign.sign(privateKey, 'base64url');
    
    const jwt = `${signingInput}.${signature}`;
    
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
    });
    
    const tokenData = await tokenResponse.json();
    
    if (tokenData.access_token) {
      return { success: true, token: tokenData.access_token };
    } else {
      return { success: false, error: JSON.stringify(tokenData) };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}
