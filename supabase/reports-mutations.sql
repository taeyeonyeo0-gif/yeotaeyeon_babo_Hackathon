revoke update, delete on table public.reports from anon, authenticated;
revoke update (id, user_id, report_type, latitude, longitude, description, status, created_at) on table public.reports from anon, authenticated;
grant update (report_type, latitude, longitude, description) on table public.reports to authenticated;
grant delete on table public.reports to authenticated;

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
