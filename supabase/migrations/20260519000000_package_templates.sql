create table if not exists public.package_templates (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  department_id uuid not null references public.departments(id) on delete restrict,
  name text not null check (char_length(name) between 1 and 120),
  total_sessions integer not null check (total_sessions > 0 and total_sessions <= 10000),
  price_per_session numeric(12,2) check (price_per_session is null or price_per_session >= 0),
  total_price numeric(12,2) check (total_price is null or total_price >= 0),
  notes text check (notes is null or char_length(notes) <= 500),
  is_active boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_package_templates_clinic_dept_active
  on public.package_templates (clinic_id, department_id)
  where is_active;

create index if not exists idx_package_templates_clinic
  on public.package_templates (clinic_id);

drop trigger if exists trg_package_templates_updated_at on public.package_templates;
create trigger trg_package_templates_updated_at
before update on public.package_templates
for each row
execute function public.set_updated_at();

drop trigger if exists trg_audit_package_templates on public.package_templates;
create trigger trg_audit_package_templates
after insert or delete or update on public.package_templates
for each row
execute function public.write_audit_log();
