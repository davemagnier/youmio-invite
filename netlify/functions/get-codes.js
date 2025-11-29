// ============================================================
// FILE: netlify/functions/get-codes.js
// Returns existing unused codes for a wallet
// ============================================================

const { google } = require('googleapis');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const inviter = event.queryStringParameters?.inviter;

  if (!inviter || !/^0x[a-fA-F0-9]{40}$/.test(inviter)) {
    return { 
      statusCode: 400, 
      headers, 
      body: JSON.stringify({ success: false, error: 'Invalid wallet address' }) 
    };
  }

  try {
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const sheets = google.sheets({ version: 'v4', auth });
    
    // Get all codes from the InviteCodes sheet
    // Columns: A=code, B=inviter_wallet, C=created_at, D=used, E=invitee_wallet, F=used_at
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
      range: 'InviteCodes!A:F',
    });

    const rows = response.data.values || [];
    
    // Find all codes created by this inviter
    const codes = [];
    for (let i = 1; i < rows.length; i++) { // Skip header row
      const row = rows[i];
      const code = row[0];
      const rowInviter = row[1];
      const used = row[3]; // Column D: TRUE or FALSE
      
      // Match inviter (case-insensitive)
      if (rowInviter && rowInviter.toLowerCase() === inviter.toLowerCase()) {
        codes.push({
          code: code,
          used: used === 'TRUE'
        });
      }
    }

    // Return only unused codes
    const unusedCodes = codes.filter(c => !c.used).map(c => c.code);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        codes: unusedCodes,
        totalGenerated: codes.length,
        used: codes.filter(c => c.used).length
      })
    };

  } catch (error) {
    console.error('Error:', error);
    return { 
      statusCode: 500, 
      headers, 
      body: JSON.stringify({ success: false, error: 'Server error' }) 
    };
  }
};
