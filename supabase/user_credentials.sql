create extension if not exists pgcrypto;

create table if not exists public.user_credentials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kalshi_api_key_id text not null,
  pem_file_name text,
  pem_ciphertext text not null,
  pem_iv text not null,
  pem_auth_tag text not null,
  pem_key_version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id)
);

alter table public.user_credentials
add column if not exists pem_file_name text;

create index if not exists user_credentials_user_id_idx on public.user_credentials(user_id);

alter table public.user_credentials enable row level security;

drop policy if exists "users can view their own credentials" on public.user_credentials;
create policy "users can view their own credentials"
on public.user_credentials
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "users can insert their own credentials" on public.user_credentials;
create policy "users can insert their own credentials"
on public.user_credentials
for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists "users can update their own credentials" on public.user_credentials;
create policy "users can update their own credentials"
on public.user_credentials
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "users can delete their own credentials" on public.user_credentials;
create policy "users can delete their own credentials"
on public.user_credentials
for delete
to authenticated
using (auth.uid() = user_id);
