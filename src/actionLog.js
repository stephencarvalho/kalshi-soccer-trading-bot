const fs = require('fs');
const path = require('path');

const LOG_PATH = path.resolve('logs/trading-actions.ndjson');

function appendAction(action, payload = {}) {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  const entry = {
    ts: new Date().toISOString(),
    action,
    ...payload,
  };
  fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n', 'utf8');
}

module.exports = { appendAction, LOG_PATH };
