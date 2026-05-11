-- Reliable last-login tracking for the currently authenticated user.
-- The RPC intentionally accepts no user id and only updates auth.uid().

create or replace function public.record_own_last_login()
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid := auth.uid();
begin
  if v_actor_id is null then
    raise exception 'Not authenticated'
      using errcode = '28000';
  end if;

  update public.profiles
  set last_login_at = now()
  where id = v_actor_id
    and is_active = true
    and is_deleted = false
    and deleted_at is null;

  return found;
end;
$$;

revoke all on function public.record_own_last_login()
from public;

grant execute on function public.record_own_last_login()
to authenticated, service_role;
