create table if not exists public.user_page_permissions (
  user_id uuid not null references public.profiles(id) on delete cascade,
  page_slug text not null,
  is_visible boolean not null default true,
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, page_slug)
);
create index if not exists user_page_permissions_clinic_id_idx
  on public.user_page_permissions (clinic_id);
create or replace function public.touch_user_page_permissions_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
drop trigger if exists touch_user_page_permissions_updated_at
  on public.user_page_permissions;
create trigger touch_user_page_permissions_updated_at
before update on public.user_page_permissions
for each row
execute function public.touch_user_page_permissions_updated_at();
alter table public.user_page_permissions enable row level security;
drop policy if exists "Users can read own page permissions"
  on public.user_page_permissions;
create policy "Users can read own page permissions"
  on public.user_page_permissions
  for select
  using (user_id = auth.uid());
drop policy if exists "Admins can manage clinic page permissions"
  on public.user_page_permissions;
create policy "Admins can manage clinic page permissions"
  on public.user_page_permissions
  for all
  using (
    exists (
      select 1
      from public.profiles p
      where p.id = auth.uid()
        and p.clinic_id = user_page_permissions.clinic_id
        and p.role = 'admin'
    )
  )
  with check (
    exists (
      select 1
      from public.profiles p
      where p.id = auth.uid()
        and p.clinic_id = user_page_permissions.clinic_id
        and p.role = 'admin'
    )
  );
