const path = require("path");

function sanitizeUserIdForPath(userId) {
  return String(userId || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "_");
}

function resolveUserStateFile(userId) {
  const normalizedUserId = sanitizeUserIdForPath(userId);
  if (!normalizedUserId) {
    return path.resolve(process.env.STATE_FILE || "data/state.json");
  }

  const baseDir = path.resolve(
    process.env.USER_STATE_BASE_DIR || "data/users",
  );
  return path.join(baseDir, normalizedUserId, "state.json");
}

function resolveUserActionLogPath(userId) {
  const normalizedUserId = sanitizeUserIdForPath(userId);
  if (!normalizedUserId) {
    return path.resolve("logs/trading-actions.ndjson");
  }

  const baseDir = path.resolve(
    process.env.USER_ACTION_LOG_BASE_DIR || "logs/users",
  );
  return path.join(baseDir, normalizedUserId, "trading-actions.ndjson");
}

module.exports = {
  resolveUserActionLogPath,
  resolveUserStateFile,
  sanitizeUserIdForPath,
};
