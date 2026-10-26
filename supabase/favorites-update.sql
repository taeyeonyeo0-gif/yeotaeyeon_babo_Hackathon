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

revoke update on table public.favorites from anon, authenticated;
revoke update (id, user_id, start_name, end_name, created_at) on table public.favorites from anon, authenticated;
grant update (start_name, end_name) on table public.favorites to authenticated;

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
