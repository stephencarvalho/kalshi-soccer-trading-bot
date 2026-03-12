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

const defaultCompetitions = [
  'EPL',
  'FA Cup',
  'MLS',
  'Champions League',
  'Europa League',
  'Conference League',
  'Saudi Pro League',
  'Serie A',
  'La Liga',
  'Bundesliga',
  'Copa del Rey',
];

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
  estimatedWinProbability: parseNumber(process.env.ESTIMATED_WIN_PROBABILITY, 0.92),
  feeBuffer: parseNumber(process.env.FEE_BUFFER, 0.02),
  explicitMaxYesPrice: parseNumber(process.env.MAX_YES_PRICE, null),
  leagues: parseList(process.env.LEAGUES, defaultCompetitions),
  timezone: process.env.TIMEZONE || 'America/New_York',
  stateFile: process.env.STATE_FILE || path.resolve('data/state.json'),
  logLevel: process.env.LOG_LEVEL || 'info',
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID || '',
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN || '',
  twilioFromWhatsApp: process.env.TWILIO_WHATSAPP_FROM || '',
  twilioToWhatsApp: process.env.TWILIO_WHATSAPP_TO || '',
};

config.maxYesPrice = config.explicitMaxYesPrice ?? Math.max(0.01, Math.min(0.99, config.estimatedWinProbability - config.feeBuffer));

module.exports = { config };
