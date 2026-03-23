const { createClient } = require('@supabase/supabase-js');

let client = null;

function getSupabaseConfig() {
  return {
    url: String(process.env.SUPABASE_URL || '').trim(),
    publishableKey: String(process.env.SUPABASE_PUBLISHABLE_KEY || '').trim(),
    secretKey: String(process.env.SUPABASE_SECRET_KEY || '').trim(),
  };
}

function isSupabaseAuthConfigured() {
  const { url, publishableKey, secretKey } = getSupabaseConfig();
  return Boolean(url && publishableKey && secretKey);
}

function getSupabaseServerClient() {
  if (!isSupabaseAuthConfigured()) return null;
  if (client) return client;

  const { url, secretKey } = getSupabaseConfig();
  client = createClient(url, secretKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });

  return client;
}

async function getSupabaseUserForAccessToken(accessToken) {
  const token = String(accessToken || '').trim();
  if (!token) return null;

  const supabase = getSupabaseServerClient();
  if (!supabase) return null;

  const { data, error } = await supabase.auth.getUser(token);
  if (error) throw error;
  return data?.user || null;
}

module.exports = {
  getSupabaseConfig,
  getSupabaseServerClient,
  getSupabaseUserForAccessToken,
  isSupabaseAuthConfigured,
};
