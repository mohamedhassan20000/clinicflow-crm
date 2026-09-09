-- Remove `authenticated` EXECUTE from the patient-intake staging function.
--
-- ================================ WHY =====================================
--
-- `20260918120000_bilingual_patient_names_and_package_service.sql` recreated
-- `stage_patient_intake_from_conversation` and stated its intent in a comment:
--
--   "Exactly the grants the dropped function carried: service_role only. The
--    assistant reaches this through the admin client and no signed-in user may
--    call it directly."
--
-- The deployed ACL does not match that sentence. Post-apply verification found
-- Production carrying:
--
--   {postgres=X/postgres, authenticated=X/postgres, service_role=X/postgres}
--
-- ## Why the revoke did not do what it read like
--
-- The migration wrote `revoke all on function ... from public`. `public` there
-- is the PUBLIC pseudo-role — the implicit grant every function is born with —
-- and revoking it does nothing to a *role-specific* grant. Supabase ships a
-- default ACL (`pg_default_acl`, grantor `postgres`, schema `public`) that
-- grants EXECUTE to `authenticated` and `service_role` on every function
-- created in this schema. So the function was created already carrying an
-- explicit `authenticated=X`, and the `from public` revoke could not reach it.
--
-- This is not a regression introduced by 20260918120000. Every earlier
-- migration that defined this function (20260822120000, 20260822190000,
-- 20260823140000, 20260824120000) used the identical `from public` pattern, so
-- the dropped function carried the same grant. The exposure is as old as the
-- function; only the audit is new.
--
-- ## What this is worth — stated precisely
--
-- This is defence in depth, not a live hole. The function is SECURITY DEFINER
-- and takes `p_clinic_id` as a parameter, but its first statement is a guard:
--
--     if coalesce(auth.role(), '') <> 'service_role' then
--       raise exception 'PATIENT_AI_SERVICE_ROLE_REQUIRED' using errcode = '42501';
--     end if;
--
-- `auth.role()` reads the `request.jwt.claims` GUC that PostgREST sets from the
-- verified JWT. A signed-in user's token carries `role: authenticated`, so a
-- direct PostgREST call from such a user was refused by that guard even while
-- the EXECUTE grant let them reach it. No clinic boundary was crossable this
-- way, and nothing in Production needs remediating beyond this grant.
--
-- What the grant did cost is the outer half of a two-layer defence. The guard
-- is a *body* check on a claim; the ACL is a *catalog* check on a role, and it
-- runs first. Removing the grant means a caller who is not `service_role` is
-- stopped by the database before a single line of a SECURITY DEFINER body
-- executes, rather than by one `if` inside it. That ordering is the whole
-- value: it is what the migration's own comment claimed was true, and it is
-- what makes the guard a second opinion instead of the only one.
--
-- ## Why explicit role-specific revokes
--
-- Naming `anon` and `authenticated` is the whole point of this file. A revoke
-- `from public` is not a revoke from a role, and relying on it is exactly the
-- mistake being corrected. `anon` is named too even though it holds no grant
-- today: `pg_default_acl` is a live setting, not a fact, and a future change to
-- it must not be able to quietly hand this function to a role. Naming a role
-- that holds nothing is a no-op, so the statement is safe either way.
--
-- ========================== WHAT THIS IS NOT ===============================
--
--   * **Not a body change.** `prosrc` is untouched. This file contains no
--     `create or replace function`.
--   * **Not an RLS change.** No policy, no table ACL, no `enable row level
--     security` anywhere in this file.
--   * **Not a data change.** No insert, update, delete or backfill.
--   * **Not a sweep.** The audit that produced this file checked every
--     function in the 20260918 area against its own documented intent.
--     `approve_ai_patient_intake`, `stage_matched_third_party_intake`,
--     `set_package_template_items`, `ai_conversation_booking_beneficiary_matches`
--     and `enforce_ai_pending_booking_policy` all match what their migrations
--     say, and are deliberately left alone. So is
--     `ai_intake_approval_context_matches`, whose `anon` grant is explicit and
--     documented in 20260822190000.
--
-- ---------------------------------------------------------------------------

revoke execute on function public.stage_patient_intake_from_conversation(
  uuid, uuid, text, text, date, text, uuid, uuid,
  boolean, text, text, text, text, text
) from public, anon, authenticated;

-- Restated so the intended end state is a statement in this file and not an
-- inference from what the revoke above left behind.
grant execute on function public.stage_patient_intake_from_conversation(
  uuid, uuid, text, text, date, text, uuid, uuid,
  boolean, text, text, text, text, text
) to service_role;
