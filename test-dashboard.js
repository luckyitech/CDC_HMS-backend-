const http = require('http');

function request(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function test() {
  console.log('========================================');
  console.log('  TESTING DASHBOARD ENDPOINT');
  console.log('========================================\n');

  const users = [
    { email: 'admin@cdc.com', role: 'admin' },
    { email: 'ahmed.hassan@cdc.com', role: 'doctor' },
    { email: 'staff@cdc.com', role: 'staff' },
    { email: 'patient@cdc.com', role: 'patient' },
  ];

  for (const user of users) {
    console.log(`--- ${user.role.toUpperCase()} Dashboard ---`);

    // Login
    const login = await request({
      hostname: 'localhost', port: 3000, path: '/api/auth/login', method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, { email: user.email, password: 'password123', role: user.role });

    if (login.status !== 200) {
      console.log('Login failed for', user.email);
      console.log(login.data);
      continue;
    }

    const token = login.data.data.token;

    // Get dashboard
    const dashboard = await request({
      hostname: 'localhost', port: 3000, path: '/api/dashboard', method: 'GET',
      headers: { 'Authorization': 'Bearer ' + token }
    });

    if (dashboard.status === 200) {
      console.log('Status: 200 OK');
      console.log('Response:', JSON.stringify(dashboard.data.data, null, 2));
    } else {
      console.log('Status:', dashboard.status);
      console.log('Error:', dashboard.data);
    }
    console.log();
  }

  console.log('========================================');
  console.log('  TEST COMPLETE');
  console.log('========================================');
}

test().catch(console.error);
