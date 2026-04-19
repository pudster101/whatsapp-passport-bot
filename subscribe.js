const https = require('https');
require('dotenv').config();

const token = process.env.WHATSAPP_TOKEN;
const wabaId = '912733271759794';

console.log('Subscribing WABA to ChatBot romania app...');
console.log('WABA ID:', wabaId);

const options = {
  hostname: 'graph.facebook.com',
  path: `/v18.0/${wabaId}/subscribed_apps`,
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': 0,
    'Authorization': `Bearer ${token}`
  }
};

const req = https.request(options, (res) => {
  let body = '';
  res.on('data', d => body += d);
  res.on('end', () => {
    console.log('Response:', body);
    try {
      const parsed = JSON.parse(body);
      if (parsed.success) {
        console.log('\n✅ WABA subscribed successfully! Webhook events will now be delivered.');
      } else {
        console.log('\n❌ Subscription failed. See response above.');
      }
    } catch (e) {
      console.log('Could not parse response.');
    }
  });
});

req.on('error', e => console.error('Error:', e));
req.end();
