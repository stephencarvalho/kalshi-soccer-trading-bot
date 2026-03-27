const fs = require("fs");
const path = require("path");
const { validateConfig } = require("./config");
const {
  getSupabaseServerClient,
  isSupabaseAuthConfigured,
} = require("./supabaseAuth");
const { sanitizeUserIdForPath } = require("./userStoragePaths");

const OVERRIDES_PATH = path.resolve(
  process.env.RUNTIME_OVERRIDES_FILE || "data/runtime-overrides.json",
);
const RUNTIME_OVERRIDES_TABLE = "runtime_overrides";

const ALLOWED_KEYS = new Set([
  "tradingEnabled",
  "dryRun",
  "stakeUsd",
  "maxYesPrice",
  "minVolume24hContracts",
  "minLiquidityDollars",
  "minTriggerMinute",
  "minGoalLead",
  "anytimeLargeLeadMinGoalLead",
  "anytimeLargeLeadMaxYesPrice",
  "retryUntilMinute",
  "maxOpenPositions",
  "maxDailyLossUsd",
  "ignoreDailyLossLimit",
  "recoveryModeEnabled",
  "recoveryStakeUsd",
  "recoveryMaxStakeUsd",
  "recoveryConditions",
  "post80StartMinute",
  "post80MinGoalLead",
  "post80MaxYesPrice",
  "leagues",
]);

function getRuntimeOverridesBackend() {
  const explicitBackend = String(process.env.RUNTIME_OVERRIDES_BACKEND || "")
    .trim()
    .toLowerCase();
  if (explicitBackend === "file" || explicitBackend === "supabase") {
    return explicitBackend;
  }

  if (
    (process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME) &&
    isSupabaseAuthConfigured()
  ) {
    return "supabase";
  }

  return "file";
}

function isSupabaseRuntimeOverridesEnabled() {
  return getRuntimeOverridesBackend() === "supabase";
}

function getRuntimeOverridesTable() {
  const supabase = getSupabaseServerClient();
  if (!supabase) {
    throw new Error(
      "Supabase runtime overrides are not configured. Set SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, and SUPABASE_SECRET_KEY.",
    );
  }

  return supabase.from(RUNTIME_OVERRIDES_TABLE);
}

function resolveOverridesFilePath(userId = null) {
  const normalizedUserId = sanitizeUserIdForPath(userId);
  if (!normalizedUserId) return OVERRIDES_PATH;

  return path.join(
    path.dirname(OVERRIDES_PATH),
    "users",
    normalizedUserId,
    path.basename(OVERRIDES_PATH),
  );
}

function readOverridesFromFile(filePath = OVERRIDES_PATH) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

function readOverrides() {
  return readOverridesFromFile(OVERRIDES_PATH);
}

async function readOverridesAsync(userId = null) {
  if (!isSupabaseRuntimeOverridesEnabled()) {
    return readOverridesFromFile(resolveOverridesFilePath(userId));
  }

  const normalizedUserId = String(userId || "").trim();
  if (!normalizedUserId) return {};

  const { data, error } = await getRuntimeOverridesTable()
    .select("overrides")
    .eq("user_id", normalizedUserId)
    .maybeSingle();

  if (error) throw error;
  if (!data?.overrides || typeof data.overrides !== "object") return {};
  return data.overrides;
}

function writeOverridesToFile(next, filePath = OVERRIDES_PATH) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(next, null, 2));
}

function writeOverrides(next) {
  writeOverridesToFile(next, OVERRIDES_PATH);
}

async function writeOverridesAsync(next, userId = null) {
  if (!isSupabaseRuntimeOverridesEnabled()) {
    writeOverridesToFile(next, resolveOverridesFilePath(userId));
    return;
  }

  const normalizedUserId = String(userId || "").trim();
  if (!normalizedUserId) {
    throw new Error(
      "User-scoped runtime overrides require a Supabase user id.",
    );
  }

  const { error } = await getRuntimeOverridesTable().upsert(
    {
      user_id: normalizedUserId,
      overrides: next,
      updated_at: new Date().toISOString(),
    },
    {
      onConflict: "user_id",
    },
  );

  if (error) throw error;
}

function sanitizeValue(key, value) {
  if (key === "leagues" || key === "recoveryConditions") {
    if (Array.isArray(value)) {
      return value.map((x) => String(x).trim()).filter(Boolean);
    }
    return String(value)
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  }

  if (
    key === "tradingEnabled" ||
    key === "dryRun" ||
    key === "recoveryModeEnabled" ||
    key === "ignoreDailyLossLimit"
  ) {
    if (typeof value === "boolean") return value;
    return ["true", "1", "yes", "on"].includes(
      String(value).toLowerCase(),
    );
  }

  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid numeric value for ${key}`);
  }
  return n;
}

function resolveRuntimeConfig(baseConfig, rawOverrides = readOverrides()) {
  const safe = {};

  for (const [k, v] of Object.entries(rawOverrides || {})) {
    if (!ALLOWED_KEYS.has(k)) continue;
    safe[k] = v;
  }

  return validateConfig({
    ...baseConfig,
    ...safe,
    tradingEnabled:
      safe.tradingEnabled !== undefined ? Boolean(safe.tradingEnabled) : true,
    dryRun:
      safe.dryRun !== undefined
        ? Boolean(safe.dryRun)
        : Boolean(baseConfig.dryRun),
    ignoreDailyLossLimit:
      safe.ignoreDailyLossLimit !== undefined
        ? Boolean(safe.ignoreDailyLossLimit)
        : Boolean(baseConfig.ignoreDailyLossLimit),
  });
}

function getRuntimeConfig(baseConfig) {
  return resolveRuntimeConfig(baseConfig, readOverrides());
}

async function getRuntimeConfigAsync(baseConfig, userId = null) {
  return resolveRuntimeConfig(baseConfig, await readOverridesAsync(userId));
}

function setOverride(key, value) {
  if (!ALLOWED_KEYS.has(key)) {
    throw new Error(
      `Key not allowed. Allowed keys: ${Array.from(ALLOWED_KEYS).join(", ")}`,
    );
  }
  const all = readOverrides();
  all[key] = sanitizeValue(key, value);
  writeOverrides(all);
  return all;
}

async function setOverrideAsync(key, value, userId = null) {
  if (!ALLOWED_KEYS.has(key)) {
    throw new Error(
      `Key not allowed. Allowed keys: ${Array.from(ALLOWED_KEYS).join(", ")}`,
    );
  }
  const all = await readOverridesAsync(userId);
  all[key] = sanitizeValue(key, value);
  await writeOverridesAsync(all, userId);
  return all;
}

function setOverrides(patch) {
  const all = readOverrides();
  for (const [key, value] of Object.entries(patch || {})) {
    if (value === undefined) continue;
    if (!ALLOWED_KEYS.has(key)) {
      throw new Error(
        `Key not allowed. Allowed keys: ${Array.from(ALLOWED_KEYS).join(", ")}`,
      );
    }
    all[key] = sanitizeValue(key, value);
  }
  writeOverrides(all);
  return all;
}

async function setOverridesAsync(patch, userId = null) {
  const all = await readOverridesAsync(userId);
  for (const [key, value] of Object.entries(patch || {})) {
    if (value === undefined) continue;
    if (!ALLOWED_KEYS.has(key)) {
      throw new Error(
        `Key not allowed. Allowed keys: ${Array.from(ALLOWED_KEYS).join(", ")}`,
      );
    }
    all[key] = sanitizeValue(key, value);
  }
  await writeOverridesAsync(all, userId);
  return all;
}

function unsetOverride(key) {
  const all = readOverrides();
  delete all[key];
  writeOverrides(all);
  return all;
}

async function unsetOverrideAsync(key, userId = null) {
  const all = await readOverridesAsync(userId);
  delete all[key];
  await writeOverridesAsync(all, userId);
  return all;
}

module.exports = {
  OVERRIDES_PATH,
  ALLOWED_KEYS,
  RUNTIME_OVERRIDES_TABLE,
  getRuntimeOverridesBackend,
  resolveOverridesFilePath,
  resolveRuntimeConfig,
  getRuntimeConfig,
  getRuntimeConfigAsync,
  readOverrides,
  readOverridesAsync,
  setOverride,
  setOverrideAsync,
  setOverrides,
  setOverridesAsync,
  unsetOverride,
  unsetOverrideAsync,
};
