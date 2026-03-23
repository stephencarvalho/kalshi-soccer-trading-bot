create extension if not exists pgcrypto;

create table if not exists public.dashboard_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  payload jsonb not null,
  payload_hash text not null,
  generated_at timestamptz not null default now(),
  source text not null default 'monitor_api',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id)
);

create index if not exists dashboard_snapshots_user_id_idx on public.dashboard_snapshots(user_id);
create index if not exists dashboard_snapshots_updated_at_idx on public.dashboard_snapshots(updated_at desc);

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'dashboard_snapshots'
  ) then
    alter publication supabase_realtime add table public.dashboard_snapshots;
  end if;
end
$$;

alter table public.dashboard_snapshots enable row level security;

drop policy if exists "users can view their own dashboard snapshot" on public.dashboard_snapshots;
create policy "users can view their own dashboard snapshot"
on public.dashboard_snapshots
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "users can insert their own dashboard snapshot" on public.dashboard_snapshots;
create policy "users can insert their own dashboard snapshot"
on public.dashboard_snapshots
for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists "users can update their own dashboard snapshot" on public.dashboard_snapshots;
create policy "users can update their own dashboard snapshot"
on public.dashboard_snapshots
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "users can delete their own dashboard snapshot" on public.dashboard_snapshots;
create policy "users can delete their own dashboard snapshot"
on public.dashboard_snapshots
for delete
to authenticated
using (auth.uid() = user_id);
