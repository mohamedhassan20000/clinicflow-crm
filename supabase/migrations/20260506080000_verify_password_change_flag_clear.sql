-- Ensure the forced password-change flag clear cannot silently no-op.

create or replace function public.clear_own_must_change_password()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated_count integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  perform set_config('app.allow_profile_password_flag_clear', 'on', true);

  update public.profiles
  set
    must_change_password = false,
    updated_at = now()
  where id = auth.uid()
    and is_active = true
    and is_deleted = false
    and deleted_at is null
    and must_change_password = true;

  get diagnostics v_updated_count = row_count;

  if v_updated_count = 0 then
    raise exception 'Password change requirement was not cleared for the authenticated user'
      using errcode = 'P0001';
  end if;
end;
$$;
revoke all on function public.clear_own_must_change_password() from public;
grant execute on function public.clear_own_must_change_password() to authenticated;
