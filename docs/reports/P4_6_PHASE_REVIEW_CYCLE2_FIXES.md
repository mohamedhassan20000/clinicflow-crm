# P4.6 Comprehensive Phase Review #2 — Implementation of Fixes

**Phase:** P4.6 (C + A + B, treated as one feature)
**Input:** `docs/reviews/P4.6_PHASE_REVIEW_CYCLE2.md` (Comprehensive Phase Review #2, 2026-07-20)
**Date:** 2026-07-20
**Scope:** every actionable finding — 2 High, 3 Medium, 8 Low, and the applicable Informational items. No review report was modified. P4.7 was not started.

New migration: `20260720160000_p46_phase_review_cycle2_fixes.sql`.
New test suites: `tests/unit/ai/p46-tool-error-transport.test.ts` (7 tests, real SDK transport), `tests/unit/integration/p46-ai-permissions-rls.test.ts` (13 tests, live PostgREST).

---

## 1. Summary

All 13 actionable findings are closed. One (L6) was a naming/shape correction with no behavior change; the rest changed behavior, copy, schema, policy, or the runbook.

| Severity | Findings | Behavior changed | Recorded / doc only |
|---|---|---|---|
| High | H1, H2 | 2 | 0 |
| Medium | M1, M2, M3 | 3 | 0 |
| Low | L1–L8 | 6 | 2 (L1 runbook, L6 cosmetic) |
| Info | I3 | — | 1 |

**The review named a root cause and it is the right one:** all three of its leading findings were fixes validated against a *model* of the system rather than the system. That framing drove how these fixes were verified, and the verification is the substantive part of this report. Every claim below was executed, not reasoned:

- H1 was checked by calling the RPC against real fixtures including the exact 200-vs-3 asymmetry the review reproduced, plus a partial-suppression shape the old fixtures could not express.
- H2 was checked by driving a real throwing tool through real `streamText` → real `toUIMessageStreamResponse` → real `readUIMessageStream`. No callback is invoked directly anywhere in the new suite.
- M1 was checked with real signed-in user tokens over `POST /rest/v1/user_ai_permissions`, reproducing the review's two-call bypass and confirming it now fails at call one.

---

## 2. H1 — complementary suppression labelled above-floor buckets `"<5"`

`supabase/migrations/20260720160000_…sql`, `lib/ai/tools/get-patient-stats.ts`, `lib/ai/prompts/staff.ts` (both locales), `lib/ai/tool-presentation.ts`, `components/assistant/assistant-chat.tsx`, `messages/{ar,en}.json`

The review's diagnosis is exactly right and the distinction it drew is the fix. The suppression *construction* — primary suppression below the floor, then complementary extension until at least two buckets are hidden and their sum reaches the floor — is sound privacy mathematics and is **preserved byte-for-byte**. Only the rendering changed.

**1. Suppression now says why.** The emit loop tracks `v_below_floor` separately from `v_suppressed`, and every bucket carries `suppression_reason`:

| Reason | `display` | Meaning |
|---|---|---|
| `below_floor` | `"<5"` | Genuinely below the floor. The claim is true. |
| `complementary` | `"hidden"` | Hidden only to protect the sub-floor buckets. May be arbitrarily large, so **no** numeric claim is made. |
| `null` | the count | Visible. |

The payload also carries `suppressed_below_floor_count` and `suppressed_complementary_count`, so the model and the UI can each state the split without re-deriving it.

**2. A fully suppressed distribution is declined, not emitted.** The review asked explicitly whether the terminal case should be answered or refused. It is refused: `distribution_withheld: true`, `distribution_withheld_reason: "all_buckets_suppressed"`, and `buckets_all_time: []`. Emitting bucket *labels* with null counts alongside a rounded total was the shape that made an information-free payload look like data — and it published "this clinic has A+ patients" for nothing in return.

This is worth stating plainly because it is a real cost: with few buckets and one rare category — the common case for `blood_type` — full suppression is the *expected* outcome, so that grouping will often return nothing for small clinics. That is an honest limit of the grouping. The previous behavior was not a better answer to it; it was a specific false number.

**3. The prompt and the tool description teach the distinction.** Both locales now instruct the model to keep the two reasons apart, to never describe a `complementary` bucket as small or quote any number for it, and to say plainly that the grouping cannot be reported when `distribution_withheld` is true. The verbatim-relay rule that made the old defect user-visible is retained — it is correct; it just needed something true to relay.

**4. The UI renders the split.** `noticeSuppressed` (unchanged) still covers the all-below-floor case. A new `noticeSuppressedMixed` states the two counts separately, and `noticeDistributionWithheld` covers the terminal case. The `suppressed` notice deliberately does not fire alongside `distribution_withheld` — "N groups were too small" would describe groups the payload declines to name.

### Empirical validation

Executed against local Postgres through the RPC, as an authenticated admin with `pro_ai`:

| Fixture | Result |
|---|---|
| **200 O+ / 3 A+** (the review's reproduction) | `distribution_withheld: true`, `buckets_all_time: []`, `patients_total_approx: 205`. The 200-bucket is no longer described at all, let alone as `<5`. |
| **100 O+ / 60 A+ / 3 B+** (partial suppression) | O+ visible at 100; A+ `display: "hidden"`, reason `complementary`; B+ `display: "<5"`, reason `below_floor`. `"60"` appears nowhere in the payload. |
| **40 / 30 / 20** (nothing to suppress) | All three exact, `patients_total_exact: true`, every `suppression_reason` null. |

The asymmetric fixture is now permanent: the integration suite provisions a fourth clinic (`clinicSkew`, 100/60/3) precisely because **no existing fixture could distinguish the two suppression reasons**. That is the review's finding about the test suite, and it was correct — clinic A's 6 O+ / 2 A+ suppresses everything, so the old assertion passed while the whole distribution was hidden and O+ was being mislabelled.

---

## 3. H2 — a tool that throws mid-stream never reached the client's error state

`app/api/agent/chat/route.ts`, `components/assistant/assistant-chat.tsx`, `lib/ai/tools/index.ts`, `lib/ai/errors.ts`, `lib/ai/tool-presentation.ts`, `lib/ai/tools/run-clinic-report.ts`

**The review's premise was verified against `ai@6.0.230` before anything was changed, and it is correct.** Restated as the three transports it actually is, and recorded at the `AssistantErrorCode` declaration so the next person does not have to re-derive it:

1. **Pre-stream JSON body** — `{ error: code }`, read from the fetch response.
2. **Stream-level `error` chunk** — the only thing that sets `useChat`'s `error`.
3. **`tool-output-error` chunk** — what a thrown `execute()` actually produces. `executeToolCall` catches the throw and converts it to a `tool-error` content part; the UI stream emits `tool-output-error`; the client handler calls only `updateToolPart({ state: "output-error", errorText })`. `useChat`'s `error` stays `undefined`. The route's `onError` *does* run, but as the **formatter** producing `errorText` — so review #1's reason code was travelling to a place the UI discarded.

### The fix, in two halves

**Half one: most denials no longer throw at all.** `harden()` — the mount wrapper — now converts a thrown `AiToolAuthorizationError` into a structured result:

```ts
{ permission_denied: true, reason, guidance }
```

Placed at the mount boundary rather than per tool, for the same reason M3 of review #1 put the audit there: a per-tool convention is one forgotten call away from a gap, and **any** of the fifteen tools can raise `page_hidden`, `subscription_inactive`, or `usage_limit_reached` mid-turn when an admin changes something while a session is open. `DENIAL_GUIDANCE` enumerates every reason exhaustively, so adding a reason is a compile error rather than a fall-through.

**Only `AiToolAuthorizationError` is converted.** This is the line the review's framing asks for and it is drawn deliberately: a denial is a *state* — the user can act on it, and retrying cannot change it. An unexpected failure (a failed database read, a bug) is not, and dressing one up as a polite user-facing sentence would hide it. Those still throw, and land on half two.

**Half two: a thrown error is now a first-class UI state.** `ToolActivity` reads the tool part's `errorText`, validates it against `AssistantErrorCode`, and renders the same localized copy the other two transports use. An unrecognized string (an SDK-internal failure, an aborted fetch) falls back to the generic sentence rather than putting untranslated internal text in front of the user. The route's `onError` now returns **only** codes — the generic branch returns `"temporarily_unavailable"` instead of a localized sentence, because a sentence is unclassifiable at the receiving end and, on this transport, would also land in the model's context.

Four denial reasons that previously shared `errorGeneric` ("try again") got their own copy in both locales — `errorPageHidden`, `errorRoleForbidden`, `errorLookupFailed`, `errorUnauthenticated`. Sharing "try again" was harmless while these could only arrive pre-stream; as mid-turn tool denials, "try again" is actively wrong for three of them.

### Transport-level regression tests

`tests/unit/ai/p46-tool-error-transport.test.ts` — 7 tests, no callback invoked directly, no chunk shape stubbed:

- an `execute()` throw produces a `tool-output-error` chunk **and no `error` chunk** (the load-bearing negative — this is why `useChat.error` is never set);
- the reason code survives intact as `errorText`, asserted for four reasons;
- an internal `Error` yields `"temporarily_unavailable"`, and its raw message appears nowhere in the stream;
- `readUIMessageStream` — the same reconstruction `useChat` performs — yields a part with `state: "output-error"` and the code, which is exactly what `ToolActivity` reads;
- a `harden()`-converted denial produces `tool-output-available` and **no** error chunk at all.

Five UI tests then assert the localized copy each code renders, plus the unrecognized-string fallback.

**On the pre-existing test the review criticized:** `p4b-chat-route.test.ts` called `options.onError(...)` directly. That test was kept (it still pins the route's contract, which is a real thing to pin) and re-pointed at the code rather than the sentence; the transport claim it cannot make is now made by the suite above.

---

## 4. M1 — the primary-admin rule was enforced in the application only

`supabase/migrations/20260720160000_…sql`

Reproduced first, then fixed. The `"Admins can manage clinic ai permissions"` policy was `for all` on `role = 'admin'` with no primary-admin condition, so the rule both server actions enforce was reachable only through the application.

The replacement policy uses `public.is_primary_clinic_admin(clinic_id, auth.uid())` — a new `stable security definer` function whose predicate is lifted verbatim from `assert_primary_ai_provider_admin` (P4.5B): same `is_active` / `is_deleted` / `deleted_at` filters, same `created_at asc, id asc` tiebreak. `lib/primary-admin.ts` is documented as staying byte-for-byte aligned with that definition, so all three layers now resolve the same person by construction rather than by three independent transcriptions.

`SECURITY DEFINER` is required, not incidental: as `INVOKER` the function would re-enter `profiles`' own RLS from inside a policy on another table. It discloses nothing — it answers only "is this specific user the primary admin of this specific clinic", for arguments the caller already supplies.

**Service-role and legitimate workflows are preserved.** `setStaffAiPermission` and `listStaffAiPermissions` write and read through `createClinicScopedAdminClient` *after* checking `isPrimaryClinicAdmin` themselves. Service role bypasses RLS, so this change closes the direct-token path and touches nothing else. A test asserts the service-role upsert still succeeds, precisely so a future tightening cannot break it silently.

### Empirical validation over real PostgREST

`tests/unit/integration/p46-ai-permissions-rls.test.ts`, with a clinic holding two admins (unambiguous `created_at` values), a manager, a doctor, and a second clinic:

| Check | Result |
|---|---|
| Non-primary admin `INSERT`s a grant with their own token | `42501`, no row written |
| Non-primary admin `UPDATE`s an existing grant | filtered out by `using`; row unchanged |
| Non-primary admin `DELETE`s a grant | row survives |
| Primary admin `INSERT`s | succeeds |
| Manager self-grants / doctor self-grants | refused |
| Primary admin reaches into another clinic | refused |
| Granted user reads their own row | still works (self-read policy intact) |
| Service-role upsert | succeeds |
| **Full review reproduction:** revoke → manager's `ai_get_revenue_summary` denied → non-primary admin tries to re-enable → write refused → RPC still denied | holds end to end |

The last row is the review's own two-call reproduction, inverted into a regression test.

---

## 5. M2 — any tool error failed the whole turn

`app/api/agent/chat/route.ts`

`onError` fires for **every** tool-error part, not only for a stream-fatal error, and `streamFailed` then drove `onFinish` into the failure branch: `finalizeExecution("failed", "stream_failed")` plus an early `return` that skipped `persistDoctorTurn`. A turn the user watched stream to completion was discarded on the next page load and billed as failed.

`streamFailed` is removed from the failure condition. The two signals that actually distinguish the fatal case were already in the same expression: a genuinely failed stream finishes with `finishReason === "error"`, and one that died before producing anything has no assistant text. `streamFailed` is retained and now records the recovery on the ledger — a recovered turn finalizes as `{ outcome: "success", errorClass: "recovered_tool_error" }`, keeping the signal without letting it decide the outcome.

Validated in the transport suite (a real throwing tool followed by real model text finishes with a non-`error` reason and complete assistant text) and at the route (the turn persists and finalizes as the success it was). The existing test asserting that a tool error with **no** answer still fails was kept unchanged and still passes — that case is genuinely a failure, and M2 must not turn "do not fail on recovery" into "never fail".

---

## 6. M3 — the financial gate ran twice and swallowed three denials

`lib/ai/tools/run-clinic-report.ts`

Both halves fall out of the H2 fix rather than needing their own mechanism.

`financialDenialReason` is deleted. It caught two of the reasons the gate chain can raise and re-threw `page_hidden`, `subscription_inactive`, and `lookup_failed` — three denials that are just as user-actionable, and *more* likely mid-conversation, since an admin can flip either of the first two from a settings screen while a session is open. With `harden()` converting every reason uniformly, the call site is back to asserting the gate straight:

```ts
if (definition.financial) await assertFinancialInsightsAccess(ctx.user);
else await assertAnalyticsToolAccess(ctx.user);
```

That also removes the duplicated gate execution and, with a comment, the asymmetry the review said took three files to confirm was intentional: `assertFinancialInsightsAccess` calls `assertAnalyticsToolAccess` internally, which is why the financial branch does not.

`summarizeToolResult`'s `permission_denied` notice widened from two hardcoded reasons to the whole `AiToolDenialReason` union, guarded so an unrecognized reason produces no notice rather than a blank line. `noticeText` now keys off the same `ERROR_COPY_KEYS` table the two error transports use, so one denial cannot read three different ways depending on how it arrived.

---

## 7. Low findings

| ID | Resolution |
|---|---|
| **L1** | Runbook corrected. The blocking-statement table listed three statements when there are **four** — `…120000` builds `idx_patients_search_phone` (btree) as well as the trgm index, and the migration's own comment said so while the runbook the operator follows did not. The `CONCURRENTLY` block now carries all four builds, the verification query checks all four indexes, the step list includes `…160000`, and a note says why the row was missing. An operator following it literally would previously have left one blocking build in place. |
| **L2** | `normalize_search_text` and `normalize_phone` now `revoke all … from public` before granting, matching the four `search_*_ranked` functions L9 of review #1 hardened one section below them in the same file. No behavior change — both are `immutable`, pure, and read nothing — but they were the pattern a reader would copy. |
| **L3** | New `ai_permission_is_grantable(permission_key, role)`, mirroring `GRANTABLE_ROLES` exactly, enforced in the policy's `with check`. A grant row for a doctor is now refused at the database boundary (verified: `42501`), as is one for an admin — an admin row is *meaningless* rather than merely redundant, since `hasAiUserPermission` short-circuits on the role. Closes the stale-grant-survives-a-demotion-and-silently-reactivates path. |
| **L4** | `exact_name` is now two-valued: `c.search_name = v_query or (v_query_alt is not null and c.search_name = v_query_alt)`, mirroring the neighbouring `prefix_name`. No behavior change — the review's analysis that both consumers coincidentally absorb the `NULL` is correct, and the three integration tests pinning the observable halves of `search_patients_ranked` still pass unchanged. The point is that the correctness no longer depends on the coincidence. |
| **L5** | `isSystemAuthored` now treats an **absent** `candidates` key as satisfying "carries no tenant candidates", alongside an empty array. The rule was always "no tenant records ⇒ system provenance"; the predicate encoded one shape narrower than the rule and agreed with it only because `filterClarification` always sets the key. |
| **L6** | `verifiedId` is no longer `async`. It awaited nothing and only classifies the result of a read the caller performs — the name plus `async` read as though it did the verification itself. Cosmetic, no behavior change. |
| **L7** | The doctor-filter description is derived from `REPORTS[].acceptsDoctor` intersected with the caller's `allowed` list, instead of a hardcoded sentence naming `revenue` to every caller — including the manager whose `allowed` list two lines above deliberately excludes it. Same string re-introducing the same report name into the same model context that review #1's H1 removed. |
| **L8** | The payload carries `patients_total_approx_direction: "nearest"`, and the copy in both locales now says the total is rounded to the nearest floor and **may be higher or lower** than the real number. Rounding to nearest remains the right choice (a floor would publish a true lower bound on the suppressed residual); what was missing was admitting which way it can err, so a user reconciling 205 against a patients page showing 203 knows why. |

---

## 8. Informational

**I3 — two documents overstated what review #1's H1 fix achieved.** Both corrected, as the review asked, at the same time as the H2 fix:

- `docs/reports/P4_6_PHASE_REVIEW_FIXES.md` §2.3 carries an inline correction block stating that the `onError` change is still correct and still load-bearing — it is what puts a classifiable code on the tool part — but that it did not make the error banner reachable, and that fixes #3 and #4 were not sufficient alone.
- The `ERROR_COPY_KEYS` comment block in `assistant-chat.tsx` no longer claims "both transports classify identically". It documents all three transports and says which one carries tool denials.
- `AI_AGENT_PLAN.md` §1098 gains a review-#2 subsection qualifying points 1 and 2 rather than leaving "all actionable findings are implemented" to stand unqualified for the two that were not fully closed.

**I1, I2** — no action required.

---

## 9. Validation

Run from a **database reset**, so the migration chain was exercised from scratch rather than incrementally applied.

| Check | Result |
|---|---|
| `supabase db reset --local` | ✅ all migrations `…120000 → …160000` applied cleanly |
| `pnpm typecheck` | ✅ clean |
| `pnpm lint` | ✅ 0 errors (25 pre-existing warnings, unchanged) |
| `pnpm test` (unit) | ✅ **180 files, 1,177 tests** |
| `pnpm test:integration` (live local Postgres + PostgREST) | ✅ **23 files, 235 tests** |
| `pnpm build` | ✅ compiled successfully |
| `pnpm i18n:missing` | ✅ 2,735 base leaf messages, locale parity valid |
| `pnpm lint:i18n` | ✅ no hardcoded user-facing strings |
| Ad-hoc live RPC probes (3 fixture shapes) | ✅ H1 behavior confirmed directly |
| Ad-hoc live PostgREST probes | ✅ folded into the retained RLS suite |

Unit 1,159 → 1,177 (+18). Integration 220 → 235 (+15).

**No test was deleted and no assertion was weakened.** Eleven existing assertions changed, each because the behavior it described was the defect:

- Five in `p46a-staff-analytics-tools.test.ts` moved from `.rejects` to the returned denial. Each still asserts the same gate runs inside `execute()` and each **gained** an assertion that no read happened — the property they exist for is re-authorization, not the throw.
- Two in `p46a-analytics-rpc-isolation.test.ts` were the ones the review identified as vacuous. They now run against the asymmetric fixture, where a visible bucket exists to contradict a false label and to subtract from. This is the one place a *stronger* assertion replaced a weaker one.
- One in `p46-phase-review-fixes.test.ts` (`role_forbidden` "still throws") is retained with its authorization half intact and its shape updated, plus a comment recording why review #1's reasoning was sound on its stated premise and what changed underneath it.
- One in `p4b-chat-route.test.ts` asserts the code rather than the sentence.
- Two UI tests absorbed the new copy.

---

## 10. What is deliberately still open

- **M6 of review #1 stands unchanged.** The task-class gate excludes nothing today. **P4.7's `staff_help` class and P4.11's workflow steps must not assume it constrains anything** until a registry entry declares a genuinely narrower class.
- **The `effective_ai_feature` cost** noted in §8 of review #2 remains a deliberate trade, recorded there and not revisited.
- **M4's lock/rewrite profile** is still documented rather than automated. The runbook is now accurate about all four blocking statements, which is what L1 asked for; the window itself does not disappear.
- **Fully suppressed distributions return nothing.** For small clinics grouping by `blood_type` this will be the common outcome. It is the correct answer to the privacy constraint, and it is now stated honestly instead of being papered over with a false number — but it is a genuine product limit, not a solved problem. If the grouping needs to be useful at small N, that requires a different construction (wider buckets, or a k-anonymity-preserving generalization), not a different label.

P4.7 was not started.
