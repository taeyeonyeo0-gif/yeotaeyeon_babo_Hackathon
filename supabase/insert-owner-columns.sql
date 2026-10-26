-- The browser supplies user_id only from the verified Supabase Auth user.
-- Existing INSERT RLS policies must continue checking auth.uid() = user_id.
grant insert (user_id, start_name, end_name)
  on table public.favorites to authenticated;

grant insert (user_id, report_type, latitude, longitude, description)
  on table public.reports to authenticated;
