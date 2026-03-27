const fs = require('fs');
const path = require('path');

const LOG_PATH = path.resolve('logs/trading-actions.ndjson');
const NOISY_ACTIONS = new Set(['cycle_started', 'cycle_evaluated']);
const MAX_NOISY_LOGS = 100;

function compactNoisyLogs(logPath) {
  const lines = fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const parsed = lines.map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return { raw: line, action: 'parse_error' };
    }
  });

  const noisyIndexes = [];
  for (let i = 0; i < parsed.length; i += 1) {
    if (NOISY_ACTIONS.has(parsed[i]?.action)) noisyIndexes.push(i);
  }

  if (noisyIndexes.length <= MAX_NOISY_LOGS) return;

  const keepNoisy = new Set(noisyIndexes.slice(-MAX_NOISY_LOGS));
  const keptLines = lines.filter((_, index) => !NOISY_ACTIONS.has(parsed[index]?.action) || keepNoisy.has(index));
  fs.writeFileSync(logPath, keptLines.join('\n') + '\n', 'utf8');
}

function createActionLog(logPath = LOG_PATH) {
  const resolvedPath = path.resolve(logPath);

  function appendAction(action, payload = {}) {
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    const entry = {
      ts: new Date().toISOString(),
      action,
      ...payload,
    };
    fs.appendFileSync(resolvedPath, JSON.stringify(entry) + '\n', 'utf8');
    if (NOISY_ACTIONS.has(action)) compactNoisyLogs(resolvedPath);
  }

  return {
    appendAction,
    logPath: resolvedPath,
  };
}

const defaultActionLog = createActionLog(LOG_PATH);

module.exports = {
  appendAction: defaultActionLog.appendAction,
  createActionLog,
  LOG_PATH,
};
