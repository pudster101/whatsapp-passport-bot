const https = require('https');
require('dotenv').config();

const token = process.env.WHATSAPP_TOKEN;
const phoneId = process.env.WHATSAPP_PHONE_ID;

console.log('Registering phone number ID:', phoneId);

const data = JSON.stringify({
  messaging_product: 'whatsapp',
  pin: '123456'
});

const options = {
  hostname: 'graph.facebook.com',
  path: `/v18.0/${phoneId}/register`,
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': data.length,
    'Authorization': `Bearer ${token}`
  }
};

const req = https.request(options, (res) => {
  let body = '';
  res.on('data', d => body += d);
  res.on('end', () => {
    console.log('Response:', body);
    const parsed = JSON.parse(body);
    if (parsed.success) {
      console.log('\n✅ Phone number registered successfully! It should now be active on WhatsApp.');
    } else {
      console.log('\n❌ Registration failed. See response above.');
    }
  });
});

req.on('error', e => console.error('Error:', e));
req.write(data);
req.end();
