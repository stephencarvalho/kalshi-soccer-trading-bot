const crypto = require("crypto");

const {
  getSupabaseServerClient,
  isSupabaseAuthConfigured,
} = require("./supabaseAuth");

const DASHBOARD_SNAPSHOTS_TABLE = "dashboard_snapshots";

function isDashboardSnapshotStorageConfigured() {
  return Boolean(isSupabaseAuthConfigured());
}

function getDashboardSnapshotsTable() {
  const supabase = getSupabaseServerClient();
  if (!supabase) {
    throw new Error("Supabase auth is not configured for dashboard snapshots.");
  }

  return supabase.from(DASHBOARD_SNAPSHOTS_TABLE);
}

function buildDashboardSnapshotHash(payload) {
  const material = {
    ...(payload || {}),
    generatedAt: null,
  };

  return crypto
    .createHash("sha256")
    .update(JSON.stringify(material))
    .digest("hex");
}

async function getDashboardSnapshotRecordForUser(userId) {
  if (!isDashboardSnapshotStorageConfigured()) return null;

  const { data, error } = await getDashboardSnapshotsTable()
    .select("user_id, payload_hash")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function upsertDashboardSnapshotForUser({
  userId,
  payload,
  source = "monitor_api",
}) {
  const normalizedUserId = String(userId || "").trim();
  if (
    !normalizedUserId ||
    !payload ||
    !isDashboardSnapshotStorageConfigured()
  ) {
    return { skipped: true, reason: "snapshot_storage_unavailable" };
  }

  const payloadHash = buildDashboardSnapshotHash(payload);
  const existing = await getDashboardSnapshotRecordForUser(normalizedUserId);
  if (existing?.payload_hash === payloadHash) {
    return { skipped: true, reason: "snapshot_unchanged" };
  }

  const { error } = await getDashboardSnapshotsTable().upsert(
    {
      user_id: normalizedUserId,
      payload,
      payload_hash: payloadHash,
      generated_at: payload.generatedAt || new Date().toISOString(),
      source: String(source || "monitor_api"),
      updated_at: new Date().toISOString(),
    },
    {
      onConflict: "user_id",
    },
  );

  if (error) throw error;
  return { skipped: false, payloadHash };
}

module.exports = {
  DASHBOARD_SNAPSHOTS_TABLE,
  buildDashboardSnapshotHash,
  isDashboardSnapshotStorageConfigured,
  upsertDashboardSnapshotForUser,
};
