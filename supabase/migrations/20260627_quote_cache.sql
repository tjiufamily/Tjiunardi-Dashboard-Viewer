-- Shared delayed quote cache (Yahoo). Written by Hermes yahoo_quote_refresh.py (service role).
-- Read by Dashboard Viewer (authenticated users).

create table if not exists public.quote_cache (
  ticker text primary key,
  yahoo_symbol text,
  company_name text,
  price double precision not null check (price > 0),
  currency text,
  updated_at timestamptz not null default now()
);

create index if not exists quote_cache_updated_at_idx on public.quote_cache (updated_at desc);

alter table public.quote_cache enable row level security;

drop policy if exists quote_cache_select_authenticated on public.quote_cache;
create policy quote_cache_select_authenticated
  on public.quote_cache for select
  to authenticated
  using (true);

comment on table public.quote_cache is 'Delayed last prices from Yahoo Finance; refreshed by Hermes cron.';
