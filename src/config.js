const path = require('path');

function parseList(value, fallback) {
  if (!value) return fallback;
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseNumber(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

const defaultCompetitions = [
  'EPL',
  'FA Cup',
  'MLS',
  'Champions League',
  'Europa League',
  'Conference League',
  'Saudi Pro League',
  'Serie A',
  'Brasileiro Serie A',
  'Argentina Primera Division',
  'La Liga',
  'Bundesliga',
  'Copa del Rey',
];

const defaultIgnoredSettlementTickers = ['KXRECNCBILL-25-JUL05', 'KXRECNCBILL-25'];

const config = {
  baseUrl: process.env.KALSHI_API_BASE_URL || 'https://api.elections.kalshi.com/trade-api/v2',
  keyId: process.env.KALSHI_API_KEY_ID || '',
  privateKeyPath: process.env.KALSHI_PRIVATE_KEY_PATH || '',
  privateKeyPem: process.env.KALSHI_PRIVATE_KEY_PEM || '',
  dryRun: String(process.env.DRY_RUN || 'false').toLowerCase() === 'true',
  pollSeconds: parseNumber(process.env.POLL_SECONDS, 10),
  retryUntilMinute: parseNumber(process.env.RETRY_UNTIL_MINUTE, 80),
  minTriggerMinute: parseNumber(process.env.MIN_TRIGGER_MINUTE, 70),
  minGoalLead: parseNumber(process.env.MIN_GOAL_LEAD, 2),
  stakeUsd: parseNumber(process.env.STAKE_USD, 1),
  post80StartMinute: parseNumber(process.env.POST80_START_MINUTE, 80),
  post80MinGoalLead: parseNumber(process.env.POST80_MIN_GOAL_LEAD, 1),
  post80MaxYesPrice: parseNumber(process.env.POST80_MAX_YES_PRICE, 0.9),
  minVolume24hContracts: parseNumber(process.env.MIN_VOLUME_24H_CONTRACTS, 50),
  minLiquidityDollars: parseNumber(process.env.MIN_LIQUIDITY_DOLLARS, 250),
  maxOpenPositions: parseNumber(process.env.MAX_OPEN_POSITIONS, 20),
  maxDailyLossUsd: parseNumber(process.env.MAX_DAILY_LOSS_USD, 50),
  recoveryModeEnabled: String(process.env.RECOVERY_MODE_ENABLED || 'false').toLowerCase() === 'true',
  recoveryStakeUsd: parseNumber(process.env.RECOVERY_STAKE_USD, 2),
  recoveryMaxStakeUsd: parseNumber(process.env.RECOVERY_MAX_STAKE_USD, 16),
  estimatedWinProbability: parseNumber(process.env.ESTIMATED_WIN_PROBABILITY, 0.92),
  feeBuffer: parseNumber(process.env.FEE_BUFFER, 0.02),
  explicitMaxYesPrice: parseNumber(process.env.MAX_YES_PRICE, null),
  leagues: parseList(process.env.LEAGUES, defaultCompetitions),
  ignoredSettlementTickers: parseList(process.env.IGNORE_SETTLEMENT_TICKERS, defaultIgnoredSettlementTickers),
  timezone: process.env.TIMEZONE || 'America/New_York',
  stateFile: process.env.STATE_FILE || path.resolve('data/state.json'),
  logLevel: process.env.LOG_LEVEL || 'info',
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID || '',
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN || '',
  twilioFromWhatsApp: process.env.TWILIO_WHATSAPP_FROM || '',
  twilioToWhatsApp: process.env.TWILIO_WHATSAPP_TO || '',
};

config.maxYesPrice = config.explicitMaxYesPrice ?? Math.max(0.01, Math.min(0.99, config.estimatedWinProbability - config.feeBuffer));

function validateConfig(cfg) {
  const out = { ...cfg };
  out.pollSeconds = Math.max(1, Number(out.pollSeconds) || 10);
  out.stakeUsd = Math.max(0.1, Number(out.stakeUsd) || 1);
  out.maxDailyLossUsd = Math.max(1, Number(out.maxDailyLossUsd) || 50);
  out.recoveryModeEnabled = Boolean(out.recoveryModeEnabled);
  out.recoveryStakeUsd = Math.max(out.stakeUsd, Number(out.recoveryStakeUsd) || 2);
  out.recoveryMaxStakeUsd = Math.max(out.recoveryStakeUsd, Number(out.recoveryMaxStakeUsd) || 16);
  out.maxOpenPositions = Math.max(1, Math.floor(Number(out.maxOpenPositions) || 20));
  out.minTriggerMinute = clamp(Number(out.minTriggerMinute) || 70, 1, 130);
  out.retryUntilMinute = clamp(Number(out.retryUntilMinute) || 80, out.minTriggerMinute, 130);
  out.post80StartMinute = clamp(Number(out.post80StartMinute) || 80, out.minTriggerMinute, 130);
  out.minGoalLead = Math.max(1, Math.floor(Number(out.minGoalLead) || 2));
  out.post80MinGoalLead = Math.max(1, Math.floor(Number(out.post80MinGoalLead) || 1));
  out.maxYesPrice = clamp(Number(out.maxYesPrice) || 0.9, 0.01, 0.99);
  out.post80MaxYesPrice = clamp(Number(out.post80MaxYesPrice) || out.maxYesPrice, 0.01, 0.99);
  out.ignoredSettlementTickers = Array.from(
    new Set((out.ignoredSettlementTickers || []).map((x) => String(x || '').trim()).filter(Boolean)),
  );
  out.allLeagues = (out.leagues || []).some((x) => ['all', '*'].includes(String(x).trim().toLowerCase()));
  return out;
}

module.exports = { config: validateConfig(config), validateConfig };
