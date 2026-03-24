const axios = require('axios');
const fs = require('fs');
const readline = require('readline');
const path = require('path');

const API_BASE_URL = 'http://localhost:8787/api';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(query) {
  return new Promise(resolve => rl.question(query, resolve));
}

function logError(prefix, err) {
  console.error(`${prefix}`);
  if (err.response) {
    console.error(`  Status: ${err.response.status}`);
    console.error(`  Status Text: ${err.response.statusText}`);
    console.error(`  Data: ${JSON.stringify(err.response.data, null, 2)}`);
  } else if (err.request) {
    console.error(`  No response received from server. Is the monitor server running at ${API_BASE_URL}?`);
    console.error(`  Error Code: ${err.code}`);
    console.error(`  Error Message: ${err.message}`);
  } else {
    console.error(`  Error Message: ${err.message}`);
  }
}

async function runTests() {
  console.log('==========================================');
  console.log('   Kalshi Credentials Flow Debugger');
  console.log('==========================================');
  console.log(`Target API: ${API_BASE_URL}`);
  console.log('Step 1: Verify your monitor server is running (npm run monitor:api)');
  console.log('Step 2: Provide a valid Supabase Access Token (from the dashboard Network tab)');
  console.log('------------------------------------------\n');
  
  const token = await question('Enter your Supabase Access Token: ');
  if (!token) {
    console.error('CRITICAL: Supabase Access Token is required to authorize these requests.');
    process.exit(1);
  }

  const apiKeyId = await question('Enter Kalshi API Key ID (for valid scenarios): ');
  const pemPath = await question('Enter path to Kalshi PEM file (for valid scenarios): ');

  let pemContent = '';
  let pemFileName = '';
  if (pemPath) {
    try {
      const resolvedPath = path.resolve(pemPath);
      console.log(`Reading PEM from: ${resolvedPath}`);
      pemContent = fs.readFileSync(resolvedPath, 'utf8');
      pemFileName = path.basename(pemPath);
      console.log('PEM file read successfully.');
    } catch (err) {
      console.warn(`WARNING: Could not read PEM file: ${err.message}`);
    }
  }

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  };

  console.log('\n[TEST 1] Scenario: Missing API Key ID');
  console.log('Goal: Verify the server rejects requests when the API Key ID is empty.');
  console.log('Expected: 400 Bad Request with "Kalshi API key ID is required"');
  try {
    const res = await axios.post(`${API_BASE_URL}/credentials/check`, {
      checkMode: 'draft',
      kalshiApiKeyId: '',
      privateKeyPem: pemContent || 'placeholder'
    }, { headers });
    console.error('FAIL: Server accepted an empty API Key ID with status ' + res.status);
  } catch (err) {
    if (err.response?.status === 400) {
      console.log('PASS: Server correctly rejected the empty API Key ID (400).');
      console.log('Response Message:', err.response.data.message);
    } else {
      logError('FAIL: Unexpected result for Test 1', err);
    }
  }

  console.log('\n[TEST 2] Scenario: Invalid PEM Format');
  console.log('Goal: Verify the server validates the PEM structure before attempting to use it.');
  console.log('Expected: 400 Bad Request with "Uploaded file is not a valid PEM private key"');
  try {
    const res = await axios.post(`${API_BASE_URL}/credentials/check`, {
      checkMode: 'draft',
      kalshiApiKeyId: apiKeyId || '9f43f484-d640-4568-a19f-c71319579562',
      privateKeyPem: '--- NOT A REAL PEM ---'
    }, { headers });
    console.error('FAIL: Server accepted invalid PEM content with status ' + res.status);
  } catch (err) {
    if (err.response?.status === 400) {
      console.log('PASS: Server correctly rejected the invalid PEM format (400).');
      console.log('Response Message:', err.response.data.message);
    } else {
      logError('FAIL: Unexpected result for Test 2', err);
    }
  }

  if (apiKeyId && pemContent) {
    console.log('\n[TEST 3] Scenario: Valid Draft Check');
    console.log('Goal: Verify the credentials work against Kalshi without saving them yet.');
    console.log('Expected: 200 OK with healthy: true');
    try {
      const resp = await axios.post(`${API_BASE_URL}/credentials/check`, {
        checkMode: 'draft',
        kalshiApiKeyId: apiKeyId,
        privateKeyPem: pemContent
      }, { headers });
      console.log('PASS: Draft credential check succeeded.');
      console.log('Healthy:', resp.data.healthy);
      console.log('Message:', resp.data.message);
    } catch (err) {
      logError('FAIL: Draft credential check failed', err);
    }

    console.log('\n[TEST 4] Scenario: Save Credentials');
    console.log('Goal: Encrypt and store the credentials in the database for this user.');
    console.log('Expected: 200 OK with success message');
    try {
      const resp = await axios.post(`${API_BASE_URL}/credentials`, {
        kalshiApiKeyId: apiKeyId,
        privateKeyPem: pemContent,
        pemFileName: pemFileName || 'trading-bot-token.pem'
      }, { headers });
      console.log('PASS: Credentials saved successfully.');
      console.log('Response:', resp.data.message);
    } catch (err) {
      logError('FAIL: Save credentials failed', err);
    }

    console.log('\n[TEST 5] Scenario: Check Stored Credentials');
    console.log('Goal: Verify the server can retrieve and use the already-saved credentials.');
    console.log('Expected: 200 OK using stored data');
    try {
      const resp = await axios.post(`${API_BASE_URL}/credentials/check`, {
        checkMode: 'stored'
      }, { headers });
      console.log('PASS: Stored credential check succeeded.');
      console.log('Healthy:', resp.data.healthy);
      console.log('Message:', resp.data.message);
    } catch (err) {
      logError('FAIL: Stored credential check failed', err);
    }
  } else {
    console.log('\n!!! SKIPPING VALID SCENARIOS (3-5) !!!');
    console.log('Reason: You must provide a real API Key ID and a path to a valid PEM file to test successful flows.');
  }

  console.log('\n==========================================');
  console.log('             Debugging Finished');
  console.log('==========================================');
  rl.close();
}

runTests().catch(err => {
  console.error('\nFATAL UNHANDLED ERROR:');
  console.error(err);
  rl.close();
});
