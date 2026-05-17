alter table public.patient_packages enable row level security;

create policy "clinic_members_read_packages"
  on public.patient_packages
  for select
  to authenticated
  using (clinic_id = public.auth_clinic_id());

create policy "admin_receptionist_insert_packages"
  on public.patient_packages
  for insert
  to authenticated
  with check (
    clinic_id = public.auth_clinic_id()
    and public.auth_role() = any (
      array['admin'::public.user_role, 'receptionist'::public.user_role]
    )
  );

create policy "admin_receptionist_update_packages"
  on public.patient_packages
  for update
  to authenticated
  using (
    clinic_id = public.auth_clinic_id()
    and public.auth_role() = any (
      array['admin'::public.user_role, 'receptionist'::public.user_role]
    )
  )
  with check (clinic_id = public.auth_clinic_id());

create policy "admin_delete_packages"
  on public.patient_packages
  for delete
  to authenticated
  using (
    clinic_id = public.auth_clinic_id()
    and public.auth_role() = 'admin'::public.user_role
  );

grant all on table public.patient_packages to authenticated;
grant all on table public.patient_packages to service_role;
revoke all on table public.patient_packages from anon;
