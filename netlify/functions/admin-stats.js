// ============================================================
// FILE: netlify/functions/admin-stats.js
// Password-protected admin stats endpoint
// ============================================================

const { google } = require('googleapis');

const ADMIN_PASSWORD = 'youmioinviteaccess';

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Check password
  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { password } = body;
  
  if (!password || password !== ADMIN_PASSWORD) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid password' }) };
  }

  // Password verified - fetch stats
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY),
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });

    const sheets = google.sheets({ version: 'v4', auth });
    const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;

    // Get Allowlist
    const allowlistRes = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'Allowlist!A:B',
    });
    const allowlistRows = (allowlistRes.data.values || []).slice(1); // Skip header

    // Get InviteCodes
    const codesRes = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'InviteCodes!A:F',
    });
    const codeRows = (codesRes.data.values || []).slice(1); // Skip header

    // Get ClaimedInvites
    const claimedRes = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'ClaimedInvites!A:C',
    });
    const claimedRows = (claimedRes.data.values || []).slice(1); // Skip header

    // Calculate stats
    const totalAllowlisted = allowlistRows.length;
    const totalInvitesAvailable = allowlistRows.reduce((sum, row) => sum + (parseInt(row[1]) || 0), 0);
    const totalCodesGenerated = codeRows.length;
    const totalCodesClaimed = codeRows.filter(row => row[3] === 'TRUE').length;
    const totalCodesUnclaimed = totalCodesGenerated - totalCodesClaimed;

    // Top inviters
    const inviterCounts = {};
    codeRows.forEach(row => {
      const inviter = row[1];
      if (inviter) {
        inviterCounts[inviter] = (inviterCounts[inviter] || 0) + 1;
      }
    });
    const topInviters = Object.entries(inviterCounts)
      .map(([wallet, count]) => ({ 
        wallet: wallet.slice(0, 6) + '...' + wallet.slice(-4), 
        fullWallet: wallet,
        codesGenerated: count 
      }))
      .sort((a, b) => b.codesGenerated - a.codesGenerated)
      .slice(0, 10);

    // Recent claims (last 20)
    const recentClaims = claimedRows
      .map(row => ({
        invitee: row[0]?.slice(0, 6) + '...' + row[0]?.slice(-4),
        inviter: row[1]?.slice(0, 6) + '...' + row[1]?.slice(-4),
        claimedAt: row[2]
      }))
      .reverse()
      .slice(0, 20);

    // Claims per day (last 7 days)
    const now = new Date();
    const claimsPerDay = {};
    for (let i = 0; i < 7; i++) {
      const date = new Date(now);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      claimsPerDay[dateStr] = 0;
    }
    claimedRows.forEach(row => {
      if (row[2]) {
        const dateStr = row[2].split('T')[0];
        if (claimsPerDay.hasOwnProperty(dateStr)) {
          claimsPerDay[dateStr]++;
        }
      }
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        stats: {
          totalAllowlisted,
          totalInvitesAvailable,
          totalCodesGenerated,
          totalCodesClaimed,
          totalCodesUnclaimed,
          claimRate: totalCodesGenerated > 0 
            ? Math.round((totalCodesClaimed / totalCodesGenerated) * 100) 
            : 0,
          topInviters,
          recentClaims,
          claimsPerDay
        }
      })
    };

  } catch (error) {
    console.error('Error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error' }) };
  }
};
