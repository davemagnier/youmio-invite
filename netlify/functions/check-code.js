// ============================================================
// FILE: netlify/functions/check-code.js
// Create this file at: netlify/functions/check-code.js
// Checks if an invite code is valid and unused
// ============================================================

const { google } = require('googleapis');

const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000;
const RATE_LIMIT_MAX = 30;

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

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const code = event.queryStringParameters?.code;

  if (!code || code.length < 6 || code.length > 12) {
    return { statusCode: 400, headers, body: JSON.stringify({ valid: false, reason: 'invalid_code' }) };
  }

  try {
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY),
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });

    const sheets = google.sheets({ version: 'v4', auth });
    const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;

    // Look up code in InviteCodes sheet
    const codesRes = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'InviteCodes!A:F',
    });

    const rows = codesRes.data.values || [];
    // Find the code (skip header row if present)
    const codeRow = rows.find(row => row[0] === code);

    if (!codeRow) {
      return { statusCode: 200, headers, body: JSON.stringify({ valid: false, reason: 'not_found' }) };
    }

    const [codeValue, inviterWallet, createdAt, used, inviteeWallet, usedAt] = codeRow;

    if (used === 'TRUE' || used === true) {
      return { statusCode: 200, headers, body: JSON.stringify({ valid: false, reason: 'already_used' }) };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        valid: true,
        inviter: inviterWallet.slice(0, 6) + '...' + inviterWallet.slice(-4)
      })
    };

  } catch (error) {
    console.error('Error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error' }) };
  }
};
