// ============================================================
// FILE: netlify/functions/claim-code.js
// Claims an invite code with a wallet address
// ============================================================

const { google } = require('googleapis');

const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000;
const RATE_LIMIT_MAX = 5;

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

  const { code, wallet } = body;

  if (!code || code.length < 6 || code.length > 12) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid code' }) };
  }

  if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid wallet' }) };
  }

  try {
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const sheets = google.sheets({ version: 'v4', auth });
    const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;

    // Get InviteCodes sheet
    const codesRes = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'InviteCodes!A:F',
    });

    const rows = codesRes.data.values || [];
    let codeRowIndex = -1;
    let codeRow = null;

    for (let i = 0; i < rows.length; i++) {
      if (rows[i][0] === code) {
        codeRowIndex = i;
        codeRow = rows[i];
        break;
      }
    }

    if (!codeRow) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid code' }) };
    }

    const [codeValue, inviterWallet, createdAt, used] = codeRow;

    if (used === 'TRUE' || used === true) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Code already used' }) };
    }

    // Check if wallet is already in Allowlist
    const allowlistRes = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'Allowlist!A:B',
    });

    const allowlistRows = allowlistRes.data.values || [];
    const alreadyAllowlisted = allowlistRows.some(
      row => row[0]?.toLowerCase() === wallet.toLowerCase()
    );

    if (alreadyAllowlisted) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Wallet already allowlisted' }) };
    }

    // Check if wallet already claimed another code
    const alreadyClaimed = rows.some(
      row => row[4]?.toLowerCase() === wallet.toLowerCase()
    );

    if (alreadyClaimed) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Wallet already used an invite' }) };
    }

    // Prevent self-invite
    if (inviterWallet.toLowerCase() === wallet.toLowerCase()) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Cannot invite yourself' }) };
    }

    // Mark code as used
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `InviteCodes!D${codeRowIndex + 1}:F${codeRowIndex + 1}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [['TRUE', wallet, new Date().toISOString()]]
      }
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true })
    };

  } catch (error) {
    console.error('Error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error' }) };
  }
};
