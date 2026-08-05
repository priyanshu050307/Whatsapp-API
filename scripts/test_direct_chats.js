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

async function testChats() {
  console.log('Testing GET /api/whatsapp/chats API endpoint...');
  
  // Login as rkv.busy@gmail.com
  const loginRes = await makeRequest({
    hostname: 'localhost',
    port: 3005,
    path: '/api/auth/google',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { email: 'rkv.busy@gmail.com' });

  const token = loginRes.data.token;
  console.log('Logged in token received for:', loginRes.data.tenant.email);

  // Fetch chats
  const chatRes = await makeRequest({
    hostname: 'localhost',
    port: 3005,
    path: '/api/whatsapp/chats',
    method: 'GET',
    headers: { 'Authorization': `Bearer ${token}` }
  });

  console.log('Chat API Response:', chatRes);
  process.exit(0);
}

testChats().catch(e => { console.error(e); process.exit(1); });
