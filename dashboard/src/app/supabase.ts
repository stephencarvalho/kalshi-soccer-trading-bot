import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getDashboardRuntimeConfig } from './runtime-config';

let client: SupabaseClient | null = null;

export function isSupabaseBrowserAuthConfigured(): boolean {
  const runtime = getDashboardRuntimeConfig();
  return Boolean(runtime.supabaseUrl && runtime.supabasePublishableKey);
}

export function getSupabaseBrowserClient(): SupabaseClient | null {
  if (client) return client;
  if (!isSupabaseBrowserAuthConfigured()) return null;

  const runtime = getDashboardRuntimeConfig();
  client = createClient(runtime.supabaseUrl, runtime.supabasePublishableKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });

  return client;
}
