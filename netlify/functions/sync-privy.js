// ============================================
// SYNC CLAIMED WALLETS TO PRIVY ALLOWLIST
// Netlify Function - No external dependencies
// ============================================

const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const PRIVY_APP_ID = process.env.PRIVY_APP_ID;
const PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET;
const SYNC_KEY = process.env.SYNC_KEY || '';

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  // Auth check for manual triggers
  const providedKey = event.queryStringParameters?.key;
  if (SYNC_KEY && providedKey !== SYNC_KEY) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  try {
    // Get Google access token
    const accessToken = await getGoogleAccessToken();
    
    // Read ClaimedInvites sheet
    const sheetUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/ClaimedInvites!A:E`;
    const sheetResponse = await fetch(sheetUrl, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    
    if (!sheetResponse.ok) {
      throw new Error(`Sheets API error: ${sheetResponse.status}`);
    }
    
    const sheetData = await sheetResponse.json();
    const rows = sheetData.values || [];
    
    // Find wallets not yet synced (column E = privy_status)
    const walletsToSync = [];
    const rowNumbers = [];
    
    for (let i = 1; i < rows.length; i++) {
      const wallet = rows[i][0];
      const privyStatus = rows[i][4]; // Column E (0-indexed = 4)
      
      if (wallet && !privyStatus) {
        walletsToSync.push(wallet);
        rowNumbers.push(i + 1); // 1-indexed for Sheets
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
    const BATCH_SIZE = 15;
    let successCount = 0;
    let failedCount = 0;
    
    for (let i = 0; i < walletsToSync.length; i += BATCH_SIZE) {
      const batch = walletsToSync.slice(i, i + BATCH_SIZE);
      const batchRows = rowNumbers.slice(i, i + BATCH_SIZE);
      
      const privyResult = await addToPrivy(batch);
      
      if (privyResult.success) {
        // Mark rows as synced
        for (const rowNum of batchRows) {
          await updateSheetCell(accessToken, rowNum);
        }
        successCount += batch.length;
      } else {
        failedCount += batch.length;
      }
      
      // Rate limit delay
      if (i + BATCH_SIZE < walletsToSync.length) {
        await new Promise(r => setTimeout(r, 500));
      }
    }
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        message: `Synced ${successCount} wallets to Privy`,
        synced: successCount,
        failed: failedCount,
        total: walletsToSync.length
      })
    };
    
  } catch (error) {
    console.error('Sync error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Server error', details: error.message })
    };
  }
};

// Get Google OAuth access token using service account
async function getGoogleAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: GOOGLE_SERVICE_ACCOUNT_EMAIL,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  };
  
  const jwt = await createJWT(claim, GOOGLE_PRIVATE_KEY);
  
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
  });
  
  const tokenData = await tokenResponse.json();
  if (!tokenData.access_token) {
    throw new Error('Failed to get Google access token');
  }
  return tokenData.access_token;
}

// Create JWT for Google auth
async function createJWT(payload, privateKey) {
  const encoder = new TextEncoder();
  
  const header = { alg: 'RS256', typ: 'JWT' };
  const headerB64 = base64url(JSON.stringify(header));
  const payloadB64 = base64url(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;
  
  // Import private key
  const pemContents = privateKey
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s/g, '');
  const binaryKey = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));
  
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    binaryKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    encoder.encode(signingInput)
  );
  
  const signatureB64 = base64url(String.fromCharCode(...new Uint8Array(signature)));
  return `${signingInput}.${signatureB64}`;
}

function base64url(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Update sheet cell to mark as synced
async function updateSheetCell(accessToken, rowNum) {
  const updateUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/ClaimedInvites!E${rowNum}?valueInputOption=RAW`;
  await fetch(updateUrl, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ values: [['synced']] })
  });
}

// Add wallets to Privy allowlist
async function addToPrivy(wallets) {
  const authString = Buffer.from(`${PRIVY_APP_ID}:${PRIVY_APP_SECRET}`).toString('base64');
  const payload = wallets.map(w => ({ type: 'wallet', value: w }));
  
  try {
    const response = await fetch(`https://auth.privy.io/api/v1/apps/${PRIVY_APP_ID}/allowlist`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${authString}`,
        'Content-Type': 'application/json',
        'privy-app-id': PRIVY_APP_ID
      },
      body: JSON.stringify(payload)
    });
    
    return { success: response.ok };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
