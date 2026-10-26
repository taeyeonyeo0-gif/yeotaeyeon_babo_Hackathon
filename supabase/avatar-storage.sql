insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'avatars',
  'avatars',
  false,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']::text[]
)
on conflict (id) do update
set name = excluded.name,
    public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists avatars_select_own_folder on storage.objects;
create policy avatars_select_own_folder on storage.objects
  for select to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists avatars_insert_own_folder on storage.objects;
create policy avatars_insert_own_folder on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists avatars_update_own_folder on storage.objects;
create policy avatars_update_own_folder on storage.objects
  for update to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists avatars_delete_own_folder on storage.objects;
create policy avatars_delete_own_folder on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- These restrictive guards prevent broader existing policies from exposing avatars,
-- while leaving other buckets unchanged.
drop policy if exists avatars_select_private_guard on storage.objects;
create policy avatars_select_private_guard on storage.objects
  as restrictive for select to anon, authenticated
  using (
    bucket_id <> 'avatars'
    or (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text)
  );

drop policy if exists avatars_insert_private_guard on storage.objects;
create policy avatars_insert_private_guard on storage.objects
  as restrictive for insert to anon, authenticated
  with check (
    bucket_id <> 'avatars'
    or (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text)
  );

drop policy if exists avatars_update_private_guard on storage.objects;
create policy avatars_update_private_guard on storage.objects
  as restrictive for update to anon, authenticated
  using (
    bucket_id <> 'avatars'
    or (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text)
  )
  with check (
    bucket_id <> 'avatars'
    or (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text)
  );

drop policy if exists avatars_delete_private_guard on storage.objects;
create policy avatars_delete_private_guard on storage.objects
  as restrictive for delete to anon, authenticated
  using (
    bucket_id <> 'avatars'
    or (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text)
  );
