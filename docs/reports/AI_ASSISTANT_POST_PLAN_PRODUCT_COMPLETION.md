# AI Assistant — Post-Plan Product Completion

**Author:** Claude
**Date:** 2026-08-16
**Branch:** `feat/p7-manual-qa-polish`
**Baseline:** `01d2d76` (HEAD) + the existing uncommitted working tree
**Plan:** [docs/plans/AI_ASSISTANT_FULL_CAPABILITY_PLAN.md](../plans/AI_ASSISTANT_FULL_CAPABILITY_PLAN.md)
**Prior state:** [AI_ASSISTANT_FINAL_COMPREHENSIVE_REVIEW.md](AI_ASSISTANT_FINAL_COMPREHENSIVE_REVIEW.md) → [AI_ASSISTANT_FINAL_FIXES.md](AI_ASSISTANT_FINAL_FIXES.md) (B-1, B-2 fixed; NB-1…NB-5 open)

**Scope discipline.** Exactly the three requested changes. No unrelated dirty work touched, no migration written, nothing pushed, deployed, or applied remotely.

---

## Summary

| # | Change | Status |
|---|---|---|
| 1 | Authorized patient-detail retrieval — suppression no longer blocks answers the user is authorized for | ✅ Delivered |
| 2 | Conversation history on the main Assistant | ✅ Delivered |
| 3 | "Ask Assistant" shortcuts use the same conversation system | ✅ Delivered |
| — | Test coverage across unit / component / integration / E2E | ✅ 89 new tests in 6 new files; 8 existing files corrected |
| — | Required gates | ✅ All green except one pre-existing local-fixture collision (§7) |

Nothing in this pass widens what a user may read or write. Change 1 widens what the assistant is willing to *say* about rows it was already allowed to fetch; changes 2 and 3 add navigation over conversations the same user could already resume by id. Every authorization gate the plan established is untouched, and §6 records the verification of each.

---

## 1 · Authorized patient-detail retrieval

### What was actually wrong

Not an authorization hole — the opposite. `query_resource` over `patients` already carried `blood_type` as both a readable field and a registered filter, and `assertResourceAccess` already admitted every RLS-admitted role. "Which patients have O+ blood?" was *reachable*. What made it fail in practice was two things, both about the assistant's willingness rather than its permission:

1. **No grouped distribution existed on the authorized path.** Every resource declared `aggregates: { groupBy: [], … }`, and `aggregate_resource` rejected any `group_by` outright. So "show me the distribution of blood types" had exactly one destination: `get_patient_stats`, the deliberately k-anonymous statistical RPC.

2. **The statistical tool's suppression language had generalized into a blanket refusal.** The administrative persona's closing paragraph ([prompts/staff.ts:42](../../lib/ai/prompts/staff.ts#L42), before this pass) described the "Other" bucket and `distribution_withheld` without ever naming the tool they belong to, and ended by instructing the model to tell the user *"this grouping cannot be reported for their clinic without identifying individuals."* Read as a general rule — which is how it reads — that sentence covers "what is Ahmed's blood type?" and "list the patients with A-". This is precisely the failure mode plan §11 names: reporting one denial reason for a boundary that lives somewhere else. The prompt was, again, the product bug stated in prose.

### What changed

**Grouped counts on the resource path** — `ResourceAggregates` gains an optional `groups` record, one `ResourceGroupSpec` per `groupBy` key ([resources/types.ts](../../lib/ai/resources/types.ts)). A group spec names **a registered filter key**, not a column, plus a closed bucket domain that is either a declared enum or *another registered resource*. `groupedCountResource` ([resources/compile.ts](../../lib/ai/resources/compile.ts)) then compiles each bucket as an ordinary `countResource` call with that filter applied.

That shape is the whole security argument, and it is why no new predicate surface exists:

- The model names a **registered group key**. It never names a table, a column, an operator, or a bucket value.
- Every bucket is byte-for-byte the query the caller could already issue one filter value at a time.
- A lookup-backed domain (`department_id` → `departments`, `assigned_doctor_id` → `profiles` filtered to active doctors) is resolved through `queryResource`, so the *lookup's own* `assertResourceAccess`, role list, entitlement and RLS apply. A caller who may not read `departments` cannot enumerate department buckets, and no bucket can name a lookup row outside their scope. The narrowing is inherited, never re-implemented.
- `assertResourceAccess` on the grouped resource runs **before** any lookup, so an unauthorized resource never leaks the existence of its groups.
- Fan-out is bounded by `MAX_GROUP_BUCKETS = 40`; a wider domain returns a structured `invalid_aggregate` naming the limit rather than a partial distribution presented as complete.
- Grouping by a key the same call also filters on is refused, because silently overriding the filter would produce a confidently wrong answer.
- The result reconciles honestly: rows in the total but in no listed bucket are reported as such in `notice`, so the model cannot attribute them to a group.

Declared groups today: `patients` × `{blood_type, department_id, assigned_doctor_id}`. The mechanism is generic; other resources declare groups by adding data, not code. `department_id` and `assigned_doctor_id` gained the `is` operator so "patients with no department/doctor yet" is answerable and the null bucket is a real filtered count rather than a subtraction.

**Suppression scope corrected, not removed.** `get_patient_stats` is unchanged as a statistical release: the k-anonymity floor, the generalized `Other` bucket, `grouped_bucket_count` and `distribution_withheld` all still work exactly as Phase P4.6 built them, and a test pins that. What changed is that its result now carries a structured `authorized_alternative` pointer, and the prompt paragraph was rewritten and rescoped.

The pointer names **tools, never data** — a resource id, a group key, and the two tool names to use. It adds no capability and no row: a caller who follows it into `aggregate_resource` or `query_resource` is authorized there by the same gates as always, or denied there with that path's own honest reason. `GROUP_BY_RESOURCE_KEY` maps the statistical vocabulary onto real registry keys as an explicit `satisfies` record, so a renamed key is a compile error rather than a dead-end hint.

**Prompt** — the suppression paragraph moved out of the administrative persona and is now appended to **both** personas from `buildStaffSystemPrompt`, alongside the existing action-safety clause, so the two can never drift on a rule about when an answer may be declined. It is stated positively, bound to `get_patient_stats` by name, and followed by an explicit instruction: when that tool suppresses, answer from the authorized resource path instead of reporting that the information cannot be shown. It names the exact question shapes from the brief. EN and AR both.

**The information boundary is unchanged.** "No diagnosis, treatment recommendation, or drug/dose suggestion" and "never derive a figure by subtraction" both survive verbatim, and a test asserts they do — widening what may be *reported* must not widen what may be *advised*.

### The four brief examples, traced

| Ask | Path |
|---|---|
| "Which patients have O+ blood?" | `query_resource(patients, filters:{blood_type:"O+"})` — already worked; the prompt now stops the model talking itself out of it |
| "Give me the patients with A- blood type." | Same, including when the group is a single patient |
| "What is Ahmed's blood type?" | `search_authorized_patients` → `get_record` / `query_resource` with `fields:["blood_type"]` |
| "Show the distribution of blood types **and** the matching patients." | `aggregate_resource(group_by:"blood_type")` → `query_resource` per bucket — **the new capability** |

**One example is not backed by the data model, and I did not fake it.** "List patients with allergy X" has no allergy field to query: `grep -ril allerg` over the whole repo (excluding `node_modules`) returns **zero** hits — no column on `patients`, no table, no enum, no message key. The nearest honest answer is a substring search of clinical narrative, which already exists as the `medical_notes.note` `ilike` filter with the `patient` relation, and which the assistant will now use rather than refuse. A real allergy capability needs a schema change and is outside this pass; it is flagged in §8.

---

## 2 · Conversation history on the main Assistant

### What was wrong

"New chat" always created a new conversation correctly. What was missing was any way back: `resolveStaffAssistantPage` → `loadLatestDoctorConversation` loaded **the caller's single most recent conversation** (`.limit(1)`), and nothing in the product listed or opened any other. Every earlier conversation stayed in `agent_conversations` with its transcript intact and was unreachable — deleted from the user's point of view, and silently retained from the database's.

### What changed

**No new persistence.** The same `agent_conversations` / `agent_messages` rows the streaming route already writes, read through the caller's own RLS client. No table, no column, no migration. The list's titles are the `title` column `persistDoctorTurn` has always written from the user's own first message.

Two functions in [lib/ai/conversations.ts](../../lib/ai/conversations.ts):

- `listAssistantConversations` — the caller's own active staff conversations, newest first, capped at `CONVERSATION_LIST_LIMIT = 30`, scoped by clinic ∧ owner ∧ persona ∧ status exactly like every other read in the module.
- `loadAssistantConversationById` — one conversation with its persisted history, same scope, returning **null rather than a denial** for an id that is not the caller's, matching the compiler's `unauthorized_scope` contract so the boundary is indistinguishable from not-found.

**Patient-bound conversations are re-authorized against current scope, in both directions.** The single-id assert and the batched list filter now share one extracted predicate, `patientContextAuthorized`, specifically so they cannot drift: a conversation that would fail to *open* must never be *listed*, or the history panel becomes a side channel for the titles of conversations about patients the user has since lost access to. The list resolves all its patient ids in one batched read through the RLS client and drops what no longer resolves. An integration test unassigns a doctor mid-run and asserts the conversation goes from listed-and-openable to neither.

**Two server actions** — [actions/assistant-conversations.ts](../../actions/assistant-conversations.ts) — `listAssistantConversationHistory` and `openAssistantConversation`. Both run `authorizeStaffAssistant()` first, both apply an independent limiter (60/min per user+clinic, fail-open, matching the sibling context actions), both fail soft to a typed reason with Sentry capture that carries no entity ids.

**One UI** — [components/assistant/conversation-history-panel.tsx](../../components/assistant/conversation-history-panel.tsx), owned by `AssistantChat`. Header toggle wired with `aria-expanded` / `aria-controls`, focus restored to the toggle on close, `aria-current` on the active conversation, a translated fallback for untitled chats, a patient-chat marker, honest empty/loading/error states with a retry, and localized timestamps through `useFormatter`. History is fetched only when the panel is opened.

**Resuming a conversation re-declares its own binding.** `SessionState` gained a `pageContext` field. A conversation opened from history carries **its own** patient binding as the session's page context, overriding the host surface's. That is not cosmetic: `ensureDoctorConversation` refuses a turn whose page context disagrees with the stored `patient_id`, so continuing a patient-bound chat from `/assistant` (no page context) or from the appointments sheet would otherwise fail. The browser supplies only the id — the server re-authorizes the patient on every single turn through the same `assertDoctorPatientContextAccess` the patient launcher has always used. It is a restatement of scope, never a grant.

---

## 3 · Contextual "Ask Assistant" launchers

### What was wrong

The launcher was never a separate chat implementation — the Sheet has always rendered the same `AssistantChat`, the same transport, the same `/api/agent/chat`. The defect was subtler and worse: `resolveAssistantLauncherSession` returned `loadAssistantConversationForSurface({ patientId })`, i.e. **the caller's latest conversation**. For every non-patient area that is the conversation with `patient_id IS NULL` — the *same row* `/assistant` was showing. Clicking "Ask Assistant" from the invoices page silently continued whatever unrelated chat happened to be most recent, and the record on screen never entered the conversation at all.

### What changed

**A launcher now opens a new conversation, seeded server-side with the record on screen.** The session route mints a fresh conversation id and returns empty messages plus a `seededActiveContext`.

The seed lives in one new module, [lib/ai/page-context-seed.ts](../../lib/ai/page-context-seed.ts), because that is where the entire risk of this change sits — turning a browser-submitted descriptor into stored context. Its rules:

- Every label is **re-read through the caller's own RLS client**. The browser sends an id; the name comes from the row the database returned.
- Every slot runs the **same tool gate** its equivalent user-choice runs in `actions/assistant-context.ts`: a doctor slot clears `assertAnalyticsToolAccess`, a report slot clears the report's own role list plus the analytics or financial gate.
- A record the caller cannot read produces **no slot at all** — never a slot with an id and a guessed label.
- Slots are `set_by: "page_context"`, the provenance the P4.8 launcher protocol reserved for exactly this, and are advisory in the way `conversation-context.ts` documents: every tool re-authorizes on every call, so a seeded id reaches only what the same user could reach by naming the entity.
- View contexts (dashboard, revenue, invoices, staff, departments, doctor-schedule) describe a page, not a record, and seed **nothing** — inventing a slot would put a chip on screen the user cannot act on. Their advisory prompt line is unchanged.

The chat route applies the same seed when a conversation arrives empty with a page context, through the `ConversationContextRecorder`, **before** the agent runs and ordered so a tool resolution later in the same turn still wins. That is what makes the first question about the right record and what persists the binding for the next turn.

**The shortcut gets the full conversation system.** Because the Sheet renders `AssistantChat`, the history panel arrived with it: from inside any launcher the user can open history, switch to an old conversation, and start another new chat. Starting a new chat from a launcher returns to that shortcut's own record. There is still exactly one conversation/history/state model.

**The patient re-authorization boundary is unchanged and still gates everything after it** — `assertDoctorPatientContextAccess` runs before the seed, and a regression test asserts that ordering against the source.

---

## 4 · Files changed

**Production — modified (9)**

| File | Change |
|---|---|
| [lib/ai/resources/types.ts](../../lib/ai/resources/types.ts) | `ResourceGroupDomain`, `ResourceGroupSpec`, `aggregates.groups`, `ResourceGroupBucket`, `ResourceGroupedCountResult` |
| [lib/ai/resources/compile.ts](../../lib/ai/resources/compile.ts) | `groupedCountResource`, bucket domain resolution, `MAX_GROUP_BUCKETS` |
| [lib/ai/resources/definitions/patients.ts](../../lib/ai/resources/definitions/patients.ts) | three group specs; `is` operator on `department_id` / `assigned_doctor_id` |
| [lib/ai/tools/aggregate-resource.ts](../../lib/ai/tools/aggregate-resource.ts) | `group_by` routing; description rescopes suppression and points at the authorized path |
| [lib/ai/tools/describe-capabilities.ts](../../lib/ai/tools/describe-capabilities.ts) | projects group metadata explicitly (no server-owned column/filter names) |
| [lib/ai/tools/get-patient-stats.ts](../../lib/ai/tools/get-patient-stats.ts) | `authorized_alternative` pointer + `GROUP_BY_RESOURCE_KEY` |
| [lib/ai/prompts/staff.ts](../../lib/ai/prompts/staff.ts) | suppression-scope clause, EN + AR, appended to both personas |
| [lib/ai/conversations.ts](../../lib/ai/conversations.ts) | `listAssistantConversations`, `loadAssistantConversationById`, `patientContextAuthorized` |
| [lib/ai/launchers.ts](../../lib/ai/launchers.ts) | session returns a seeded new conversation instead of the latest one |
| [app/api/agent/launcher-session/route.ts](../../app/api/agent/launcher-session/route.ts) | fresh conversation id + seeded context payload |
| [app/api/agent/chat/route.ts](../../app/api/agent/chat/route.ts) | seeds page context on an empty conversation's first turn |
| [components/assistant/assistant-chat.tsx](../../components/assistant/assistant-chat.tsx) | session-owned page context, history state, panel wiring |
| [components/assistant/assistant-launcher.tsx](../../components/assistant/assistant-launcher.tsx) | documentation of the shared-system contract |
| [messages/en.json](../../messages/en.json), [messages/ar.json](../../messages/ar.json) | 12 history keys each |

**Production — new (3)**

- [lib/ai/page-context-seed.ts](../../lib/ai/page-context-seed.ts)
- [actions/assistant-conversations.ts](../../actions/assistant-conversations.ts)
- [components/assistant/conversation-history-panel.tsx](../../components/assistant/conversation-history-panel.tsx)

**Tests — new (6 files, 89 tests)**

| File | Tests |
|---|---|
| `tests/unit/ai/post-plan-authorized-patient-detail.test.ts` | 23 |
| `tests/unit/ai/post-plan-conversation-history.test.ts` | 9 |
| `tests/unit/ai/post-plan-page-context-seed.test.ts` | 14 |
| `tests/unit/actions/post-plan-assistant-conversations.test.ts` | 10 |
| `tests/unit/components/post-plan-conversation-history-ui.test.tsx` | 14 |
| `tests/unit/integration/post-plan-product-completion-rls.test.ts` | 14 |
| `tests/e2e/post-plan-conversation-history.spec.ts` | 3 (multi-step) |

**Tests — corrected (5 files).** Each asserted behaviour this pass deliberately changed; all were **rewritten to assert the new invariant**, none deleted:

| File | Change |
|---|---|
| `tests/unit/ai/phase1-resource-tools.test.ts` | aggregate description assertions updated; new test that the re-route instruction is present |
| `tests/unit/ai/p48a-launchers.test.ts` | `loadAssistantConversationForSurface` → `resolvePageContextSeed` throughout; seeded-session assertions; fail-closed gates now assert the seed is not reached |
| `tests/unit/api/p48a-launcher-session-route.test.ts` | asserts a fresh seeded session; **new** test that each open mints a distinct id |
| `tests/unit/api/p4b-chat-route.test.ts` | chainable supabase stub; **three new** tests for first-turn seeding, no re-seed with history, and no seed for an unreadable record |
| `tests/unit/ai/p49b-scope-and-patient-launcher.test.ts` | re-authorization must still precede the seed; asserts the launcher no longer resumes the latest conversation |

---

## 5 · Tests and results

All run against this working tree on 2026-08-16, local Supabase healthy, keys from `supabase status -o env` per project convention.

| Gate | Command | Result |
|---|---|---|
| Production build | `pnpm build` | ✅ **PASS** — exit 0, 83/83 static pages |
| Typecheck | `pnpm typecheck` | ✅ **PASS** — exit 0, no diagnostics |
| Full unit suite | `pnpm test` | ✅ **PASS** — **368 files, 2 922 tests, 0 failures** (was 363 / 2 852) |
| Integration / RLS | `pnpm test:integration` | ⚠️ **1 failure, pre-existing and unrelated** — 55 passed, 1 skipped; **501 passed, 1 failed, 3 skipped** (was 55 / 488). See §7 |
| Adversarial / eval | `pnpm test:ai-adversarial` | ✅ **PASS** — 2 files, 136 tests (unchanged) |
| Ops suite | `pnpm test:ops` | ✅ **PASS** — 3 files, 20 tests |
| Lint | `pnpm lint` | ✅ **PASS** — exit 0, **0 errors, 28 warnings** (identical to baseline) |
| i18n parity | `pnpm i18n:missing` | ✅ **PASS** — 4 000 base leaf messages (was 3 988; +12 history keys) |
| i18n unused gate | `pnpm i18n:unused` | ✅ **PASS** — no unreferenced keys |
| i18n source gate | `pnpm lint:i18n` | ✅ **PASS** — 441 files, 43 documented exceptions |
| RTL gate | `pnpm lint:rtl` | ✅ **PASS** — 682 files, 17 documented exceptions |
| Assistant E2E | `PORT=3100 playwright test post-plan-conversation-history p4b-assistant phase5f-privileged-actions --workers=1` | ✅ **PASS** — **7/7** (1.1 min) |
| Whitespace | `git diff --check`, `git diff HEAD --check` | ✅ **PASS** — exit 0 both |

### What the new coverage actually pins

**Change 1** — exact unsuppressed distribution including a bucket of one; tenant predicate and base filters on every bucket query; lookup domains resolved through the referenced resource's own gates; unregistered group key rejected with the valid list; group-and-filter-on-the-same-key refused; over-wide domain refused rather than truncated; feature denial before any lookup read; parity across all five roles; honest reconciliation notice; `describe_capabilities` leaks no column or filter name; a registry invariant asserting every group key has a spec on a registered filter, that `includeNull` implies the `is` operator, and that **every enum bucket value parses against its own filter's schema**; the statistical tool's suppression still intact; both personas' prompts in both locales, with the removed false generalization asserted absent and the information boundary asserted present.

**Change 2** — list scoping filters asserted against the query actually issued; another user's and another tenant's conversations absent from the list and null on open; `agent_messages` refused at the database for a known cross-tenant conversation id; patient re-authorization before any message is read; a doctor losing a patient mid-test loses both the open *and* the listing; limiter before store read; non-uuid and over-specified payloads rejected before authorization.

**Change 3** — seed provenance (RLS re-read, tenant predicate, soft-delete filter), gate-denied slots, no-slot-for-view-contexts with zero reads, round-trip through the real `activeEntitySchema` parser; route-level first-turn seeding, no re-seed with history, no seed for an unreadable record; distinct conversation id per launcher open; re-authorization ordering pinned against source.

**Both, at the render** — history reachable in *both* page and sheet mode from the same component, open/switch/new-chat inside the shortcut, resumed conversation re-keys the chat, stale entry refreshes rather than errors, host record's name stops showing once a different conversation is resumed, `aria-expanded`/`aria-controls`/`aria-current` and focus return.

**E2E** — real browser, real database, both locales, Axe sweep at the same critical/serious budget as the capability panel.

---

## 6 · Confirmation that prior guarantees remain intact

Each item re-verified against this tree, not taken on trust from the prior reports.

| Guarantee | Status |
|---|---|
| **RLS and tenant isolation** | ✅ Every new read path uses `createClient()` (the RLS session client). `groupedCountResource` compiles each bucket through `countResource` → `compileResourceQuery`, so the injected `.eq(clinic_id, user.clinicId)` tenant predicate and the resource's base filters apply to every bucket — asserted by unit test and by an integration test that requests another tenant's clinic id and gets zero. Conversation history is clinic ∧ owner ∧ persona ∧ status scoped, proven at the database boundary. |
| **No service-role client in the AI path** | ✅ `tests/unit/security/admin-client-static-guard.test.ts` walks `actions`, `app`, `components`, `hooks`, `lib` recursively and passes. The three new production modules import no admin client. |
| **Plan entitlements** | ✅ Untouched. `assertResourceAccess` runs before any bucket enumeration, so a missing `ai.read_operational` denies with zero queries issued (asserted). `grep -rn "pro_ai" lib/` still returns zero hits. |
| **Role / action authorization** | ✅ No role list changed anywhere. Grouping is available exactly where the `patients` resource is; a lookup domain inherits the lookup resource's roles. `ACTION_CAPABLE_ROLES` and the whole action registry are untouched. |
| **Confirmation and reauthentication** | ✅ Untouched. No new write path exists — every new server function is a read. `phase5f-privileged-actions.spec.ts` passes end to end, including the password step-up. |
| **Receipts / audit** | ✅ `aggregate_resource` still writes `logAgentTool` on success and on `invalid_aggregate`, now including the `group_by` key. `ai_action_receipts` is untouched. |
| **Token replay protection** | ✅ Untouched. Confirm-token HMAC, single-use claim, TTLs, privileged binding, and `pendingActionConfirmations` all unmodified; the context seeding path folds into `active_context` through `applyProposals`, which preserves `pending_confirmations` via `withPendingActionConfirmations`. |
| **Privileged-action safeguards** | ✅ Untouched. No privileged surface is reachable from anything added here; the seed writes only `patient` / `staff` / `report` slots, all advisory. |
| **Document / export protections** | ✅ Untouched. `resourceExportSuggestion` and its `roleMountsActionTools` check are unmodified; the new grouped result is not an export path and is bounded at 40 buckets. |
| **Persisted tool / context behaviour** | ✅ `lib/ai/conversation-parts.ts` unmodified. The seed uses the existing `ConversationContextRecorder`, ordered so a tool resolution later in the turn still wins; a conversation with history is never re-seeded (asserted). |
| **`national_id` explicit-only (§19 decision 2)** | ✅ Untouched and still asserted by the Phase 1 suite. It is not a group key, and grouped counts return no fields at all. |
| **k-anonymity on the statistical path (D-2)** | ✅ `ai_get_patient_stats` and its floor are unmodified; a test asserts a suppressed bucket still returns `suppression_reason: "aggregated"`. The plan's §7.4 rationale — *"a clinic user listing records they are authorized to read is not treated as a statistical disclosure"* — is what change 1 extends from one cell to the set of cells. See §8 for the deviation record. |
| **Injection containment** | ✅ `pnpm test:ai-adversarial` green at 136 tests. `harden()` sanitizes at the mount boundary, so the grouped result is covered by construction; bucket labels come from tenant-authored rows and pass through the same `sanitizeUntrustedDeep`. The model cannot name a bucket value, only a registered key. |
| **Normal UI behaviour** | ✅ 2 922 unit tests, 501 integration tests, clean build, clean typecheck, clean lint, clean i18n and RTL gates. |

---

## 7 · Deviations and unresolved issues

**One integration failure, pre-existing and unrelated — not fixed, and deliberately not "fixed" by touching your data.**

`tests/unit/integration/dev-clinic-pro-ai-entitlement.test.ts` fails a single assertion:

```
× exists exactly once, on the pro_ai plan, with an allowed subscription and accepted AI terms
  expected [ "caf2711f-…", "93000000-…" ] to equal [ "93000000-…" ]
Tests  1 failed | 21 passed (22)
```

The local database holds **two** clinics named *Health Care Pro*: the seeded fixture (`93000000-…`) and a second row `caf2711f-97cb-4474-a103-f9505f467087` created at `2026-05-06`. Both that test file and `scripts/seed-dev-clinic.ts` are untracked artifacts of yesterday's fix pass and are outside this pass's diff; nothing added here writes a `clinics` row (the new integration test creates only `Post Plan Clinic …` rows with random ids and deletes them). The other 21 assertions in the file — including every SQL and TS entitlement resolution — pass.

This is local dev-database state, not a code regression. Deleting the stray row is a destructive change to your data and your call, not mine; the fix is one `delete from clinics where id = 'caf2711f-…'` once you have confirmed it is disposable.

**Accepted deviation — grouped counts are exact where the statistical tool suppresses.** Plan §7.4 and review D-2 record that `aggregate_resource` applies no k-anonymity to *single-cell* counts, and that DB-side suppression is retained for *grouped* patient-attribute distributions via `ai_get_patient_stats`. This pass extends the exact-count rule from one cell to the set of cells on the resource path. That is a deliberate deviation from §7.4's letter, and it follows §7.4's own stated rationale: each bucket is a count the caller already gets one filter at a time, over rows `query_resource` returns in full, so suppressing the assembled view while publishing every one of its parts protects nothing and is what produced the false denials. The statistical path keeps its floor and stays the right tool for a statistical release. Recorded here rather than silently absorbed, because it changes an invariant a prior review approved.

**Not delivered — "List patients with allergy X" as a structured query.** No allergy field exists anywhere in the schema (§1). The assistant will now answer it from `medical_notes.note` substring search where a clinician recorded it in narrative text, which is honest but not equivalent to a structured field. A real capability needs a `patients` column or an allergies table, a UI to populate it, a migration, and a registry field + filter + group spec — all of which are schema and product scope beyond this pass.

**Untouched from the prior review, as scoped.** NB-1 (`taskClasses` inert on non-help turns, and an out-of-range class would mount zero tools) through NB-5 (assistant E2E not parallel-safe locally) remain open exactly as written. NB-1 is still the one worth scheduling next. NB-5 still applies — the E2E runs above used `--workers=1`.

**One thing to know about manual QA.** `.env.local` points `NEXT_PUBLIC_SUPABASE_URL` at the remote dev project, so `pnpm dev` talks to that project, not local Supabase. Everything above was verified locally; per the instruction, no remote change was made and nothing was verified against remote. Also note NB-3: `getEntitlements` caches for 5 minutes, so an entitlement change can take that long to show in the app.

---

## 8 · Manual QA suggestions

1. `/assistant` → send a message → **New chat** → **History** → the previous conversation is listed and reopens with its transcript.
2. From a patient profile → **Ask about patient** → the sheet opens empty with the patient chip already set → ask "what is their blood type?" → **History** inside the sheet → switch to an older chat → **New chat** returns to the patient.
3. As a clinic owner: *"Show me the distribution of blood types and the matching patients."* Expect an exact distribution, then the names per group — including a group of one.
4. As a receptionist and as a doctor, repeat (3): both should answer, the doctor scoped to their own patients.
5. Confirm `ai_action_receipts` is unchanged (no new rows from any of the above — these are all reads) and that `audit_logs` carries `agent_tool:aggregate_resource` entries with the `group_by` key.
