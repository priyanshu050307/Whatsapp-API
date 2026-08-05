const http = require('http');

function makeRequest(options, postData) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });
    req.on('error', (err) => reject(err));
    if (postData) {
      req.write(JSON.stringify(postData));
    }
    req.end();
  });
}

async function testSendMessage() {
  console.log('Testing sending live WhatsApp message through existing connected backend session...');

  // Login as rkv.busy@gmail.com
  const loginRes = await makeRequest({
    hostname: 'localhost',
    port: 3005,
    path: '/api/auth/google',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { email: 'rkv.busy@gmail.com' });

  const token = loginRes.data.token;
  console.log('Logged in for:', loginRes.data.tenant.email);

  // Send live message to self/test number 919820685562
  const sendRes = await makeRequest({
    hostname: 'localhost',
    port: 3005,
    path: '/api/whatsapp/chats/919820685562@c.us/send',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  }, { message: 'Hello from Live WhatsApp Web SaaS Panel!' });

  console.log('Send Message API Response:', sendRes);

  // Fetch chats again
  const chatsRes = await makeRequest({
    hostname: 'localhost',
    port: 3005,
    path: '/api/whatsapp/chats',
    method: 'GET',
    headers: { 'Authorization': `Bearer ${token}` }
  });

  console.log('Updated Chats API Response:', chatsRes);
  process.exit(0);
}

testSendMessage().catch(e => { console.error(e); process.exit(1); });
