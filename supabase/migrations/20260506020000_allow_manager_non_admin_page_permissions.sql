-- Phase 5D follow-up: managers can manage non-admin page visibility.
-- This migration is intentionally not applied automatically.

drop policy if exists "Admins can manage clinic page permissions"
  on public.user_page_permissions;
drop policy if exists "Admins and managers can manage clinic page permissions"
  on public.user_page_permissions;
create policy "Admins and managers can manage clinic page permissions"
on public.user_page_permissions
for all
to authenticated
using (
  clinic_id = public.auth_clinic_id()
  and (
    public.auth_role() = 'admin'::public.user_role
    or (
      public.auth_role() = 'manager'::public.user_role
      and exists (
        select 1
        from public.profiles target
        where target.id = user_page_permissions.user_id
          and target.clinic_id = public.auth_clinic_id()
          and target.role <> 'admin'::public.user_role
      )
    )
  )
)
with check (
  clinic_id = public.auth_clinic_id()
  and (
    public.auth_role() = 'admin'::public.user_role
    or (
      public.auth_role() = 'manager'::public.user_role
      and exists (
        select 1
        from public.profiles target
        where target.id = user_page_permissions.user_id
          and target.clinic_id = public.auth_clinic_id()
          and target.role <> 'admin'::public.user_role
      )
    )
  )
);
