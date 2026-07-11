-- P1C follow-up: orphan-resume hardening for clinic-owner signup.
--
-- The resume path needs to know whether the orphaned Auth user ever confirmed
-- its email: an unconfirmed orphan cannot pass signInWithPassword, so the
-- action verifies control differently (password check via GoTrue's
-- email_not_confirmed ordering, or an email-bound invitation token). Returning
-- the confirmation state lets the action refuse password overwrites on
-- confirmed accounts.

drop function public.find_resumable_clinic_owner(text);

create function public.find_resumable_clinic_owner(p_email text)
returns table (user_id uuid, email_confirmed boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select auth_user.id, auth_user.email_confirmed_at is not null
  from auth.users as auth_user
  left join public.profiles as profile on profile.id = auth_user.id
  where lower(btrim(auth_user.email)) = lower(btrim(p_email))
    and profile.id is null
    and auth_user.raw_user_meta_data ->> 'signup_flow' = 'clinic_owner'
  limit 1;
$$;

revoke all on function public.find_resumable_clinic_owner(text) from public;
revoke all on function public.find_resumable_clinic_owner(text) from anon, authenticated;
grant execute on function public.find_resumable_clinic_owner(text) to service_role;
