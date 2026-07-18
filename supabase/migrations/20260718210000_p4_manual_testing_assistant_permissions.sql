-- Phase 4 manual-testing fixes: Assistant visibility for every normal clinic
-- role, owner-scoped conversation persistence for those roles, and admin-only
-- page customization management.

-- The clinic admin is the sole role allowed to change page customization.
drop policy if exists "Admins can manage clinic page permissions"
  on public.user_page_permissions;
drop policy if exists "Admins and managers can manage clinic page permissions"
  on public.user_page_permissions;
create policy "Admins can manage clinic page permissions"
on public.user_page_permissions
for all
to authenticated
using (
  clinic_id = public.auth_clinic_id()
  and public.auth_role() = 'admin'::public.user_role
)
with check (
  clinic_id = public.auth_clinic_id()
  and public.auth_role() = 'admin'::public.user_role
);

-- Register Assistant explicitly for every existing normal clinic user. Existing
-- admin choices are preserved; only users without an Assistant row receive the
-- default visible value.
insert into public.user_page_permissions (
  user_id,
  page_slug,
  is_visible,
  clinic_id
)
select
  p.id,
  'assistant',
  true,
  p.clinic_id
from public.profiles p
where p.role = any (
  array[
    'admin'::public.user_role,
    'manager'::public.user_role,
    'doctor'::public.user_role,
    'receptionist'::public.user_role
  ]
)
and p.is_active = true
and p.is_deleted = false
and p.deleted_at is null
on conflict (user_id, page_slug) do nothing;

-- All normal roles own their own general Assistant conversations. Only doctors
-- may persist patient-scoped conversations; other personas remain explicitly
-- non-clinical even though they share the same compatibility enum value.
drop policy if exists "agent_owner_all_conversations"
  on public.agent_conversations;
create policy "agent_owner_all_conversations"
on public.agent_conversations
for all
to authenticated
using (
  clinic_id = public.auth_clinic_id()
  and user_id = auth.uid()
  and public.auth_role() = any (
    array[
      'admin'::public.user_role,
      'manager'::public.user_role,
      'doctor'::public.user_role,
      'receptionist'::public.user_role
    ]
  )
  and (
    patient_id is null
    or public.auth_role() = 'doctor'::public.user_role
  )
)
with check (
  clinic_id = public.auth_clinic_id()
  and user_id = auth.uid()
  and public.auth_role() = any (
    array[
      'admin'::public.user_role,
      'manager'::public.user_role,
      'doctor'::public.user_role,
      'receptionist'::public.user_role
    ]
  )
  and (
    patient_id is null
    or public.auth_role() = 'doctor'::public.user_role
  )
);
