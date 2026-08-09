-- P7-9 — Documents Settings write path.
--
-- P7-0 created public.document_settings with a clinic-scoped SELECT policy and
-- deliberately deferred the write path ("settings writes arrive in P7-9"). This
-- migration adds exactly that write path and nothing else. It follows the P4.9A
-- assistant-launcher precedent verbatim: the supported write path is the
-- authenticated primary clinic admin's own session, so RLS authorization and
-- auth.uid() audit attribution execute together, and the clinic-scoped service
-- client stays read-only for settings resolution. Numbering counters remain
-- untouched (allocation is SECURITY DEFINER-only), and issued documents stay
-- immutable — settings affect only future issuance.

-- Only the primary clinic admin may write settings; every write is attributed to
-- the acting admin. SELECT continues to flow through the existing clinic-wide
-- policy for the resolvers, so this policy governs INSERT/UPDATE/DELETE.
grant insert, update, delete on table public.document_settings to authenticated;

drop policy if exists "document_settings_manage_primary_admin" on public.document_settings;
create policy "document_settings_manage_primary_admin"
  on public.document_settings
  for all
  to authenticated
  using (
    public.is_primary_clinic_admin(document_settings.clinic_id, auth.uid())
  )
  with check (
    public.is_primary_clinic_admin(document_settings.clinic_id, auth.uid())
    and document_settings.updated_by = auth.uid()
  );

comment on policy "document_settings_manage_primary_admin" on public.document_settings is
  'P7-9: the primary clinic admin manages per-type and global document defaults through their own authenticated session; writes are self-attributed via updated_by.';
