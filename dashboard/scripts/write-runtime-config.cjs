const fs = require('fs');
const path = require('path');

try {
  const dotenv = require('dotenv');
  dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });
  dotenv.config({ path: path.resolve(__dirname, '..', '.env') });
} catch (error) {
  if (error && error.code !== 'MODULE_NOT_FOUND') {
    throw error;
  }
}

const outputPath = path.resolve(__dirname, '..', 'public', 'runtime-config.js');
const apiBaseUrl = String(process.env.DASHBOARD_API_BASE_URL || '').trim();
const apiToken = String(process.env.DASHBOARD_API_TOKEN || '').trim();
const supabaseUrl = String(process.env.SUPABASE_URL || '').trim();
const supabasePublishableKey = String(process.env.SUPABASE_PUBLISHABLE_KEY || '').trim();
const monitorPort = String(process.env.MONITOR_PORT || '8787').trim();

const payload = {
  apiBaseUrl,
  apiToken,
  supabaseUrl,
  supabasePublishableKey,
  monitorPort,
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(
  outputPath,
  `window.__DASHBOARD_RUNTIME__ = ${JSON.stringify(payload, null, 2)};\n`,
  'utf8',
);

console.log(`Wrote dashboard runtime config to ${outputPath}`);
