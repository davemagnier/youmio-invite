// ============================================================
// FILE: netlify/functions/sync-privy.js
// Automatically syncs ClaimedInvites to Privy allowlist
// Runs on schedule or manually via URL
// ============================================================

const { google } = require('googleapis');
const https = require('https');

const PRIVY_APP_ID = 'cmgqahr6h00leib0caoqz5a89';
const PRIVY_APP_SECRET = 'c9kWah6RMVuY2mATCMhzDQiR8c8oJYkgL7cRR9UugPH2ahvwDYjtLAkWWDiLTUQHbBc3ihhW4U5cJbuXXvSHM9yq';
const BATCH_SIZE = 15;

function addToPrivy(wallets) {
  return new Promise((resolve) => {
    const data = JSON.stringify(wallets.map(w => ({ type: 'wallet', value: w })));
    const auth = Buffer.from(`${PRIVY_APP_ID}:${PRIVY_APP_SECRET}`).toString('base64');
    
    const req = https.request({
      hostname: 'auth.privy.io',
      path: `/api/v1/apps/${PRIVY_APP_ID}/allowlist`,
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'privy-app-id': PRIVY_APP_ID
      }
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        const success = res.statusCode < 300 || 
                        body.toLowerCase().includes('already') ||
                        body.toLowerCase().includes('exists');
        resolve({ success, status: res.statusCode });
      });
    });
    
    req.on('error', (e) => resolve({ success: false, error: e.message }));
    req.write(data);
    req.end();
  });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  try {
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const sheets = google.sheets({ version: 'v4', auth });
    const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;

    // Get ClaimedInvites sheet
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'ClaimedInvites!A:D',
    });

    const rows = response.data.values || [];
    
    // Ensure header has privy_status column
    if (rows.length > 0 && rows[0][3] !== 'privy_status') {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: 'ClaimedInvites!D1',
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [['privy_status']] }
      });
    }

    // Find wallets that haven't been synced yet (no status in column D)
    const toSync = [];
    for (let i = 1; i < rows.length; i++) {
      const wallet = rows[i][0];
      const status = rows[i][3];
      
      if (wallet && wallet.startsWith('0x') && !status) {
        toSync.push({ wallet, row: i + 1 });
      }
    }

    if (toSync.length === 0) {
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

    // Process in batches
    let synced = 0;
    let failed = 0;

    for (let i = 0; i < toSync.length; i += BATCH_SIZE) {
      const batch = toSync.slice(i, i + BATCH_SIZE);
      const wallets = batch.map(b => b.wallet);
      
      const result = await addToPrivy(wallets);
      
      // Update status in sheet
      const updates = batch.map(b => ({
        range: `ClaimedInvites!D${b.row}`,
        values: [[result.success ? 'added' : 'failed']]
      }));

      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
          valueInputOption: 'USER_ENTERED',
          data: updates
        }
      });

      if (result.success) {
        synced += batch.length;
      } else {
        failed += batch.length;
      }

      // Small delay between batches
      if (i + BATCH_SIZE < toSync.length) {
        await delay(300);
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        message: `Synced ${synced} wallets to Privy`,
        synced,
        failed,
        total: toSync.length
      })
    };

  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ success: false, error: error.message })
    };
  }
};
