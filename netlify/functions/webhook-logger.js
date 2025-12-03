// ============================================
// WEBHOOK LOGGER - Captures raw payloads for debugging
// Deploy, point Stripe/Moonpay here, make a sub, check logs
// ============================================

exports.handler = async (event) => {
  const timestamp = new Date().toISOString();
  
  // Log everything to Netlify function logs
  console.log('=== WEBHOOK RECEIVED ===');
  console.log('Timestamp:', timestamp);
  console.log('Headers:', JSON.stringify(event.headers, null, 2));
  console.log('Body:', event.body);
  console.log('=== END WEBHOOK ===');

  // Return 200 so webhook is accepted
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 
      received: true, 
      timestamp,
      message: 'Logged to Netlify functions - check logs'
    })
  };
};
