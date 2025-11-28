// ============================================================
// FILE: netlify/functions/generate-code.js
// Generates a unique one-time invite code for an inviter
// ============================================================

const { google } = require('googleapis');

const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000;
const RATE_LIMIT_MAX = 10;

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

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
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

  const { inviter } = body;

  if (!inviter || !/^0x[a-fA-F0-9]{40}$/.test(inviter)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid wallet' }) };
  }

  try {
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const sheets = google.sheets({ version: 'v4', auth });
    const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;

    // Check inviter is allowlisted and has invites remaining
    const allowlistRes = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'Allowlist!A:B',
    });

    const allowlistRows = allowlistRes.data.values || [];
    const inviterRow = allowlistRows.find(row => row[0]?.toLowerCase() === inviter.toLowerCase());

    if (!inviterRow) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Not on allowlist' }) };
    }

    const invitesRemaining = parseInt(inviterRow[1] || '0', 10);
    if (invitesRemaining <= 0) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'No invites remaining' }) };
    }

    // Generate unique code
    const code = generateCode();

    // Add code to InviteCodes sheet
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: 'InviteCodes!A:F',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[code, inviter, new Date().toISOString(), 'FALSE', '', '']]
      }
    });

    // Decrement inviter's remaining invites
    const inviterRowIndex = allowlistRows.findIndex(row => row[0]?.toLowerCase() === inviter.toLowerCase());
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: 'Allowlist!B' + (inviterRowIndex + 1),
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[invitesRemaining - 1]]
      }
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        code: code,
        invitesRemaining: invitesRemaining - 1
      })
    };

  } catch (error) {
    console.error('Error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error' }) };
  }
};
