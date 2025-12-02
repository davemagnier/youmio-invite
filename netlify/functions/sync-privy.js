// ============================================
// SYNC PRIVY - Uses your existing env var names
// ============================================

const crypto = require('crypto');

// Parse the service account JSON to get email and private key
let GOOGLE_SERVICE_ACCOUNT_EMAIL;
let GOOGLE_PRIVATE_KEY;

try {
  const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '{}');
  GOOGLE_SERVICE_ACCOUNT_EMAIL = serviceAccount.client_email;
  GOOGLE_PRIVATE_KEY = serviceAccount.private_key;
} catch (e) {
  // Will be caught by missing vars check below
}

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;
const PRIVY_APP_ID = process.env.PRIVY_APP_ID;
const PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET;
const SYNC_KEY = process.env.SYNC_KEY || '';

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  // Auth check
  const providedKey = event.queryStringParameters?.key;
  if (SYNC_KEY && providedKey !== SYNC_KEY) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  // Check env vars
  const missing = [];
  if (!GOOGLE_SERVICE_ACCOUNT_EMAIL) missing.push('GOOGLE_SERVICE_ACCOUNT_EMAIL (from GOOGLE_SERVICE_ACCOUNT_KEY)');
  if (!GOOGLE_PRIVATE_KEY) missing.push('GOOGLE_PRIVATE_KEY (from GOOGLE_SERVICE_ACCOUNT_KEY)');
  if (!SPREADSHEET_ID) missing.push('GOOGLE_SPREADSHEET_ID');
  if (!PRIVY_APP_ID) missing.push('PRIVY_APP_ID');
  if (!PRIVY_APP_SECRET) missing.push('PRIVY_APP_SECRET');
  
  if (missing.length > 0) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ error: 'Missing env vars', missing })
    };
  }

  try {
    // Get Google token
    const accessToken = await getGoogleToken();
    
    // Read ClaimedInvites sheet
    const sheetUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/ClaimedInvites!A:E`;
    const sheetResponse = await fetch(sheetUrl, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    
    if (!sheetResponse.ok) {
      const err = await sheetResponse.text();
      return { statusCode: 200, headers, body: JSON.stringify({ error: 'Sheets error', details: err }) };
    }
    
    const sheetData = await sheetResponse.json();
    const rows = sheetData.values || [];
    
    // Find unsynced wallets
    const walletsToSync = [];
    const rowNumbers = [];
    
    for (let i = 1; i < rows.length; i++) {
      const wallet = rows[i][0];
      const privyStatus = rows[i][4];
      if (wallet && !privyStatus) {
        walletsToSync.push(wallet);
        rowNumbers.push(i + 1);
      }
    }
    
    if (walletsToSync.length === 0) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, message: 'No new wallets to sync', synced: 0 })
      };
    }
    
    // Sync to Privy in batches
    let successCount = 0;
    let lastError = null;
    const BATCH_SIZE = 15;
    
    for (let i = 0; i < walletsToSync.length; i += BATCH_SIZE) {
      const batch = walletsToSync.slice(i, i + BATCH_SIZE);
      const batchRows = rowNumbers.slice(i, i + BATCH_SIZE);
      
      const result = await addToPrivy(batch);
      
      if (result.success) {
        for (const rowNum of batchRows) {
          await markAsSynced(accessToken, rowNum);
        }
        successCount += batch.length;
      } else {
        lastError = result;
      }
      
      if (i + BATCH_SIZE < walletsToSync.length) {
        await new Promise(r => setTimeout(r, 500));
      }
    }
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: successCount > 0,
        synced: successCount,
        total: walletsToSync.length,
        privyError: lastError,
        debug: {
          appIdLength: PRIVY_APP_ID?.length,
          appIdStart: PRIVY_APP_ID?.substring(0, 8),
          secretLength: PRIVY_APP_SECRET?.length
        }
      })
    };
    
  } catch (error) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ error: error.message, stack: error.stack?.substring(0, 300) })
    };
  }
};

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
  if (!data.access_token) throw new Error('No access token: ' + JSON.stringify(data));
  return data.access_token;
}

async function markAsSynced(accessToken, rowNum) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/ClaimedInvites!E${rowNum}?valueInputOption=RAW`;
  await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ values: [['synced']] })
  });
}

async function addToPrivy(wallets) {
  const authString = Buffer.from(`${PRIVY_APP_ID}:${PRIVY_APP_SECRET}`).toString('base64');
  const response = await fetch(`https://auth.privy.io/api/v1/apps/${PRIVY_APP_ID}/allowlist`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${authString}`,
      'Content-Type': 'application/json',
      'privy-app-id': PRIVY_APP_ID
    },
    body: JSON.stringify(wallets.map(w => ({ type: 'wallet', value: w })))
  });
  
  // Treat as success if: 200/201 OR if already exists (400/409)
  if (response.ok) {
    return { success: true };
  }
  
  const errorText = await response.text();
  
  // If wallets already exist, that's fine - treat as success
  if (errorText.includes('already') || response.status === 409) {
    return { success: true, alreadyExists: true };
  }
  
  console.log('Privy error:', response.status, errorText);
  return { success: false, status: response.status, error: errorText };
}
