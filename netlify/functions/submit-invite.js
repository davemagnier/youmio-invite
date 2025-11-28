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

  const { inviter, invitee } = body;
  const walletRegex = /^0x[a-fA-F0-9]{40}$/;

  if (!inviter || !invitee || !walletRegex.test(inviter) || !walletRegex.test(invitee)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid wallet' }) };
  }

  if (inviter.toLowerCase() === invitee.toLowerCase()) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Cannot invite yourself' }) };
  }

  try {
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const sheets = google.sheets({ version: 'v4', auth });
    const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;

    const allowlistRes = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'Allowlist!A:B',
    });

    const allowlistRows = allowlistRes.data.values || [];
    let inviterRowIndex = -1;
    
    for (let i = 0; i < allowlistRows.length; i++) {
      if (allowlistRows[i][0]?.toLowerCase() === inviter.toLowerCase()) {
        inviterRowIndex = i;
        break;
      }
    }

    if (inviterRowIndex === -1) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Inviter not on allowlist' }) };
    }

    const invitesRemaining = parseInt(allowlistRows[inviterRowIndex][1] || '0', 10);
    if (invitesRemaining <= 0) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'No invites remaining' }) };
    }

    const alreadyAllowlisted = allowlistRows.some(
      row => row[0]?.toLowerCase() === invitee.toLowerCase()
    );
    if (alreadyAllowlisted) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Already allowlisted' }) };
    }

    const inviteesRes = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'Invitees!A:B',
    });

    const alreadyInvited = (inviteesRes.data.values || []).some(
      row => row[1]?.toLowerCase() === invitee.toLowerCase()
    );
    if (alreadyInvited) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Already invited' }) };
    }

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: 'Invitees!A:C',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[inviter, invitee, new Date().toISOString()]] }
    });

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: 'Allowlist!B' + (inviterRowIndex + 1),
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[invitesRemaining - 1]] }
    });

    return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
  } catch (error) {
    console.error('Error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error' }) };
  }
};
