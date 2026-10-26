create extension if not exists pgcrypto;
grant usage on schema public to authenticated;

create table if not exists public.favorites (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  start_name text not null check (char_length(btrim(start_name)) between 1 and 200),
  end_name text not null check (char_length(btrim(end_name)) between 1 and 200),
  created_at timestamptz not null default now()
);

do $$
begin
  if exists (
    select 1 from public.favorites
    group by user_id, start_name, end_name
    having count(*) > 1
  ) then
    raise exception 'Duplicate favorite routes exist; resolve them before adding the unique index. No rows were removed.';
  end if;
end
$$;
create unique index if not exists favorites_owner_route_unique
  on public.favorites(user_id, start_name, end_name);

alter table public.favorites enable row level security;
alter table public.favorites alter column user_id set default auth.uid();
revoke all privileges on table public.favorites from anon, authenticated;
grant select, delete on table public.favorites to authenticated;
grant insert (user_id, start_name, end_name) on table public.favorites to authenticated;
revoke update on table public.favorites from anon, authenticated;
revoke update (id, user_id, start_name, end_name, created_at) on table public.favorites from anon, authenticated;
grant update (start_name, end_name) on table public.favorites to authenticated;

drop policy if exists favorites_select_own on public.favorites;
create policy favorites_select_own on public.favorites
  for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists favorites_insert_own on public.favorites;
create policy favorites_insert_own on public.favorites
  for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists favorites_delete_own on public.favorites;
create policy favorites_delete_own on public.favorites
  for delete to authenticated
  using (auth.uid() = user_id);

drop policy if exists favorites_update_own on public.favorites;
create policy favorites_update_own on public.favorites
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists favorites_update_own_guard on public.favorites;
create policy favorites_update_own_guard on public.favorites
  as restrictive for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  report_type text not null check (report_type in ('streetlight', 'sidewalk', 'crossing', 'cctv', 'other')),
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  description text not null check (char_length(btrim(description)) between 5 and 1000),
  status text not null default 'pending' check (status in ('pending', 'reviewing', 'resolved', 'rejected')),
  created_at timestamptz not null default now()
);

alter table public.reports enable row level security;
alter table public.reports alter column user_id set default auth.uid();
revoke all privileges on table public.reports from anon, authenticated;
grant select on table public.reports to authenticated;
grant insert (user_id, report_type, latitude, longitude, description) on table public.reports to authenticated;
revoke update, delete on table public.reports from anon, authenticated;
revoke update (id, user_id, report_type, latitude, longitude, description, status, created_at) on table public.reports from anon, authenticated;
grant update (report_type, latitude, longitude, description) on table public.reports to authenticated;
grant delete on table public.reports to authenticated;

drop policy if exists reports_select_own on public.reports;
create policy reports_select_own on public.reports
  for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists reports_insert_pending_own on public.reports;
create policy reports_insert_pending_own on public.reports
  for insert to authenticated
  with check (auth.uid() = user_id and status = 'pending');

drop policy if exists reports_update_own on public.reports;
create policy reports_update_own on public.reports
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists reports_update_own_guard on public.reports;
create policy reports_update_own_guard on public.reports
  as restrictive for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists reports_delete_own on public.reports;
create policy reports_delete_own on public.reports
  for delete to authenticated
  using (auth.uid() = user_id);

drop policy if exists reports_delete_own_guard on public.reports;
create policy reports_delete_own_guard on public.reports
  as restrictive for delete to authenticated
  using (auth.uid() = user_id);
