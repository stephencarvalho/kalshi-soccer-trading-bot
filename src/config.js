const path = require("path");
const { normalizeRecoveryConditions } = require("./recoveryConditions");

function parseList(value, fallback) {
	if (!value) return fallback;
	return value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

function parseNumber(value, fallback) {
	if (value === undefined || value === null || value === "") return fallback;
	const n = Number(value);
	return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
	return Math.min(max, Math.max(min, n));
}

const ABSOLUTE_STAKE_CAP_USD = 20;
const ABSOLUTE_RECOVERY_MAX_STAKE_CAP_USD = 100;

const defaultCompetitions = [
	"Swiss Super League",
	"Africa Cup of Nations",
	"Intl Friendlies",
	"EFL Championship",
	"Champions League Womens",
	"Liga Portugal",
	"Saudi Pro League",
	"France Super Cup",
	"FA Cup",
	"Venezuela Liga FUTVE",
	"Uruguay Primera Division",
	"Belgian Pro League",
	"Pro League",
	"LaLiga",
	"Ligue 1",
	"Europa League",
	"Japan J1 League",
	"Copa del Rey",
	"Chinese Super League",
	"Finalissima",
	"Liga MX",
	"La Liga",
	"UCL",
	"Ecuador LigaPro",
	"FIFA World Cup Qualification, UEFA",
	"Bundesliga",
	"Conference League",
	"Egyptian Premier League",
	"Argentina Primera Division",
	"Taca de Portugal",
	"Thai League 1",
	"USL Championship",
	"CONCACAF Champions Cup",
	"La Liga 2",
	"Championship",
	"Club World Cup",
	"Champions League",
	"FIFA World Cup Qualifiers",
	"Croatia HNL",
	"KNVB",
	"Major",
	"Korea K League 1",
	"Coupe de France",
	"MLS",
	"Ekstraklasa",
	"Danish Superliga",
	"Bundesliga 2",
	"Peru Liga 1",
	"APF Division de Honor",
	"Brasileiro Serie A",
	"Greece Super League",
	"Serie A",
	"Spain Super Cup",
	"Super Lig",
	"Scottish Premiership",
	"Coppa Italia",
	"Serie B",
	"Colombian Liga DIMAYOR",
	"NWSL",
	"FIFA World Cup",
	"EFL Cup",
	"Eredivisie",
	"Australia A League",
	"AFC Champions League",
	"English Womens Super League",
	"Chile Liga de Primera",
	"EPL",
	"DFB Pokal",
];

const defaultIgnoredSettlementTickers = [
	"KXRECNCBILL-25-JUL05",
	"KXRECNCBILL-25",
];

const config = {
	baseUrl:
		process.env.KALSHI_API_BASE_URL ||
		"https://api.elections.kalshi.com/trade-api/v2",
	keyId: process.env.KALSHI_API_KEY_ID || "",
	privateKeyPath: process.env.KALSHI_PRIVATE_KEY_PATH || "",
	privateKeyPem: process.env.KALSHI_PRIVATE_KEY_PEM || "",
	dryRun: String(process.env.DRY_RUN || "false").toLowerCase() === "true",
	pollSeconds: parseNumber(process.env.POLL_SECONDS, 10),
	retryUntilMinute: parseNumber(process.env.RETRY_UNTIL_MINUTE, 80),
	minTriggerMinute: parseNumber(process.env.MIN_TRIGGER_MINUTE, 70),
	minGoalLead: parseNumber(process.env.MIN_GOAL_LEAD, 2),
	anytimeLargeLeadMinGoalLead: parseNumber(
		process.env.ANYTIME_LARGE_LEAD_MIN_GOAL_LEAD,
		3,
	),
	anytimeLargeLeadMaxYesPrice: parseNumber(
		process.env.ANYTIME_LARGE_LEAD_MAX_YES_PRICE,
		0.9,
	),
	stakeUsd: parseNumber(process.env.STAKE_USD, 1),
	post80StartMinute: parseNumber(process.env.POST80_START_MINUTE, 80),
	post80MinGoalLead: parseNumber(process.env.POST80_MIN_GOAL_LEAD, 1),
	post80MaxYesPrice: parseNumber(process.env.POST80_MAX_YES_PRICE, 0.9),
	minVolume24hContracts: parseNumber(process.env.MIN_VOLUME_24H_CONTRACTS, 50),
	minLiquidityDollars: parseNumber(process.env.MIN_LIQUIDITY_DOLLARS, 250),
	maxOpenPositions: parseNumber(process.env.MAX_OPEN_POSITIONS, 20),
	maxDailyLossUsd: parseNumber(process.env.MAX_DAILY_LOSS_USD, 50),
	recoveryModeEnabled:
		String(process.env.RECOVERY_MODE_ENABLED || "false").toLowerCase() ===
		"true",
		recoveryStakeUsd: parseNumber(process.env.RECOVERY_STAKE_USD, 2),
		recoveryMaxStakeUsd: parseNumber(process.env.RECOVERY_MAX_STAKE_USD, 20),
		recoveryConditions: normalizeRecoveryConditions(process.env.RECOVERY_CONDITIONS),
	estimatedWinProbability: parseNumber(
		process.env.ESTIMATED_WIN_PROBABILITY,
		0.92,
	),
	feeBuffer: parseNumber(process.env.FEE_BUFFER, 0.02),
	explicitMaxYesPrice: parseNumber(process.env.MAX_YES_PRICE, null),
	leagues: parseList(process.env.LEAGUES, defaultCompetitions),
	ignoredSettlementTickers: parseList(
		process.env.IGNORE_SETTLEMENT_TICKERS,
		defaultIgnoredSettlementTickers,
	),
	timezone: process.env.TIMEZONE || "America/New_York",
	stateFile: process.env.STATE_FILE || path.resolve("data/state.json"),
	logLevel: process.env.LOG_LEVEL || "info",
	twilioAccountSid: process.env.TWILIO_ACCOUNT_SID || "",
	twilioAuthToken: process.env.TWILIO_AUTH_TOKEN || "",
	twilioFromWhatsApp: process.env.TWILIO_WHATSAPP_FROM || "",
	twilioToWhatsApp: process.env.TWILIO_WHATSAPP_TO || "",
	monitorApiToken: process.env.MONITOR_API_TOKEN || "",
	kalshiWebUserId: process.env.KALSHI_WEB_USER_ID || "",
	kalshiWebSessionCookie: process.env.KALSHI_WEB_SESSION_COOKIE || "",
	kalshiWebCsrfToken: process.env.KALSHI_WEB_CSRF_TOKEN || "",
	kalshiWebAuthStatePath:
		process.env.KALSHI_WEB_AUTH_STATE_PATH ||
		path.resolve(".kalshi-soccer-bot/kalshi-web-auth.json"),
	investedStartDate: process.env.INVESTED_START_DATE || "2026-03-01T00:00:00Z",
};

config.maxYesPrice =
	config.explicitMaxYesPrice ??
	Math.max(
		0.01,
		Math.min(0.99, config.estimatedWinProbability - config.feeBuffer),
	);

function validateConfig(cfg) {
	const out = { ...cfg };
	out.pollSeconds = Math.max(1, Number(out.pollSeconds) || 10);
	out.stakeUsd = clamp(Number(out.stakeUsd) || 1, 0.1, ABSOLUTE_STAKE_CAP_USD);
	out.maxDailyLossUsd = Math.max(1, Number(out.maxDailyLossUsd) || 50);
	out.recoveryModeEnabled = Boolean(out.recoveryModeEnabled);
	out.recoveryStakeUsd = clamp(
		Number(out.recoveryStakeUsd) || 2,
		out.stakeUsd,
		ABSOLUTE_STAKE_CAP_USD,
	);
	out.recoveryMaxStakeUsd = clamp(
			Number(out.recoveryMaxStakeUsd) || 20,
			out.recoveryStakeUsd,
			ABSOLUTE_RECOVERY_MAX_STAKE_CAP_USD,
		);
	out.recoveryConditions = normalizeRecoveryConditions(out.recoveryConditions);
	out.maxOpenPositions = Math.max(
		1,
		Math.floor(Number(out.maxOpenPositions) || 20),
	);
	out.minTriggerMinute = clamp(Number(out.minTriggerMinute) || 70, 1, 130);
	out.retryUntilMinute = clamp(
		Number(out.retryUntilMinute) || 80,
		out.minTriggerMinute,
		130,
	);
	out.post80StartMinute = clamp(
		Number(out.post80StartMinute) || 80,
		out.minTriggerMinute,
		130,
	);
	out.minGoalLead = Math.max(1, Math.floor(Number(out.minGoalLead) || 2));
	out.anytimeLargeLeadMinGoalLead = Math.max(
		2,
		Math.floor(Number(out.anytimeLargeLeadMinGoalLead) || 3),
	);
	out.post80MinGoalLead = Math.max(
		1,
		Math.floor(Number(out.post80MinGoalLead) || 1),
	);
	out.maxYesPrice = clamp(Number(out.maxYesPrice) || 0.9, 0.01, 0.99);
	out.anytimeLargeLeadMaxYesPrice = clamp(
		Number(out.anytimeLargeLeadMaxYesPrice) || out.maxYesPrice,
		0.01,
		0.99,
	);
	out.post80MaxYesPrice = clamp(
		Number(out.post80MaxYesPrice) || out.maxYesPrice,
		0.01,
		0.99,
	);
	out.ignoredSettlementTickers = Array.from(
		new Set(
			(out.ignoredSettlementTickers || [])
				.map((x) => String(x || "").trim())
				.filter(Boolean),
		),
	);
	out.allLeagues = (out.leagues || []).some((x) =>
		["all", "*"].includes(String(x).trim().toLowerCase()),
	);
	return out;
}

module.exports = { config: validateConfig(config), validateConfig };
