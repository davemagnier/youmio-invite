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

  const inviter = event.queryStringParameters?.inviter;

  if (!inviter || !/^0x[a-fA-F0-9]{40}$/.test(inviter)) {
    return { statusCode: 400, headers, body: JSON.stringify({ valid: false, error: 'Invalid wallet' }) };
  }

  try {
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const sheets = google.sheets({ version: 'v4', auth });
    
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
      range: 'Allowlist!A:B',
    });

    const rows = response.data.values || [];
    const inviterRow = rows.find(row => row[0]?.toLowerCase() === inviter.toLowerCase());

    if (!inviterRow) {
      return { statusCode: 200, headers, body: JSON.stringify({ valid: false, reason: 'not_allowlisted' }) };
    }

    const invitesRemaining = parseInt(inviterRow[1] || '0', 10);

    if (invitesRemaining <= 0) {
      return { statusCode: 200, headers, body: JSON.stringify({ valid: false, reason: 'no_invites' }) };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        valid: true,
        invitesRemaining,
        inviter: inviter.slice(0, 6) + '...' + inviter.slice(-4)
      })
    };
  } catch (error) {
    console.error('Error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error' }) };
  }
};
