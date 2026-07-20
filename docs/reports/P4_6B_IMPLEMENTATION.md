# P4.6B — Analytics & Operational Tools in the Staff Assistant UI

**Date:** 2026-07-20
**Branch:** `feat/p46b-staff-analytics-ui`
**Status:** Implemented. Completes phase P4.6 (merge order P4.6C → P4.6A → P4.6B).
**Phase review:** `docs/reviews/P4.6_PHASE_REVIEW.md` — fixes implemented in `docs/reports/P4_6_PHASE_REVIEW_FIXES.md`. Findings touching this sub-phase: H1 (mid-stream denial reaching the client as a distinct state), L4 (financial absence attributed to the right cause), L10–L12 (the settings surface), and M4 (migration lock window → `docs/runbooks/P4_6_MIGRATION_DEPLOYMENT.md`).
**Roadmap:** `docs/AI_AGENT_PLAN.md` §8 — P4.6 execution split, sub-phase P4.6B.
**Depends on:** P4.6A (tool registry, RPCs, permission plumbing), P4B (assistant surface), P4.6C (entity search).
**Companion analysis:** `docs/reports/OPERATING_ASSISTANT_EXPANSION_PROPOSAL.md`.

---

## 1. Scope delivered

Everything in the roadmap's P4.6B *in-scope* list, plus the P4.6A follow-ups that were explicitly
assigned to this sub-phase.

| Deliverable | Where |
|---|---|
| P4.6A tools surfaced in the P4B staff assistant | `lib/ai/capabilities.ts`, `lib/ai/surface.ts`, `components/assistant/assistant-chat.tsx` |
| Entitlement/permission-gated affordances | `lib/ai/capabilities.ts` → suggestion chips + financial notice |
| Upgrade / permission-denied UX copy (ar/en) | `messages/{en,ar}.json` — `assistant.*`, `settings.*` |
| Operational-vs-financial result presentation | `lib/ai/tool-presentation.ts`, `ToolActivity` |
| Report deep links | `ToolActivity` → `run_clinic_report`'s `link` |
| Admin settings surface for the financial grant | `components/settings/ai-financial-permissions.tsx`, `app/(protected)/settings/ai/page.tsx` |
| Carry-forward access-path fixes (P4.6A §10) | `supabase/migrations/20260720140000_p46b_assistant_access_paths.sql` |
| Tests | `tests/unit/ai/p46b-*.test.ts`, `tests/unit/components/p46b-assistant-analytics-ui.test.tsx` |

**Out of scope and not built:** new standalone analytics pages, write actions, the P4.7 capability
panel, contextual launchers (P4.8).

---

## 2. Capabilities are read from the mount, not re-derived

`resolveAssistantCapabilities` calls **`resolveToolMount`** — the same function that builds the
model's tool array — and reports what came back.

The alternative was to re-express the P4.6 role matrix in the UI layer. That would have been a second
copy of a security-shaped rule maintained by hand, and its failure mode is precisely the one this
phase must avoid: an affordance that offers a capability the user does not have, producing a denial
they cannot act on, or one that hides a capability they do. A test asserts the two agree
(`p46b-assistant-capabilities.test.ts`, "matches the model's own mount rather than re-deriving the
matrix").

`taskClass` is deliberately omitted, so the result is the union across the task classes the role can
run rather than one turn's narrower mount. The per-turn mount stays authoritative for what the model
may call; this is the superset the UI describes.

**None of this is an authorization decision.** Every tool re-asserts role, subscription, entitlement,
page visibility, and the per-user grant inside `execute()`, and the route denies independently of
anything the client was shown. Capabilities resolution is wrapped so that a failure degrades to *no
affordances* rather than to a broken chat — the assistant is fully usable with no suggestion chips.

---

## 3. The two financial denials, told apart

P4.6A kept `permission_not_granted` distinct from `feature_not_entitled` specifically so this layer
could tell them apart (review I2). Before P4.6B both fell through to "something went wrong", which
was true of neither.

| State | Cause | What the user is told |
|---|---|---|
| `available` | Entitled + granted | Financial prompts are offered |
| `not_entitled` | Plan lacks `ai.financial_insights` | "not part of this clinic's plan" |
| `not_granted` | Entitled, per-user grant off | "a clinic admin can enable them in Settings → AI" |
| `not_applicable` | Receptionist / doctor | **Nothing at all** |
| `unavailable` | Entitled + granted, nothing mounted | "enabled for you, but unreachable right now" |

The `not_applicable` row is the one worth defending. Receptionists and doctors are excluded from
financial tools by non-registration and can never be granted them, so telling them the capability
exists but is disabled would advertise a door that does not exist. Silence is the honest state.

`explainFinancialAbsence` re-reads the entitlement and the grant rather than inferring from the
mount, because the mount collapses both causes into a single absence.

> **Corrections from the P4.6 phase review** (`docs/reviews/P4.6_PHASE_REVIEW.md`; fixes in
> `docs/reports/P4_6_PHASE_REVIEW_FIXES.md`):
>
> * **I3 — this section originally claimed that "roles that can never hold the financial grant are
>   told nothing at all".** That was true of the *capability notice* described in this table, and
>   false of the assistant as a whole: `run_clinic_report`'s generated description advertised the
>   revenue report to any manager whose role allowed it, grant or no grant (finding H1). The claim
>   now holds at both layers — the description is filtered by the resolved grant, and a financial
>   denial returns a structured, presentable result instead of throwing inside the model loop.
> * **L4 — the `unavailable` row above is new.** The entitled-and-granted-but-unmounted case
>   previously reported `not_entitled`, telling users their plan was the problem when it was not.

---

## 4. Result presentation

### 4.1 Financial results look different

Financial tools render with a distinct treatment and an explicit "Financial" tag. They are the group
behind the entitlement *plus* a per-user grant, and a revenue figure that looks visually identical to
an appointment count invites a reader to give both the same weight.

### 4.2 Caveats are rendered from the data, not from the model's summary

Each P4.6A tool already carries an honesty signal — `clamped`, `truncated`,
`suppressed_bucket_count`, `patients_total_exact`, `scope` — and the staff prompt instructs the model
to relay it. P4.6B renders the same signals **from the structured result**:

| Signal | Rendered as |
|---|---|
| `range.clamped` | "The requested range was too long, so *from* to *to* was used instead." |
| `truncated` + `row_cap` | "Only the first N rows were read, so this may not be everything." |
| `suppressed_bucket_count` | "N groups were too small to report, shown as fewer than *floor*." |
| `patients_total_exact: false` | "the total shown is rounded, not exact" |
| `scope: "all_time"` | "covers all time, not a specific date range" |
| P4.6C low confidence / `needs_clarification` | "More than one match — confirm which one you mean." |

This is duplication on purpose. A model that summarizes loosely drops exactly these caveats, and the
result is a partial answer presented as a confident one. The structured path cannot forget.

The `patients_total_exact` case closes the P4.6A follow-up asking that the UI not render
`patients_total_approx` as an exact figure.

### 4.3 Report deep links

`run_clinic_report` already returned a `link`; it is now a rendered anchor, so any number the
assistant quotes can be opened and checked against the real report page.

**A defect was found and fixed while testing this.** The first implementation accepted any link
starting with `/`, which admits protocol-relative `//evil.example` — a browser resolves that as an
absolute off-site URL. `safeInternalLink` now rejects `//` and `/\` prefixes. Nothing
tenant-controlled reaches this field today (the href is fixed per report), but a tool result is
model-loop output rendered as a clickable anchor, and that combination should not depend on the
current producers staying well-behaved.

---

## 5. Admin settings surface

`actions/ai-permissions.ts` shipped with P4.6A and had no UI; the actions even called
`revalidatePath("/settings/ai")` for a panel that did not exist. `AiFinancialPermissions` is that
panel, on the existing `/settings/ai` page (primary-admin gated, consistent with `/settings/customize`).

- Managers get a toggle; **admins are shown but not toggleable**. Admins already administer billing
  and every financial page, so revoking the grant would remove an assistant answer while leaving the
  underlying report one click away — the appearance of a control rather than a real one.
- With no `ai.financial_insights` entitlement the panel renders an explanatory state and reads no
  staff at all, because there is nothing anyone could act on.
- On a failed write the switch reverts to the server's truth rather than displaying a grant that was
  never written.

The server action remains the authority: it re-checks admin role, same-clinic target, grantable role,
and the entitlement before writing.

---

## 6. Carry-forward: access paths (migration `20260720140000`)

Two items from P4.6A §10, both due now because P4.6B is what puts these on a user-facing hot path.

### 6.1 `idx_patients_clinic_created`

The P4.6A review asked for `(clinic_id, created_at)` on `patients` to be confirmed before the tools
went hot (§8). **It did not exist** — only `idx_patients_clinic (clinic_id)`. The appointments half of
the same question already had `idx_appointments_clinic_date`. `count_new_patients` and the
`patients_new_in_range` term of `ai_get_clinic_summary` now plan as an **index-only scan**.

### 6.2 `search_patients_ranked` — the M5 re-check

The re-check confirmed the concern. The function scored every patient the caller's RLS admits and
filtered afterwards, so `idx_patients_search_name_trgm` was never used — a full scan per lookup on
the one table in this family that grows without bound.

M5 rejected the obvious fix because `%` applies pg_trgm's default 0.3 threshold, above the 0.18
recall floor the function deliberately uses. **That objection is about the default, not the
operator.** Setting `pg_trgm.similarity_threshold` and `pg_trgm.word_similarity_threshold` to `0.18`
on the function itself makes `%` and `<%` mean exactly what the score filter already means, so the
prefilter is an equivalence rather than a narrowing. Each branch of the score filter maps to an
index-usable predicate (mapping recorded in the migration header). `idx_patients_search_phone` moved
from btree to GIN trigram, because the suffix predicate is a leading-wildcard `LIKE` that a btree
cannot serve at all — this is the first definition under which that branch has ever used an index.

**Verified on 20,008 seeded patients**, including the P4.6C variant-name fixtures:

- **Row-for-row identical** to the previous definition across 23 queries spanning every `match_kind`
  and both scripts (Arabic, Latin, transliteration pairs, file number, phone suffix, prefix, fuzzy,
  empty, and no-match). Zero rows in either direction of a symmetric `EXCEPT ALL`.
- Plan is a `BitmapOr` over five index scans — `idx_patients_search_name_trgm` (×3, for `%`, `<%`,
  and the prefix `LIKE`), the file-number index, and `idx_patients_search_phone_trgm`.
- Name lookup **94.4 ms → 1.2 ms** (2061 → 241 shared buffers). Phone lookup **44.1 ms → 2.2 ms**.

---

## 7. Verification

| Gate | Result |
|---|---|
| `supabase db reset` | All migrations apply cleanly from scratch |
| `npm run typecheck` | Clean |
| `npm run lint` | **0 errors**, 25 warnings (all pre-existing, none in P4.6B files) |
| `npm test` (unit) | **178 files / 1115 tests passing** |
| `npm run test:integration` (live Postgres) | **22 files / 204 tests passing** |
| `npm run build` | Compiled successfully |
| `search_patients_ranked` equivalence + plan | Identical rows on 23 queries; BitmapOr confirmed |

### Two pre-existing tests updated, deliberately not deleted

1. `p4b-assistant-chat.test.tsx` asserted the administrative empty state discloses that the persona
   is non-clinical. P4.6B rewrote that copy (the persona now also covers analytics and reports), so
   the assertion was **re-pointed at the new sentence** — "Individual clinical records stay with
   doctors" — rather than dropped. The property is still worth asserting.
2. `p4b-surface-access.test.ts` used `toEqual` on the page resolution, which now carries
   `capabilities`. Relaxed to `toMatchObject`; the assertions it was actually making are unchanged.

### A defect found by its own test

`summarizeToolResult` accepted `//evil.example` as an internal link (§4.3). Found by the open-redirect
case in `p46b-tool-presentation.test.ts`, fixed before the suite was green.

---

## 8. Files

**New:** `lib/ai/capabilities.ts`; `lib/ai/tool-presentation.ts`;
`components/settings/ai-financial-permissions.tsx`;
`supabase/migrations/20260720140000_p46b_assistant_access_paths.sql`;
`tests/unit/ai/{p46b-assistant-capabilities,p46b-tool-presentation,p46b-assistant-copy-parity}.test.ts`;
`tests/unit/components/p46b-assistant-analytics-ui.test.tsx`.

**Modified:** `components/assistant/assistant-chat.tsx`, `lib/ai/surface.ts`,
`app/(protected)/assistant/page.tsx`, `app/(protected)/settings/ai/page.tsx`,
`messages/{en,ar}.json`, `docs/AI_AGENT_PLAN.md`, and two pre-existing test files.

**No changes to:** the tool registry, any tool's `execute()`, `lib/ai/authorization.ts`, the P4.6A
migration, or any RPC other than the access-path rewrite of `search_patients_ranked`. P4.6B adds no
authorization surface — it renders one that already existed.

---

## 9. Localization

Arabic is asserted, not assumed. `p46b-assistant-copy-parity.test.ts` drives every new key through
next-intl's real ICU resolution against both catalogs, and exercises `noticeSuppressed` at counts 0,
1, 2, 3, 11, and 100 — Arabic selects a different plural arm at each, and a missing arm throws at
render time, in production, for Arabic users only.

---

## 10. Follow-ups for later phases

Recorded, not deferred silently. None belongs to P4.6.

- **P4.7A** — the capability panel (`list_my_capabilities`) should derive from the same
  `resolveToolMount` resolution `lib/ai/capabilities.ts` now uses, so the panel, the chips, and the
  model's tool array stay one resolution rather than three.
- **P4.8A** — the suggestion chips are the natural precursor to contextual launchers;
  `AssistantCapabilities` is the shape a launcher resolver would filter on.
- **P4.12** — the adversarial corpus now has a rendered surface to test against. Note that
  `ToolActivity` renders tenant strings only through the sanitized tool result, and renders no
  tenant-authored text directly.
- **`user_page_permissions` cross-tenant shape** (P4.6A H3 §9.4) — still unhardened, still needs a
  data audit before the composite FK can be added. Unchanged by P4.6B; carried forward.
- **P4.6A working-tree hygiene (I1)** — the branch still mixes P4.6A, P4.6C, and now P4.6B files,
  plus the `messages/action-errors` reordering. Still a git operation on the user's branch, not a
  code change.
