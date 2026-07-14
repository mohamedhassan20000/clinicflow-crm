-- P2A: per-user UI preferences (theme + locale) — AI_AGENT_PLAN.md §4.5.
--
-- Keyed on auth.users, never on profiles. This is load-bearing: a Platform Admin has NO profiles
-- row (profiles is clinic-scoped and carries clinic_id), so a profiles.theme/profiles.locale column
-- is structurally incapable of holding the SaaS Owner's theme or the operator dashboard's language.
-- One auth-user-keyed store serves clinic users and platform admins alike.
--
-- There is no clinic theme and no clinic language. Nothing about UI preferences may ever live on
-- `clinics` (§4, §4.5).

create table if not exists public.user_ui_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  theme text not null default 'light' check (theme in ('light', 'dark')),
  locale text not null default 'en' check (locale in ('en', 'ar')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.user_ui_preferences is
  'Per-authenticated-user UI preferences (theme + locale). Keyed on auth.users so it serves both clinic users and platform admins. Self-only RLS: no account may read or write another account''s row. Rows are created lazily on the user''s first preference write — see the backfill note in AI_AGENT_PLAN.md §4.5.';

comment on column public.user_ui_preferences.locale is
  'The user''s UI language (''en'' default, ''ar''). Adding a locale is a one-line migration to this check constraint. This is the ONLY source of a user''s UI language — clinics.locale must never resolve it.';

drop trigger if exists trg_user_ui_preferences_updated_at on public.user_ui_preferences;
create trigger trg_user_ui_preferences_updated_at
  before update on public.user_ui_preferences
  for each row execute function public.set_updated_at();

-- Self-only RLS (§4.5): user_id = auth.uid() for read AND write. No clinic scope, no role check,
-- and deliberately NO platform-admin exception — a platform admin is just another account here.
alter table public.user_ui_preferences enable row level security;

drop policy if exists user_ui_preferences_select_self on public.user_ui_preferences;
create policy user_ui_preferences_select_self on public.user_ui_preferences
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists user_ui_preferences_insert_self on public.user_ui_preferences;
create policy user_ui_preferences_insert_self on public.user_ui_preferences
  for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists user_ui_preferences_update_self on public.user_ui_preferences;
create policy user_ui_preferences_update_self on public.user_ui_preferences
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists user_ui_preferences_delete_self on public.user_ui_preferences;
create policy user_ui_preferences_delete_self on public.user_ui_preferences
  for delete to authenticated
  using (user_id = (select auth.uid()));

revoke all on table public.user_ui_preferences from anon;
grant select, insert, update, delete on table public.user_ui_preferences to authenticated;
grant all on table public.user_ui_preferences to service_role;

-- §13-Q11 — disposition of clinics.locale. DECIDED in P2A: option (a), RETAIN as clinic *formatting*
-- metadata (dates/numbers on clinic-wide artifacts), alongside timezone/currency/digits. It is
-- retired as a language source: it may never resolve any user's UI language again. Locale resolution
-- is user -> 'en' with no clinic tier. Recorded as a column comment so the constraint travels with
-- the schema rather than living only in a planning document.
comment on column public.clinics.locale is
  'Clinic FORMATTING metadata only (dates/numbers on clinic-wide artifacts), alongside timezone/currency/digits. NOT a language source: it must never resolve any user''s UI language. Dashboard language is always a per-user preference in user_ui_preferences.locale (AI_AGENT_PLAN.md §13-Q11, decided in P2A).';

-- Backfill: intentionally NONE. Historical theme choices live in a browser cookie that is not
-- readable server-side outside a request, so they cannot be migrated. Rows are created lazily on
-- each user's first post-P2A preference write, defaulting to light/en until then (§4.5).
