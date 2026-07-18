-- P4A: Doctor AI assistant foundation — agent conversation state, FAQ schema,
-- and the agent tool-call audit RPC (§6.2, §6.6 of docs/AI_AGENT_PLAN.md).
--
-- Scope of this migration (all P4 schema lands here):
--   * agent_conversations / agent_messages — staff assistant chat state,
--     clinic-scoped and owner-scoped (a staff member sees only their own
--     conversations). The doctor persona ships in P4; the patient persona is
--     reserved in the enum for P5 but no patient tools/policies exist yet.
--   * clinic_faq — schema only. Per-clinic Q&A used by the patient FAQ tool in
--     P5; the content-management UI is P5. Staff of the owning clinic may read;
--     no write policies exist in P4A (writes arrive with the P5 settings UI).
--   * log_agent_tool_call — SECURITY DEFINER audit boundary. Every agent tool
--     invocation is recorded in the existing audit_logs table so clinic admins
--     inherit visibility through audit_logs_select_admin_manager. Callable by
--     service_role only; the RLS-respecting tools log through lib/ai/audit.ts.
--
-- Trust boundaries: message bodies are patient-adjacent data and stay invisible
-- to the operator panel (no platform-admin policies, matching P3A). Tools never
-- write these tables through the model — persistence is the P4B streaming route
-- acting as the authenticated owner, gated by the owner-scoped policies below.

create type public.agent_persona as enum ('doctor', 'patient');
create type public.agent_message_role as enum ('user', 'assistant', 'tool');

-- ---------------------------------------------------------------------------
-- agent_conversations — one staff assistant thread, owned by one staff member
-- ---------------------------------------------------------------------------

create table public.agent_conversations (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  -- The staff owner. A conversation is private to its creator; audit visibility
  -- for admins comes from audit_logs, not from reading each other's chats.
  user_id uuid not null,
  persona public.agent_persona not null default 'doctor',
  -- Optional patient context (the patient-profile Sheet launcher, §6.2). Never a
  -- model-visible parameter; it only scopes which patient the staff opened.
  patient_id uuid,
  title text check (title is null or length(btrim(title)) between 1 and 200),
  locale text not null default 'en' check (locale in ('ar', 'en')),
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Composite tenant-integrity FKs (P3A precedent): owner and patient must
  -- belong to the same clinic as the conversation.
  constraint agent_conversations_user_clinic_fkey
    foreign key (user_id, clinic_id)
    references public.profiles(id, clinic_id)
    on delete cascade,
  constraint agent_conversations_patient_clinic_fkey
    foreign key (patient_id, clinic_id)
    references public.patients(id, clinic_id)
    on delete set null (patient_id)
);

create index agent_conversations_owner_idx
  on public.agent_conversations (clinic_id, user_id, updated_at desc);
-- Anchor for the agent_messages composite FK.
create unique index agent_conversations_id_clinic_unique_idx
  on public.agent_conversations (id, clinic_id);

alter table public.agent_conversations enable row level security;

-- Owner-scoped full access for the two personas' staff owners. The streaming
-- route in P4B runs as the authenticated owner through the RLS client, so these
-- policies are the persistence boundary — there is no service-role write path.
create policy "agent_owner_all_conversations"
on public.agent_conversations for all to authenticated
using (
  clinic_id = public.auth_clinic_id()
  and user_id = auth.uid()
  and public.auth_role() = any (
    array['admin'::public.user_role, 'doctor'::public.user_role]
  )
)
with check (
  clinic_id = public.auth_clinic_id()
  and user_id = auth.uid()
  and public.auth_role() = any (
    array['admin'::public.user_role, 'doctor'::public.user_role]
  )
);

create trigger trg_agent_conversations_updated_at
  before update on public.agent_conversations
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- agent_messages — turns of a conversation (user / assistant / tool)
-- ---------------------------------------------------------------------------

create table public.agent_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null,
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  role public.agent_message_role not null,
  content text not null default '',
  -- Set on tool turns for lightweight inspection; the full audit trail is in
  -- audit_logs via log_agent_tool_call.
  tool_name text check (tool_name is null or length(btrim(tool_name)) between 1 and 100),
  created_at timestamptz not null default now(),
  constraint agent_messages_conversation_clinic_fkey
    foreign key (conversation_id, clinic_id)
    references public.agent_conversations(id, clinic_id)
    on delete cascade
);

create index agent_messages_conversation_idx
  on public.agent_messages (conversation_id, created_at);

alter table public.agent_messages enable row level security;

-- A staff member may read/write messages of a conversation they own.
create policy "agent_owner_all_messages"
on public.agent_messages for all to authenticated
using (
  clinic_id = public.auth_clinic_id()
  and exists (
    select 1 from public.agent_conversations c
    where c.id = agent_messages.conversation_id
      and c.clinic_id = agent_messages.clinic_id
      and c.user_id = auth.uid()
  )
)
with check (
  clinic_id = public.auth_clinic_id()
  and exists (
    select 1 from public.agent_conversations c
    where c.id = agent_messages.conversation_id
      and c.clinic_id = agent_messages.clinic_id
      and c.user_id = auth.uid()
  )
);

-- ---------------------------------------------------------------------------
-- clinic_faq — per-clinic Q&A (schema only in P4A; content UI + tool in P5)
-- ---------------------------------------------------------------------------

create table public.clinic_faq (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  question text not null check (length(btrim(question)) between 1 and 500),
  answer text not null check (length(btrim(answer)) between 1 and 4000),
  language text not null default 'ar' check (language in ('ar', 'en')),
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (clinic_id, question, language)
);

create index clinic_faq_clinic_active_idx
  on public.clinic_faq (clinic_id, is_active, sort_order);

alter table public.clinic_faq enable row level security;

-- FAQ content is non-clinical clinic information; any staff member of the
-- owning clinic may read it. Writes arrive with the P5 settings UI.
create policy "clinic_faq_staff_read_own"
on public.clinic_faq for select to authenticated
using (clinic_id = public.auth_clinic_id());

create trigger trg_clinic_faq_updated_at
  before update on public.clinic_faq
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- log_agent_tool_call — audit boundary for every agent tool invocation (§6.6)
-- ---------------------------------------------------------------------------

create or replace function public.log_agent_tool_call(
  p_clinic_id uuid,
  p_tool text,
  p_actor_id uuid default null,
  p_table_name text default null,
  p_record_id uuid default null,
  p_summary jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  -- Service-role only: the RLS-respecting tools log through the reviewed
  -- lib/ai/audit.ts service boundary; no clinic user calls this directly.
  if p_clinic_id is null or coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Not authorized to log agent tool calls' using errcode = '42501';
  end if;
  if p_tool is null or length(btrim(p_tool)) = 0 then
    raise exception 'Tool name is required';
  end if;
  if jsonb_typeof(p_summary) is distinct from 'object' then
    raise exception 'Tool summary must be a JSON object';
  end if;

  insert into public.audit_logs (
    actor_id, clinic_id, action, table_name, record_id, new_data
  ) values (
    p_actor_id,
    p_clinic_id,
    'agent_tool:' || p_tool,
    coalesce(p_table_name, 'agent'),
    p_record_id,
    p_summary
  )
  returning id into v_id;

  return v_id;
end;
$$;

-- Service-role only at the privilege layer, not merely the runtime guard: strip
-- the ambient authenticated/anon EXECUTE that Supabase default privileges grant
-- on new public functions. Only the reviewed lib/ai/audit.ts boundary calls it.
revoke all on function public.log_agent_tool_call(uuid, text, uuid, text, uuid, jsonb) from public;
revoke all on function public.log_agent_tool_call(uuid, text, uuid, text, uuid, jsonb) from authenticated;
revoke all on function public.log_agent_tool_call(uuid, text, uuid, text, uuid, jsonb) from anon;
grant execute on function public.log_agent_tool_call(uuid, text, uuid, text, uuid, jsonb) to service_role;
