const fs = require('fs');
const path = require('path');

const OVERRIDES_PATH = path.resolve(process.env.RUNTIME_OVERRIDES_FILE || 'data/runtime-overrides.json');

const ALLOWED_KEYS = new Set([
  'tradingEnabled',
  'dryRun',
  'stakeUsd',
  'maxYesPrice',
  'minVolume24hContracts',
  'minLiquidityDollars',
  'minTriggerMinute',
  'minGoalLead',
  'anytimeLargeLeadMinGoalLead',
  'anytimeLargeLeadMaxYesPrice',
  'retryUntilMinute',
  'maxOpenPositions',
  'maxDailyLossUsd',
  'ignoreDailyLossLimit',
  'recoveryModeEnabled',
  'recoveryStakeUsd',
  'recoveryMaxStakeUsd',
  'post80StartMinute',
  'post80MinGoalLead',
  'post80MaxYesPrice',
  'leagues',
]);

function readOverrides() {
  try {
    return JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeOverrides(next) {
  fs.mkdirSync(path.dirname(OVERRIDES_PATH), { recursive: true });
  fs.writeFileSync(OVERRIDES_PATH, JSON.stringify(next, null, 2));
}

function sanitizeValue(key, value) {
  if (key === 'leagues') {
    if (Array.isArray(value)) return value.map((x) => String(x).trim()).filter(Boolean);
    return String(value)
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
  }

  if (key === 'tradingEnabled' || key === 'dryRun' || key === 'recoveryModeEnabled' || key === 'ignoreDailyLossLimit') {
    if (typeof value === 'boolean') return value;
    return ['true', '1', 'yes', 'on'].includes(String(value).toLowerCase());
  }

  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid numeric value for ${key}`);
  }
  return n;
}

function getRuntimeConfig(baseConfig) {
  const raw = readOverrides();
  const safe = {};

  for (const [k, v] of Object.entries(raw)) {
    if (!ALLOWED_KEYS.has(k)) continue;
    safe[k] = v;
  }

  return {
    ...baseConfig,
    ...safe,
    tradingEnabled: safe.tradingEnabled !== undefined ? Boolean(safe.tradingEnabled) : true,
  };
}

function setOverride(key, value) {
  if (!ALLOWED_KEYS.has(key)) {
    throw new Error(`Key not allowed. Allowed keys: ${Array.from(ALLOWED_KEYS).join(', ')}`);
  }
  const all = readOverrides();
  all[key] = sanitizeValue(key, value);
  writeOverrides(all);
  return all;
}

function unsetOverride(key) {
  const all = readOverrides();
  delete all[key];
  writeOverrides(all);
  return all;
}

module.exports = {
  OVERRIDES_PATH,
  ALLOWED_KEYS,
  getRuntimeConfig,
  readOverrides,
  setOverride,
  unsetOverride,
};
