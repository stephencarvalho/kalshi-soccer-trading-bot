create table if not exists public.runtime_overrides (
  user_id uuid primary key references auth.users(id) on delete cascade,
  overrides jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default timezone('utc', now())
);

alter table public.runtime_overrides enable row level security;

drop policy if exists "runtime overrides are service-role only" on public.runtime_overrides;
create policy "runtime overrides are service-role only"
on public.runtime_overrides
for all
using (false)
with check (false);
