// ============================================
// SYNC CLAIMED WALLETS TO PRIVY ALLOWLIST
// Netlify Function
// ============================================
// Can be triggered manually or on a schedule
// 
// Manual trigger: GET https://invite.youmio.ai/.netlify/functions/sync-privy
// With auth: GET https://invite.youmio.ai/.netlify/functions/sync-privy?key=YOUR_SYNC_KEY
// ============================================

const { google } = require('googleapis');

// Environment variables (set in Netlify dashboard)
const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const PRIVY_APP_ID = process.env.PRIVY_APP_ID;
const PRIVY_APP_SECRET = process.env.PRIVY_APP_SECRET;
const SYNC_KEY = process.env.SYNC_KEY || ''; // Optional auth key for manual triggers

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  // Optional: Check auth key for manual triggers
  const providedKey = event.queryStringParameters?.key;
  if (SYNC_KEY && providedKey !== SYNC_KEY) {
    return {
      statusCode: 401,
      headers,
      body: JSON.stringify({ error: 'Unauthorized' })
    };
  }

  try {
    // Initialize Google Sheets
    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
        private_key: GOOGLE_PRIVATE_KEY
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    const sheets = google.sheets({ version: 'v4', auth });

    // Get all claimed invites
    const claimedResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'ClaimedInvites!A:E' // A=invitee, B=inviter, C=claimed_at, D=code, E=privy_status
    });

    const claimedRows = claimedResponse.data.values || [];
    
    // Skip header row, find wallets not yet synced to Privy
    const walletsToSync = [];
    const rowsToUpdate = [];

    for (let i = 1; i < claimedRows.length; i++) {
      const row = claimedRows[i];
      const wallet = row[0];
      const privyStatus = row[4]; // Column E

      // Skip if no wallet or already synced
      if (!wallet || privyStatus === 'synced' || privyStatus === 'added') {
        continue;
      }

      walletsToSync.push(wallet);
      rowsToUpdate.push(i + 1); // 1-indexed for Sheets API
    }

    if (walletsToSync.length === 0) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          message: 'No new wallets to sync',
          synced: 0
        })
      };
    }

    // Sync to Privy in batches of 15
    const BATCH_SIZE = 15;
    let successCount = 0;
    let failedCount = 0;
    const results = [];

    for (let i = 0; i < walletsToSync.length; i += BATCH_SIZE) {
      const batch = walletsToSync.slice(i, i + BATCH_SIZE);
      const batchRows = rowsToUpdate.slice(i, i + BATCH_SIZE);

      try {
        const privyResponse = await addToPrivy(batch);
        
        if (privyResponse.success) {
          // Mark these rows as synced in Google Sheets
          for (const rowNum of batchRows) {
            await sheets.spreadsheets.values.update({
              spreadsheetId: SPREADSHEET_ID,
              range: `ClaimedInvites!E${rowNum}`,
              valueInputOption: 'RAW',
              requestBody: { values: [['synced']] }
            });
          }
          successCount += batch.length;
          results.push({ batch: Math.floor(i / BATCH_SIZE) + 1, status: 'success', count: batch.length });
        } else {
          failedCount += batch.length;
          results.push({ batch: Math.floor(i / BATCH_SIZE) + 1, status: 'failed', error: privyResponse.error });
        }
      } catch (err) {
        failedCount += batch.length;
        results.push({ batch: Math.floor(i / BATCH_SIZE) + 1, status: 'error', error: err.message });
      }

      // Small delay between batches to avoid rate limits
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
        total: walletsToSync.length,
        results
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

// Helper: Add wallets to Privy allowlist
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

    if (response.ok) {
      return { success: true };
    } else {
      const errorText = await response.text();
      return { success: false, error: `HTTP ${response.status}: ${errorText}` };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}
