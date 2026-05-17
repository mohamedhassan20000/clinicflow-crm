alter table public.package_templates enable row level security;

create policy "clinic_members_read_package_templates"
  on public.package_templates
  for select
  to authenticated
  using (clinic_id = public.auth_clinic_id());

create policy "admin_insert_package_templates"
  on public.package_templates
  for insert
  to authenticated
  with check (
    clinic_id = public.auth_clinic_id()
    and public.auth_role() = 'admin'::public.user_role
  );

create policy "admin_update_package_templates"
  on public.package_templates
  for update
  to authenticated
  using (
    clinic_id = public.auth_clinic_id()
    and public.auth_role() = 'admin'::public.user_role
  )
  with check (
    clinic_id = public.auth_clinic_id()
    and public.auth_role() = 'admin'::public.user_role
  );

create policy "admin_delete_package_templates"
  on public.package_templates
  for delete
  to authenticated
  using (
    clinic_id = public.auth_clinic_id()
    and public.auth_role() = 'admin'::public.user_role
  );

grant all on table public.package_templates to authenticated;
grant all on table public.package_templates to service_role;
revoke all on table public.package_templates from anon;
