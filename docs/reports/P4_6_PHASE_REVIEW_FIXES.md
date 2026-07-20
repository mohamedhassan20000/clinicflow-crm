# P4.6 Phase Review — Implementation of Fixes

**Phase:** P4.6 (C + A + B, treated as one feature)
**Input:** `docs/reviews/P4.6_PHASE_REVIEW.md` (Comprehensive Phase Review #1, 2026-07-20)
**Date:** 2026-07-20
**Scope:** every actionable finding — 1 High, 7 Medium, 13 Low, and the applicable Informational items. No review report was modified. P4.7 was not started.

---

## 1. Summary

All 21 actionable findings are closed. Three of them were closed by recording a decision rather than changing behavior (M6, L3, L13), and one review assumption was **empirically tested and found correct**, so the implementation was preserved unchanged and the evidence recorded instead (L1). Two Informational items required a correction to a previous report's wording (I3) and confirmation of an unverified premise (I4).

| Severity | Findings | Behavior changed | Recorded only |
|---|---|---|---|
| High | H1 | 1 | 0 |
| Medium | M1–M7 | 6 | 1 (M6) |
| Low | L1–L13 | 9 | 4 (L1, L3, L8 partly, L13) |
| Info | I3, I4 | — | 2 |

New migration: `20260720150000_p46_phase_review_fixes.sql`.
New runbook: `docs/runbooks/P4_6_MIGRATION_DEPLOYMENT.md`.
New test suite: `tests/unit/ai/p46-phase-review-fixes.test.ts` (27 tests), plus additions to six existing suites.

---

## 2. H1 — `run_clinic_report` advertised a report it would refuse, over a transport the UI could not classify

The review correctly identified this as a **seam defect**: three individually correct components meeting where a coarser gate let a promise reach the model that a finer gate would refuse. The fix is applied at all three seams rather than only at the one that surfaced.

**1. The description no longer lies.** `allowedReportsForRole(role, { financialGranted })` now filters financial reports out of the advertised list when the caller holds no grant. The grant reaches the tool through a new `DoctorToolContext.grantedPermissions`, resolved once at mount time in `resolveToolMount`.

Rather than resolving every permission key for every caller (which added a needless financial-permission read to every doctor's mount, and broke three P4A tests by consuming a stubbed query), the registry now declares the dependency explicitly:

```ts
// lib/ai/tools/registry.ts — run_clinic_report
describedByUserPermissions: ["ai.financial_insights"],
```

`resolveToolMount` resolves the union of `requiredUserPermission` and `describedByUserPermissions` across mount candidates. This is presentation metadata only, and is documented as such at both the declaration and the consumption site.

**2. The denial is now presentable.** For the two *user-actionable* states — `permission_not_granted` and `feature_not_entitled` — `run_clinic_report` returns a structured result instead of throwing:

```ts
{ permission_denied: true, reason, report, guidance }
```

`role_forbidden` still throws, deliberately: it is a wiring bug, not a state a user can act on. The reason is derived by running the *real* gate (`financialDenialReason` calls `assertFinancialInsightsAccess` and inspects what it raised) rather than re-deriving the conditions, so a drifted second copy of the gate is not possible. Any other reason — including `lookup_failed`, which must fail closed and loudly — propagates unchanged.

**3. The mid-stream transport carries the reason.** `route.ts`'s `onError` now returns `error.reason` for an `AiToolAuthorizationError` instead of the fixed sentence.

> **Correction (phase review #2, H2 / I3).** The sentence that stood here — that this "is what makes the client's `permission_not_granted` branch reachable at all" — rested on a premise that is false for `ai@6`. A tool `execute()` throw is converted to a `tool-error` content part and reaches the client as a `tool-output-error` chunk, which never sets `useChat`'s `error`. `onError` does run, but as the *formatter* for that part's `errorText`, so the reason code travelled to a place the UI then discarded. The `onError` change is still correct and still load-bearing — it is what puts a classifiable code on the tool part — but it did not make the error banner reachable, and fixes #3 and #4 as originally described were not sufficient on their own. See `docs/reports/P4_6_PHASE_REVIEW_CYCLE2_FIXES.md`.

**4. The client mapping is no longer a string chain.** The route's `ErrorCode` union moved to `lib/ai/errors.ts` as `AssistantErrorCode` (that module is dependency-free and deliberately carries no `server-only` marker), and the chat component keys a `Record<AssistantErrorCode, string>` off it. A renamed or newly added reason is now a compile error rather than a silent fall-through to "something went wrong" — which is precisely how this finding came to exist.

**5. The returned denial renders as a notice.** `summarizeToolResult` emits a `permission_denied` notice, and the tool card renders the same localized copy the pre-stream path uses.

**Tests:** 6 tests in `p46-phase-review-fixes.test.ts` (description filtering across three roles and both grant states, structured denial, entitlement-vs-permission distinction, role denial still throwing), 2 in `p46b-tool-presentation`-adjacent presentation coverage, 2 in `p4b-chat-route.test.ts` (the reason code is emitted; a genuine stream failure still gets a sentence), 4 in `p46b-assistant-analytics-ui.test.tsx`.

---

## 3. Medium findings

### M1 + M2 — the database layer knew about roles, but not about grants or entitlements

Both closed in `20260720150000_p46_phase_review_fixes.sql`, inside `ai_assert_analytics_caller` — the single guard all five aggregate RPCs pass through, so no call site can forget either check.

- **M2 (entitlement):** every scope now requires `effective_ai_feature(clinic, 'ai.staff_analytics')`; the financial scope additionally requires `ai.financial_insights`. `effective_ai_feature` is the same authoritative resolution the application reads (plan features → clinic overrides → subscription/trial state), so the two layers cannot disagree. It is internal-only (revoked from every role), which is exactly why it must be called from a `SECURITY DEFINER` guard.
- **M1 (per-user grant):** the financial scope now requires a `granted` row in `user_ai_permissions` scoped to the caller's re-resolved clinic, for any role other than `admin`. This mirrors `IMPLICIT_PERMISSION_ROLES` and `hasAiUserPermission` in `lib/ai/permissions.ts`, including its fail-closed behavior — no row means no grant.

**On I4 (the review did not execute SQL).** The review flagged that its claim about direct PostgREST reachability should be confirmed empirically before acting on it. It was, and it is correct: the existing P4.6A integration suite already calls `ai_get_clinic_summary` and `ai_get_patient_stats` over `POST /rest/v1/rpc/...` with an ordinary signed-in user's token and receives data. Direct reachability is not a theoretical inference — it is the mechanism an existing passing test depends on.

**Fixture consequence.** The P4.6A integration fixture previously created clinics with *no subscription at all*, which the role-only guard did not care about. It now provisions `pro_ai` for clinics A and B and a third `basic` clinic for the M2 denial tests. Nine new integration tests assert both gates at the database boundary, with the application removed from the picture entirely — including that an admin never needs an explicit grant, and that a cross-clinic grant row is both unwritable (composite FK) and unhonored (clinic re-resolution) if it somehow existed.

### M3 — the audit ledger recorded successes, not invocations

Closed centrally in the `harden()` mount wrapper (`lib/ai/tools/index.ts`) rather than per tool, because the placement — not the redaction — was the defect, and a per-tool convention would be one forgotten call away from a gap in the next tool.

Three previously invisible classes now write an audit row: **denials** (thrown `AiToolAuthorizationError`, and the new structured `permission_denied` result), **clarifications** (`needs_clarification`), and **query errors**. The success path is deliberately left to the tool itself, which has the redacted parameter detail the wrapper cannot see — a test asserts a successful invocation is not double-logged.

### M4 — the migrations take a write-blocking lock on `patients`

This is a deployment-process finding, not a code defect, so it is closed where it belongs: `docs/runbooks/P4_6_MIGRATION_DEPLOYMENT.md`, plus explicit `⚠ OPERATIONAL NOTE` blocks at the three blocking statements in migrations `…120000` and `…140000`.

The runbook covers the row-count threshold for deciding whether a window is needed, the `lock_timeout`/`statement_timeout` procedure, the manual `CREATE INDEX CONCURRENTLY` variants (with the invalid-index check that must follow them), verification queries, and why rollback is not the right response to a mid-deploy failure.

The generated-column rewrite cannot be made non-blocking — a `STORED` column requires rewriting every row — so it is documented rather than "fixed". The index builds are left as plain builds in the migrations, because `CONCURRENTLY` cannot run inside the transaction block the Supabase runner wraps each migration in; the runbook gives the manual alternative for operators who need it.

### M5 — fuzzy search materially increased PHI egress to the model provider

`search_authorized_patients` now returns full `phone` and `email` **only for a single high-confidence match**. In a candidate list — the low-confidence path, which is both the one that returns the most candidates and the one the contract designs to show them all to the user — the phone is masked to its last four digits and email is withheld, with `contact_details_withheld: true` on the payload and the behavior stated in the tool description.

Identity (`full_name`, `file_number`) is untouched, because that is what a user actually disambiguates on. This is a volume change, not an authorization change: every candidate was and remains RLS-authorized for that caller.

### M6 — the task-class gate is enforced but inert (recorded, not changed)

Deliberately **not** changed. The review's own reading is right: the gate works, and nothing it could exclude is reachable today, because every P4.6 tool declares both administrative classes and `staffTaskForRole` returns one of exactly those two for every non-doctor role. Narrowing a class now would be inventing a constraint to satisfy a test.

What was missing was the record and the mechanical proof, both added:

- A prominent comment at the `taskClasses` declarations in `registry.ts` states plainly that the gate excludes nothing today, names the two sub-phases that must not assume otherwise (**P4.7's cheap `staff_help` class, P4.11's workflow steps**), and says that the first entry declaring a genuinely narrower class is what makes it real.
- Two tests assert the mechanism on a synthetic mount (a `staff_clinical_summary` turn excludes the P4.6 tools and keeps the shared ones), with a comment saying explicitly that this is the mechanism and not a production path — the distinction M6 says must not be confused.

### M7 — central sanitization silently truncated and reflowed every string

Caps are now field-aware. Identity-ish keys (`*_name`, `label`, `bucket`, `display`, `file_number`, `phone`, `email`, `status`, …) keep the tight 200-character cap; everything else — including everything `run_clinic_report` passes through from `lib/reports/data.ts` — gets 2,000. Matching is on the **key**, which we author, never on the value, which tenants author.

Truncation is also no longer silent: `sanitizeUntrustedDeep` takes an `onTruncate` callback, `harden()` collects the dotted paths, and a non-empty set is surfaced as `text_truncated_fields` on the result and rendered as a user-visible notice. The centralization decision the review endorsed is unchanged.

---

## 4. Low findings

| ID | Resolution |
|---|---|
| **L1** | **Verified, not changed — see §5.** |
| **L2** | `20260720120000` now uses `if not exists` on both `add column` and both `create index` statements, matching the other three migrations in the phase. |
| **L3** | Recorded, not changed. A comment at `user_ai_permissions_user_key_idx` now names which of the three overlapping mechanisms is load-bearing: **the composite FK is the real control**; the clinic-leading PK is a modelling correction; the unique index closes the squat only as a side effect of being a lookup index, and is the one a future multi-clinic user model would have to drop. |
| **L4** | New `FinancialCapabilityState` member `"unavailable"`, with its own copy. The old `"not_entitled"` answer told users their plan was the problem when it was not, and the comment justifying it was wrong on its own terms: `resolveStaffAssistantPage` only resolves capabilities once access is already `"available"`, so the surface gate has by definition passed and reports nothing. |
| **L5** | Both list tools fetch `cap + 1` and return `cap`. A clinic with exactly 50 appointments (or exactly `limit` outstanding balances) is no longer told its list was cut short. `list_outstanding_invoices` also now reports `row_cap` as the *effective* limit rather than the constant. |
| **L6** | `ReportDefinition.acceptsDoctor`. `followups` and `receptionist_performance` no longer resolve a doctor filter at all, so they cannot raise an ambiguity clarification about a filter that could not have changed the answer. The result carries `doctor_filter_supported` / `doctor_filter_applied`, and the input schema's description names which reports use it. |
| **L7** | `withProvenance` reserves rather than overwrites — a tool that sets its own `data_provenance` keeps it. Payloads that carry no tenant records (a candidate-free clarification, a denial) get a `system_generated:` marker instead of being framed as "records entered by clinic staff". A clarification that *does* carry tenant names keeps the tenant framing, which a test pins. |
| **L8** | Recorded and pinned. Four property tests assert the transliteration fallback is strictly additive: it never returns the query itself, never returns an empty variant, never changes the token count, and never touches the primary normalized query. The docblock states that the table is a curated regional list needing extension as the tenant base broadens — which these tests now make safe to do incrementally. |
| **L9** | The four `search_*_ranked` functions now `revoke all … from public` before granting to `authenticated`, matching every other function in the phase. No behavior change (they are `SECURITY INVOKER`, so RLS was always authoritative and `anon` always saw nothing) — it removes an inconsistency inside one feature that would otherwise get copied. |
| **L10** | `listStaffAiPermissions` / `setStaffAiPermission` take `AiUserPermissionKey`, not `string`. Permission keys moved to a new dependency-free `lib/ai/permission-keys.ts` so the client settings panel can import the same constant (`lib/ai/permissions.ts` is `server-only`). The settings page now passes `AI_FINANCIAL_INSIGHTS_PERMISSION` instead of the entitlement constant it had been passing by coincidence. The runtime guard stays — a server action is a network boundary — and its tests now cast deliberately, with a comment saying why. |
| **L11** | Both actions require the **primary** clinic admin, matching the page that hosts them. New `ai-permissions.primaryAdminOnly` error copy (ar + en). Three tests cover refusal on both the read and write paths and the primary admin passing. |
| **L12** | `AiFinancialPermissions` takes a `loadError` prop and renders it as its own state. A failed lookup no longer renders as an empty list, which was indistinguishable from "this clinic has no managers to grant". |
| **L13** | Recorded, not changed. A comment at the scoring `case` explains that an 8-digit phone suffix scores 1.0 across country codes, that the *outcome* is safe because `classifyConfidence` requires a lead as well as a score, and that `score` must be read as "how strong is this match kind", not "how sure are we this is the person". An integration test inserts two patients sharing a national number under `+965`/`+966` and asserts both score 1.0 and that confidence is not `high`. |

---

## 5. L1 — a review assumption tested and found correct; implementation preserved

The review asked that behavior inferred from code rather than empirically verified be validated before being changed, and that if the implementation proved the assumption wrong, the implementation be preserved and the evidence recorded. That is what happened here.

L1 questioned whether the `%` / `<%` sargable prefilter in `search_patients_ranked` is genuinely equivalent to the `>= 0.18` score filter — noting the equivalence depends on pg_trgm's operators comparing `>=` rather than `>` against the threshold, and on the `SET`s applying inside the CTE.

**Both premises are correct, and the implementation is right.** Verified directly against local Postgres over a 20,400-row synthetic corpus, comparing the prefiltered set against an unfiltered scoring pass, across eight query shapes including degenerate ones:

| Query | Expected rows | Prefiltered rows | Missing | Extra |
|---|---|---|---|---|
| `mohamed hassan` (+ Arabic alt) | 5,100 | 5,100 | 0 | 0 |
| `Mohammad H. Hassan` | 5,100 | 5,100 | 0 | 0 |
| `Muhammad Hasan` | 6,800 | 6,800 | 0 | 0 |
| `siobhan` | 1,700 | 1,700 | 0 | 0 |
| `zzzzzzzz` | 0 | 0 | 0 | 0 |
| `a` | 3,400 | 3,400 | 0 | 0 |
| `john` | 1,700 | 1,700 | 0 | 0 |
| `layla saleh 42` | 1,711 | 1,711 | 0 | 0 |

**No code was changed.** What was missing was durability, so three integration tests now run through the real RPC and assert the observable halves: misspellings (transposition, deletion, insertion) still return rows through the `name_fuzzy` branch — a narrowed prefilter would return nothing for them — no fuzzy row ever scores below the 0.18 floor, and a query matching nothing returns nothing rather than everything.

The full row-for-row equivalence check cannot live in the repo's test suite without adding a test-only function to a production migration, which is a worse trade than recording the evidence here.

A second, smaller assumption was also tested and found wrong — but in the test, not the code. A case-only query variant (`p46a patient`) resolves through the **prefix** branch, not the fuzzy one; the first draft of the L1 test asserted otherwise. The test was corrected and now covers both branches separately.

---

## 6. Informational

**I3 — implementation-report accuracy.** The review's one accuracy note was that P4.6B's claim *"roles that can never hold the financial grant are told nothing at all"* is true of the capability notice but was contradicted by H1, since managers without the grant were still told via the tool description that they could run the revenue report. `docs/reports/P4_6B_IMPLEMENTATION.md` is corrected to scope the claim to the capability notice and to point at the H1 fix that makes it true of the tool description as well.

**I4 — direct RPC reachability.** Confirmed empirically; see §3 (M1 + M2).

**I1 / I2** — no action required. The new migration is `…150000`, which sorts after `…140000` and preserves the documented ordering the review asked not be renumbered.

---

## 7. An unrelated defect found and fixed during validation

`tests/unit/ai/p4a-doctor-tools.test.ts`'s `check_availability` test asked for 09:00–09:45 slots **on the current date** with a real clock, and `check_availability` correctly drops elapsed slots. It passed only when the suite happened to run before 09:00 local, and began failing every morning thereafter — including during this work, at 10:47.

This is why the phase review reported 248 passing tests and a later run did not: the review ran earlier in the day. The clock is now frozen for that test. Not a P4.6 finding, but recording it so the discrepancy between the review's test count and any later one is not mistaken for a regression from these fixes.

---

## 8. Validation

| Check | Result |
|---|---|
| `supabase migration up --local` | ✅ `20260720150000` applied cleanly |
| `pnpm typecheck` | ✅ clean |
| `pnpm lint` | ✅ 0 errors (25 pre-existing warnings, unchanged) |
| `pnpm test` (unit) | ✅ **179 files, 1,159 tests** |
| `pnpm test:integration` | ✅ **22 files, 220 tests** |
| `pnpm build` | ✅ compiled successfully |
| `pnpm i18n:missing` | ✅ 2,729 base leaf messages, locale parity valid |
| `pnpm lint:i18n` | ✅ no hardcoded user-facing strings |

Test count moved from 1,116 → 1,159 unit (+43) and 211 → 220 integration (+9). No test was deleted, and no assertion was weakened to accommodate a change: the six existing assertions that moved (row caps at `cap + 1`, the thrown-vs-returned financial denial, the field-aware sanitization caps, and the M5 masking in two live-RLS suites) each moved *because* the behavior they described was the defect.

---

## 9. What is deliberately still open

- **M6's underlying condition.** The task-class gate remains inert for P4.6 by design. P4.7 and P4.11 must not assume it constrains anything until a registry entry declares a genuinely narrower class.
- **The `user_page_permissions` shape.** P4.6A's migration header already notes that the pre-existing table carries the unconstrained shape `user_ai_permissions` deliberately diverged from. Hardening it is a follow-up outside P4.6's scope.
- **M4 is documented, not automated.** The lock window is a real operational cost on the first sizeable tenant. The runbook makes it plannable; it does not make it disappear.

P4.7 was not started.
