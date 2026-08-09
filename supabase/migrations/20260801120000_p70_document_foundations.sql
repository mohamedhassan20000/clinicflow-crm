-- P7-0: Document Platform foundations.
--
-- This migration establishes the type-agnostic document identity/persistence
-- model, atomic per-clinic/per-type numbering, retry-safe issuance reservation,
-- append-only lifecycle events, private canonical-PDF storage, and the clinic
-- branding fields required by all approved document designs.

-- ── Clinic branding ──────────────────────────────────────────────────────────
alter table public.clinics
  add column if not exists email text,
  add column if not exists website text,
  add column if not exists license_no text,
  add column if not exists tax_id text,
  add column if not exists document_footer text,
  add column if not exists branding_metadata jsonb not null default '{}'::jsonb;

alter table public.clinics
  drop constraint if exists clinics_document_email_length,
  add constraint clinics_document_email_length check (
    email is null or length(btrim(email)) between 3 and 254
  ),
  drop constraint if exists clinics_website_length,
  add constraint clinics_website_length check (
    website is null or length(btrim(website)) between 1 and 500
  ),
  drop constraint if exists clinics_license_no_length,
  add constraint clinics_license_no_length check (
    license_no is null or length(btrim(license_no)) between 1 and 120
  ),
  drop constraint if exists clinics_tax_id_length,
  add constraint clinics_tax_id_length check (
    tax_id is null or length(btrim(tax_id)) between 1 and 120
  ),
  drop constraint if exists clinics_document_footer_length,
  add constraint clinics_document_footer_length check (
    document_footer is null or length(btrim(document_footer)) between 1 and 500
  ),
  drop constraint if exists clinics_branding_metadata_object,
  add constraint clinics_branding_metadata_object check (
    jsonb_typeof(branding_metadata) = 'object'
    and pg_column_size(branding_metadata) <= 16384
  );

comment on column public.clinics.email is
  'Clinic contact email rendered in document branding when present.';
comment on column public.clinics.website is
  'Clinic website rendered in document branding when present.';
comment on column public.clinics.license_no is
  'Clinic licence/registration identifier for issued documents.';
comment on column public.clinics.tax_id is
  'Clinic tax/VAT/TRN identity. Required before issuing a tax invoice where applicable.';
comment on column public.clinics.document_footer is
  'Optional clinic-owned document footer; falls back to the system attribution.';
comment on column public.clinics.branding_metadata is
  'Bounded extensible branding object for additive fields such as social links.';

-- The P0 own-clinic SELECT policy is already present (20260709090000), so the
-- new tax/licence fields inherit the same tenant boundary. Managers have an
-- UPDATE policy for older settings, therefore extend the existing trigger so a
-- forged direct request cannot change primary-admin-only branding identity.
create or replace function public.prevent_manager_clinic_privilege_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.auth_role() = 'manager'::public.user_role then
    if old.id <> public.auth_clinic_id()
      or new.id is distinct from old.id
      or new.is_active is distinct from old.is_active
      or new.reminder_lead_hours is distinct from old.reminder_lead_hours
      or new.working_hours_start is distinct from old.working_hours_start
      or new.working_hours_end is distinct from old.working_hours_end
      or new.created_at is distinct from old.created_at
      or new.email is distinct from old.email
      or new.website is distinct from old.website
      or new.license_no is distinct from old.license_no
      or new.tax_id is distinct from old.tax_id
      or new.document_footer is distinct from old.document_footer
      or new.branding_metadata is distinct from old.branding_metadata
    then
      raise exception 'Managers cannot update protected clinic fields'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;
alter function public.prevent_manager_clinic_privilege_update() owner to postgres;
revoke all on function public.prevent_manager_clinic_privilege_update() from public;

-- ── Type-agnostic persistence ────────────────────────────────────────────────
create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  doc_type text not null,
  idempotency_key text not null,
  document_number text not null,
  numbering_prefix_snapshot text not null,
  counter_period_key text not null default '',
  sequence_value bigint not null,
  verification_token text not null default encode(extensions.gen_random_bytes(16), 'hex'),
  status text not null default 'rendering',
  locale text not null,
  patient_id uuid references public.patients(id) on delete restrict,
  staff_id uuid references public.profiles(id) on delete restrict,
  doctor_id uuid references public.profiles(id) on delete restrict,
  appointment_id uuid references public.appointments(id) on delete restrict,
  invoice_id uuid,
  params jsonb not null,
  snapshot jsonb not null,
  watermark_snapshot text,
  pdf_storage_path text,
  page_count integer,
  print_count integer not null default 0,
  regenerated_from uuid references public.documents(id) on delete restrict,
  issued_by uuid not null references public.profiles(id) on delete restrict,
  reserved_at timestamptz not null default now(),
  issued_at timestamptz,
  failure_code text,
  failed_at timestamptz,
  voided_by uuid references public.profiles(id) on delete restrict,
  voided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint documents_doc_type_format check (
    doc_type ~ '^[A-Z][A-Z0-9_]{1,63}$'
  ),
  constraint documents_idempotency_key_length check (
    length(btrim(idempotency_key)) between 1 and 200
  ),
  constraint documents_number_length check (
    length(btrim(document_number)) between 1 and 120
  ),
  constraint documents_prefix_format check (
    numbering_prefix_snapshot ~ '^[A-Z][A-Z0-9-]{0,15}$'
  ),
  constraint documents_period_key_length check (
    length(counter_period_key) <= 16
  ),
  constraint documents_sequence_positive check (sequence_value > 0),
  constraint documents_verification_token_format check (
    verification_token ~ '^[0-9a-f]{32}$'
  ),
  constraint documents_status_check check (
    status = any (array['rendering', 'issued', 'failed', 'void', 'cancelled'])
  ),
  constraint documents_locale_check check (locale = any (array['ar', 'en'])),
  constraint documents_params_object check (jsonb_typeof(params) = 'object'),
  constraint documents_snapshot_object check (jsonb_typeof(snapshot) = 'object'),
  constraint documents_page_count_positive check (
    page_count is null or page_count > 0
  ),
  constraint documents_print_count_nonnegative check (print_count >= 0),
  constraint documents_failure_code_length check (
    failure_code is null or length(btrim(failure_code)) between 1 and 120
  ),
  constraint documents_pdf_path_scoped check (
    pdf_storage_path is null
    or pdf_storage_path = (
      'documents/' || clinic_id::text || '/' || doc_type || '/' || id::text || '.pdf'
    )
  ),
  constraint documents_state_completeness check (
    (
      status = 'rendering'
      and pdf_storage_path is null
      and issued_at is null
      and failed_at is null
    )
    or (
      status = 'failed'
      and pdf_storage_path is null
      and issued_at is null
      and failed_at is not null
      and failure_code is not null
    )
    or (
      status = any (array['issued', 'void', 'cancelled'])
      and pdf_storage_path is not null
      and page_count is not null
      and issued_at is not null
    )
  ),
  unique (clinic_id, idempotency_key),
  unique (clinic_id, doc_type, document_number),
  unique (verification_token)
);

comment on table public.documents is
  'Immutable identities and snapshots for document issuance. Rendering/failed rows are internal reservations and are never exposed through authenticated SELECT RLS.';
comment on column public.documents.idempotency_key is
  'Clinic-scoped logical issuance identity. Retries return the same reservation and never allocate another number.';
comment on column public.documents.document_number is
  'Complete visible number frozen at allocation; never recomputed after prefix-setting changes.';
comment on column public.documents.snapshot is
  'Fully resolved point-in-time document payload used for faithful reprint.';

create index if not exists documents_clinic_type_issued_idx
  on public.documents (clinic_id, doc_type, issued_at desc)
  where status = any (array['issued', 'void', 'cancelled']);
create index if not exists documents_clinic_patient_idx
  on public.documents (clinic_id, patient_id, issued_at desc)
  where patient_id is not null and status = any (array['issued', 'void', 'cancelled']);
create index if not exists documents_clinic_staff_idx
  on public.documents (clinic_id, staff_id, issued_at desc)
  where staff_id is not null and status = any (array['issued', 'void', 'cancelled']);
create index if not exists documents_clinic_doctor_idx
  on public.documents (clinic_id, doctor_id, issued_at desc)
  where doctor_id is not null and status = any (array['issued', 'void', 'cancelled']);
create index if not exists documents_clinic_appointment_idx
  on public.documents (clinic_id, appointment_id, issued_at desc)
  where appointment_id is not null and status = any (array['issued', 'void', 'cancelled']);

create table if not exists public.document_events (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete cascade,
  event text not null,
  actor_id uuid references public.profiles(id) on delete set null,
  is_system boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  constraint document_events_event_check check (
    event = any (array[
      'issued', 'issuance_failed', 'printed', 'reprinted',
      'regenerated', 'voided', 'cancelled', 'delivered'
    ])
  ),
  constraint document_events_metadata_object check (
    jsonb_typeof(metadata) = 'object'
  ),
  constraint document_events_actor_shape check (
    (is_system and actor_id is null) or (not is_system and actor_id is not null)
  )
);

comment on table public.document_events is
  'Append-only document lifecycle timeline. Authenticated roles have SELECT only; writes occur inside reviewed RPCs.';

create index if not exists document_events_document_occurred_idx
  on public.document_events (clinic_id, document_id, occurred_at desc);

create table if not exists public.document_counters (
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  doc_type text not null,
  period_key text not null default '',
  next_seq bigint not null default 1,
  updated_at timestamptz not null default now(),
  primary key (clinic_id, doc_type, period_key),
  constraint document_counters_doc_type_format check (
    doc_type ~ '^[A-Z][A-Z0-9_]{1,63}$'
  ),
  constraint document_counters_period_key_length check (length(period_key) <= 16),
  constraint document_counters_next_seq_positive check (next_seq > 0)
);

comment on table public.document_counters is
  'Server-only next sequence per clinic, document type, and optional reset period.';

create table if not exists public.document_settings (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  doc_type text,
  watermark_enabled boolean not null default true,
  watermark_text text,
  qr_enabled boolean not null default true,
  numbering_prefix text,
  numbering_yearly_reset boolean not null default true,
  print_options jsonb not null default '{}'::jsonb,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint document_settings_doc_type_format check (
    doc_type is null or doc_type ~ '^[A-Z][A-Z0-9_]{1,63}$'
  ),
  constraint document_settings_watermark_length check (
    watermark_text is null or length(btrim(watermark_text)) between 1 and 160
  ),
  constraint document_settings_prefix_format check (
    numbering_prefix is null or numbering_prefix ~ '^[A-Z][A-Z0-9-]{0,15}$'
  ),
  constraint document_settings_print_options_object check (
    jsonb_typeof(print_options) = 'object'
  )
);

create unique index if not exists document_settings_global_unique
  on public.document_settings (clinic_id)
  where doc_type is null;
create unique index if not exists document_settings_type_unique
  on public.document_settings (clinic_id, doc_type)
  where doc_type is not null;

comment on table public.document_settings is
  'Clinic-wide (doc_type null) and per-type document defaults. Resolution is per-type, then global, then catalog.';

-- Validate every optional subject/actor reference against the row clinic. This
-- is defense-in-depth for the service-role issuance boundary and prevents a
-- cross-tenant UUID from entering a document even if an application check drifts.
create or replace function public.validate_document_tenant_references()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.profiles p
    where p.id = new.issued_by and p.clinic_id = new.clinic_id
  ) then
    raise exception 'DOCUMENT_ACTOR_SCOPE_VIOLATION' using errcode = '42501';
  end if;
  if new.patient_id is not null and not exists (
    select 1 from public.patients p
    where p.id = new.patient_id and p.clinic_id = new.clinic_id
  ) then
    raise exception 'DOCUMENT_PATIENT_SCOPE_VIOLATION' using errcode = '42501';
  end if;
  if new.staff_id is not null and not exists (
    select 1 from public.profiles p
    where p.id = new.staff_id and p.clinic_id = new.clinic_id
  ) then
    raise exception 'DOCUMENT_STAFF_SCOPE_VIOLATION' using errcode = '42501';
  end if;
  if new.doctor_id is not null and not exists (
    select 1 from public.profiles p
    where p.id = new.doctor_id and p.clinic_id = new.clinic_id
  ) then
    raise exception 'DOCUMENT_DOCTOR_SCOPE_VIOLATION' using errcode = '42501';
  end if;
  if new.appointment_id is not null and not exists (
    select 1 from public.appointments a
    where a.id = new.appointment_id and a.clinic_id = new.clinic_id
  ) then
    raise exception 'DOCUMENT_APPOINTMENT_SCOPE_VIOLATION' using errcode = '42501';
  end if;
  if new.voided_by is not null and not exists (
    select 1 from public.profiles p
    where p.id = new.voided_by and p.clinic_id = new.clinic_id
  ) then
    raise exception 'DOCUMENT_VOID_ACTOR_SCOPE_VIOLATION' using errcode = '42501';
  end if;
  if new.regenerated_from is not null and not exists (
    select 1 from public.documents d
    where d.id = new.regenerated_from and d.clinic_id = new.clinic_id
  ) then
    raise exception 'DOCUMENT_PREDECESSOR_SCOPE_VIOLATION' using errcode = '42501';
  end if;
  return new;
end;
$$;
alter function public.validate_document_tenant_references() owner to postgres;
revoke all on function public.validate_document_tenant_references() from public;

drop trigger if exists trg_documents_tenant_references on public.documents;
create trigger trg_documents_tenant_references
before insert or update on public.documents
for each row execute function public.validate_document_tenant_references();

drop trigger if exists trg_documents_updated_at on public.documents;
create trigger trg_documents_updated_at
before update on public.documents
for each row execute function public.set_updated_at();

drop trigger if exists trg_document_settings_updated_at on public.document_settings;
create trigger trg_document_settings_updated_at
before update on public.document_settings
for each row execute function public.set_updated_at();

-- ── RLS and grants ───────────────────────────────────────────────────────────
alter table public.documents enable row level security;
alter table public.document_events enable row level security;
alter table public.document_counters enable row level security;
alter table public.document_settings enable row level security;

revoke all on table public.documents from anon, authenticated;
revoke all on table public.document_events from anon, authenticated;
revoke all on table public.document_counters from anon, authenticated;
revoke all on table public.document_settings from anon, authenticated;
grant select on table public.documents to authenticated;
grant select on table public.document_events to authenticated;
grant select on table public.document_settings to authenticated;
grant all on table public.documents to service_role;
grant all on table public.document_events to service_role;
grant all on table public.document_counters to service_role;
grant all on table public.document_settings to service_role;

drop policy if exists "documents_select_scoped" on public.documents;
create policy "documents_select_scoped"
on public.documents
for select
to authenticated
using (
  clinic_id = public.auth_clinic_id()
  and status = any (array['issued', 'void', 'cancelled'])
  and (
    public.auth_role() = any (
      array[
        'admin'::public.user_role,
        'manager'::public.user_role,
        'receptionist'::public.user_role
      ]
    )
    or (
      public.auth_role() = 'doctor'::public.user_role
      and (
        doctor_id = auth.uid()
        or exists (
          select 1 from public.patients p
          where p.id = documents.patient_id
            and p.clinic_id = public.auth_clinic_id()
            and not p.is_deleted
            and (
              p.assigned_doctor_id = auth.uid()
              or (
                public.auth_department_id() is not null
                and p.department_id = public.auth_department_id()
              )
            )
        )
      )
    )
    or (
      public.auth_role() = 'assistant'::public.user_role
      and (
        doctor_id = any (public.auth_supervised_doctor_ids())
        or exists (
          select 1 from public.patients p
          where p.id = documents.patient_id
            and p.clinic_id = public.auth_clinic_id()
            and not p.is_deleted
            and p.assigned_doctor_id = any (public.auth_supervised_doctor_ids())
        )
      )
    )
  )
);

drop policy if exists "document_events_select_scoped" on public.document_events;
create policy "document_events_select_scoped"
on public.document_events
for select
to authenticated
using (
  clinic_id = public.auth_clinic_id()
  and exists (
    select 1 from public.documents d
    where d.id = document_events.document_id
      and d.clinic_id = document_events.clinic_id
  )
);

drop policy if exists "document_settings_select_clinic" on public.document_settings;
create policy "document_settings_select_clinic"
on public.document_settings
for select
to authenticated
using (clinic_id = public.auth_clinic_id());

-- No authenticated write policy exists for any P7-0 table. Counters have no
-- authenticated SELECT policy either. All identity/event writes go through the
-- service-only RPC boundary below; settings writes arrive in P7-9.

-- ── Atomic numbering ─────────────────────────────────────────────────────────
create or replace function public.allocate_document_number(
  p_clinic_id uuid,
  p_doc_type text,
  p_period_key text default ''
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sequence bigint;
begin
  if p_clinic_id is null or not exists (
    select 1 from public.clinics c where c.id = p_clinic_id
  ) then
    raise exception 'DOCUMENT_CLINIC_NOT_FOUND' using errcode = 'P0002';
  end if;
  if p_doc_type is null or p_doc_type !~ '^[A-Z][A-Z0-9_]{1,63}$' then
    raise exception 'DOCUMENT_TYPE_INVALID' using errcode = '22023';
  end if;
  if p_period_key is null or length(p_period_key) > 16 then
    raise exception 'DOCUMENT_PERIOD_INVALID' using errcode = '22023';
  end if;

  insert into public.document_counters (
    clinic_id, doc_type, period_key, next_seq, updated_at
  ) values (
    p_clinic_id, p_doc_type, p_period_key, 2, now()
  )
  on conflict (clinic_id, doc_type, period_key)
  do update set
    next_seq = public.document_counters.next_seq + 1,
    updated_at = now()
  returning next_seq - 1 into v_sequence;

  return v_sequence;
end;
$$;
alter function public.allocate_document_number(uuid, text, text) owner to postgres;
revoke all on function public.allocate_document_number(uuid, text, text) from public, anon, authenticated;
grant execute on function public.allocate_document_number(uuid, text, text) to service_role;

-- ── Idempotent issuance reservation/finalization ─────────────────────────────
create or replace function public.reserve_document_issue(
  p_clinic_id uuid,
  p_actor_id uuid,
  p_doc_type text,
  p_idempotency_key text,
  p_locale text,
  p_numbering_prefix text,
  p_period_key text,
  p_sequence_padding integer,
  p_params jsonb,
  p_snapshot jsonb,
  p_watermark_snapshot text default null,
  p_patient_id uuid default null,
  p_staff_id uuid default null,
  p_doctor_id uuid default null,
  p_appointment_id uuid default null,
  p_invoice_id uuid default null,
  p_regenerated_from uuid default null
)
returns table (
  document_id uuid,
  document_number text,
  verification_token text,
  issue_status text,
  reused boolean,
  document_type text,
  render_locale text,
  params_snapshot jsonb,
  data_snapshot jsonb,
  effective_watermark text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.documents%rowtype;
  v_sequence bigint;
  v_number text;
  v_document public.documents%rowtype;
begin
  if p_clinic_id is null or p_actor_id is null or not exists (
    select 1 from public.profiles p
    where p.id = p_actor_id
      and p.clinic_id = p_clinic_id
      and p.is_active
      and not p.is_deleted
      and p.deleted_at is null
  ) then
    raise exception 'DOCUMENT_ACTOR_NOT_AUTHORIZED' using errcode = '42501';
  end if;
  if p_doc_type is null or p_doc_type !~ '^[A-Z][A-Z0-9_]{1,63}$' then
    raise exception 'DOCUMENT_TYPE_INVALID' using errcode = '22023';
  end if;
  if p_idempotency_key is null
    or length(btrim(p_idempotency_key)) not between 1 and 200 then
    raise exception 'DOCUMENT_IDEMPOTENCY_KEY_INVALID' using errcode = '22023';
  end if;
  if p_locale is null or p_locale <> all (array['ar', 'en']) then
    raise exception 'DOCUMENT_LOCALE_INVALID' using errcode = '22023';
  end if;
  if p_numbering_prefix is null
    or p_numbering_prefix !~ '^[A-Z][A-Z0-9-]{0,15}$' then
    raise exception 'DOCUMENT_PREFIX_INVALID' using errcode = '22023';
  end if;
  if p_period_key is null or length(p_period_key) > 16 then
    raise exception 'DOCUMENT_PERIOD_INVALID' using errcode = '22023';
  end if;
  if p_sequence_padding is null or p_sequence_padding not between 1 and 12 then
    raise exception 'DOCUMENT_SEQUENCE_PADDING_INVALID' using errcode = '22023';
  end if;
  if p_params is null or jsonb_typeof(p_params) <> 'object'
    or p_snapshot is null or jsonb_typeof(p_snapshot) <> 'object' then
    raise exception 'DOCUMENT_PAYLOAD_INVALID' using errcode = '22023';
  end if;

  -- Serialize every logical issue before checking/allocating. Without this,
  -- two first-time requests could both allocate before the unique-key loser is
  -- detected, unnecessarily retiring a second number.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_clinic_id::text || ':' || p_idempotency_key, 0)
  );

  select d.* into v_existing
  from public.documents d
  where d.clinic_id = p_clinic_id
    and d.idempotency_key = p_idempotency_key;

  if found then
    if v_existing.issued_by <> p_actor_id
      or v_existing.doc_type <> p_doc_type
      or v_existing.locale <> p_locale
      or v_existing.params <> p_params
      or v_existing.patient_id is distinct from p_patient_id
      or v_existing.staff_id is distinct from p_staff_id
      or v_existing.doctor_id is distinct from p_doctor_id
      or v_existing.appointment_id is distinct from p_appointment_id
      or v_existing.invoice_id is distinct from p_invoice_id
      or v_existing.regenerated_from is distinct from p_regenerated_from then
      raise exception 'DOCUMENT_IDEMPOTENCY_CONFLICT' using errcode = '23505';
    end if;

    return query select
      v_existing.id,
      v_existing.document_number,
      v_existing.verification_token,
      v_existing.status,
      true,
      v_existing.doc_type,
      v_existing.locale,
      v_existing.params,
      v_existing.snapshot,
      v_existing.watermark_snapshot;
    return;
  end if;

  v_sequence := public.allocate_document_number(
    p_clinic_id,
    p_doc_type,
    p_period_key
  );
  v_number := p_numbering_prefix
    || case when p_period_key = '' then '' else '-' || p_period_key end
    || '-' || lpad(v_sequence::text, p_sequence_padding, '0');

  insert into public.documents (
    clinic_id,
    doc_type,
    idempotency_key,
    document_number,
    numbering_prefix_snapshot,
    counter_period_key,
    sequence_value,
    status,
    locale,
    patient_id,
    staff_id,
    doctor_id,
    appointment_id,
    invoice_id,
    params,
    snapshot,
    watermark_snapshot,
    regenerated_from,
    issued_by
  ) values (
    p_clinic_id,
    p_doc_type,
    btrim(p_idempotency_key),
    v_number,
    p_numbering_prefix,
    p_period_key,
    v_sequence,
    'rendering',
    p_locale,
    p_patient_id,
    p_staff_id,
    p_doctor_id,
    p_appointment_id,
    p_invoice_id,
    p_params,
    p_snapshot,
    nullif(btrim(p_watermark_snapshot), ''),
    p_regenerated_from,
    p_actor_id
  )
  returning * into v_document;

  return query select
    v_document.id,
    v_document.document_number,
    v_document.verification_token,
    v_document.status,
    false,
    v_document.doc_type,
    v_document.locale,
    v_document.params,
    v_document.snapshot,
    v_document.watermark_snapshot;
end;
$$;
alter function public.reserve_document_issue(
  uuid, uuid, text, text, text, text, text, integer, jsonb, jsonb,
  text, uuid, uuid, uuid, uuid, uuid, uuid
) owner to postgres;
revoke all on function public.reserve_document_issue(
  uuid, uuid, text, text, text, text, text, integer, jsonb, jsonb,
  text, uuid, uuid, uuid, uuid, uuid, uuid
) from public, anon, authenticated;
grant execute on function public.reserve_document_issue(
  uuid, uuid, text, text, text, text, text, integer, jsonb, jsonb,
  text, uuid, uuid, uuid, uuid, uuid, uuid
) to service_role;

create or replace function public.complete_document_issue(
  p_clinic_id uuid,
  p_actor_id uuid,
  p_document_id uuid,
  p_pdf_storage_path text,
  p_page_count integer
)
returns table (
  document_id uuid,
  document_number text,
  verification_token text,
  issue_status text,
  reused boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_document public.documents%rowtype;
  v_actor_role public.user_role;
  v_expected_path text;
begin
  select p.role into v_actor_role
  from public.profiles p
  where p.id = p_actor_id
    and p.clinic_id = p_clinic_id
    and p.is_active
    and not p.is_deleted
    and p.deleted_at is null;
  if not found then
    raise exception 'DOCUMENT_ACTOR_NOT_AUTHORIZED' using errcode = '42501';
  end if;
  if p_page_count is null or p_page_count < 1 then
    raise exception 'DOCUMENT_PAGE_COUNT_INVALID' using errcode = '22023';
  end if;

  select d.* into v_document
  from public.documents d
  where d.id = p_document_id and d.clinic_id = p_clinic_id
  for update;
  if not found then
    raise exception 'DOCUMENT_RESERVATION_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_document.issued_by <> p_actor_id then
    raise exception 'DOCUMENT_ACTOR_MISMATCH' using errcode = '42501';
  end if;

  v_expected_path := 'documents/' || p_clinic_id::text || '/'
    || v_document.doc_type || '/' || p_document_id::text || '.pdf';
  if p_pdf_storage_path is distinct from v_expected_path then
    raise exception 'DOCUMENT_STORAGE_PATH_INVALID' using errcode = '22023';
  end if;

  if v_document.status = 'issued' then
    return query select
      v_document.id,
      v_document.document_number,
      v_document.verification_token,
      v_document.status,
      true;
    return;
  end if;
  if v_document.status <> all (array['rendering', 'failed']) then
    raise exception 'DOCUMENT_STATE_INVALID' using errcode = '55000';
  end if;

  update public.documents d
  set status = 'issued',
      pdf_storage_path = v_expected_path,
      page_count = p_page_count,
      issued_at = now(),
      failure_code = null,
      failed_at = null
  where d.id = v_document.id
  returning * into v_document;

  insert into public.document_events (
    clinic_id, document_id, event, actor_id, is_system, metadata
  ) values (
    p_clinic_id,
    v_document.id,
    'issued',
    p_actor_id,
    false,
    jsonb_build_object('page_count', p_page_count)
  );

  insert into public.activity_events (
    clinic_id,
    actor_id,
    actor_role,
    is_system,
    action,
    entity_type,
    entity_id,
    patient_id,
    doctor_id,
    new_state,
    metadata
  ) values (
    p_clinic_id,
    p_actor_id,
    v_actor_role,
    false,
    'document.issued',
    'document',
    v_document.id,
    v_document.patient_id,
    v_document.doctor_id,
    jsonb_build_object(
      'status', 'issued',
      'doc_type', v_document.doc_type,
      'document_number', v_document.document_number
    ),
    jsonb_build_object('page_count', p_page_count)
  );

  return query select
    v_document.id,
    v_document.document_number,
    v_document.verification_token,
    v_document.status,
    false;
end;
$$;
alter function public.complete_document_issue(uuid, uuid, uuid, text, integer) owner to postgres;
revoke all on function public.complete_document_issue(uuid, uuid, uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.complete_document_issue(uuid, uuid, uuid, text, integer)
  to service_role;

create or replace function public.fail_document_issue(
  p_clinic_id uuid,
  p_actor_id uuid,
  p_document_id uuid,
  p_failure_code text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_document public.documents%rowtype;
begin
  if p_failure_code is null
    or length(btrim(p_failure_code)) not between 1 and 120 then
    raise exception 'DOCUMENT_FAILURE_CODE_INVALID' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.profiles p
    where p.id = p_actor_id
      and p.clinic_id = p_clinic_id
      and p.is_active
      and not p.is_deleted
      and p.deleted_at is null
  ) then
    raise exception 'DOCUMENT_ACTOR_NOT_AUTHORIZED' using errcode = '42501';
  end if;

  select d.* into v_document
  from public.documents d
  where d.id = p_document_id and d.clinic_id = p_clinic_id
  for update;
  if not found then
    raise exception 'DOCUMENT_RESERVATION_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_document.issued_by <> p_actor_id then
    raise exception 'DOCUMENT_ACTOR_MISMATCH' using errcode = '42501';
  end if;
  if v_document.status = any (array['issued', 'void', 'cancelled']) then
    return false;
  end if;

  update public.documents d
  set status = 'failed',
      pdf_storage_path = null,
      page_count = null,
      issued_at = null,
      failure_code = btrim(p_failure_code),
      failed_at = now()
  where d.id = v_document.id;

  insert into public.document_events (
    clinic_id, document_id, event, actor_id, is_system, metadata
  ) values (
    p_clinic_id,
    v_document.id,
    'issuance_failed',
    p_actor_id,
    false,
    jsonb_build_object('failure_code', btrim(p_failure_code))
  );

  return true;
end;
$$;
alter function public.fail_document_issue(uuid, uuid, uuid, text) owner to postgres;
revoke all on function public.fail_document_issue(uuid, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.fail_document_issue(uuid, uuid, uuid, text)
  to service_role;

-- ── Private canonical PDF bucket ─────────────────────────────────────────────
insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'clinic-documents',
  'clinic-documents',
  false,
  26214400,
  array['application/pdf']::text[]
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "clinic_documents_select_scoped" on storage.objects;
create policy "clinic_documents_select_scoped"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'clinic-documents'
  and name ~ '^documents/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[A-Z][A-Z0-9_]{1,63}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$'
  and (storage.foldername(name))[1] = 'documents'
  and (storage.foldername(name))[2] = public.auth_clinic_id()::text
  and exists (
    select 1 from public.documents d
    where d.id = split_part(storage.filename(name), '.', 1)::uuid
      and d.clinic_id = public.auth_clinic_id()
      and d.doc_type = (storage.foldername(name))[3]
      and d.pdf_storage_path = name
  )
);

-- Upload/update/delete intentionally have no authenticated policy. Canonical
-- artifacts are written through the reviewed server-only issuance boundary.
