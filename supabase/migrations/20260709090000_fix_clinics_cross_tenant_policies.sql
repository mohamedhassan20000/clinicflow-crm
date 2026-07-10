-- P0 tenant hardening: clinic admins may only read their own clinic row.
-- Inserts are reserved for future onboarding RPCs rather than broad authenticated policies.

drop policy if exists "clinics_select_admin_all" on public.clinics;
drop policy if exists "clinics_insert_admin" on public.clinics;

drop policy if exists "clinics_select_own" on public.clinics;
create policy "clinics_select_own"
on public.clinics
for select
to authenticated
using (id = public.auth_clinic_id());
