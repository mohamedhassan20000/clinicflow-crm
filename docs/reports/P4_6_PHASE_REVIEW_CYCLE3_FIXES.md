# P4.6 Comprehensive Phase Review #3 — Implementation of Fixes

**Phase:** P4.6 (C + A + B, treated as one feature)
**Input:** `docs/reviews/P4.6_PHASE_REVIEW_CYCLE3.md` (Comprehensive Phase Review #3, 2026-07-20)
**Date:** 2026-07-20
**Scope:** the required High finding and both Medium findings. The five Low findings are deferred, listed in §5 with reasons. No review report was modified. P4.7 was not started.

New migration: `20260720170000_p46_phase_review_cycle3_fixes.sql`.

---

## 1. Summary

| Severity | Findings | Fixed | Deferred |
|---|---|---|---|
| High | H1 | 1 | 0 |
| Medium | M1, M2 | 2 | 0 |
| Low | L1–L5 | 0 | 5 |

H1's fix subsumes M1 and L4 outright: the construction that closes the reversal also removes the rounding that produced `patients_total_approx: 0`, and removes the per-category labels that L4 was about.

**The review named the root cause and it is the right one.** Both previous cycles fixed suppression *inside `ai_get_patient_stats`*, which is the scope at which the old property was true and insufficient. The fix therefore changes the scope the property is defined over, not just its implementation — and the regression test is written over the pair of tools, not the one function.

---

## 2. H1 — suppression was reversible across the tool surface

`supabase/migrations/20260720170000_…sql`, `lib/ai/tools/get-patient-stats.ts`, `lib/ai/tool-presentation.ts`, `components/assistant/assistant-chat.tsx`, `lib/ai/prompts/staff.ts` (both locales), `messages/{ar,en}.json`

### The diagnosis, confirmed

`ai_get_patient_stats` protected its hidden buckets by refusing to publish an exact total — `patients_total: null`, plus a floor-rounded `patients_total_approx`. That defence only holds if no other reachable tool publishes the same total. `ai_get_clinic_summary` does:

```sql
'patients_total', (select count(*) from public.patients pt
                   where pt.clinic_id = v_clinic_id and not pt.is_deleted)
```

Both tools carry identical `roles` and `requiredFeatures` in the registry, so they mount together, for the same user, on every turn. There is no configuration where a caller holds one and not the other. Reproduced before changing anything, on a clinic with 100 O+ / 4 A+ / 3 B+:

| Call | Result |
|---|---|
| `ai_get_patient_stats` | `patients_total: null`, `approx: 105`, O+ = 100, A+ `"<5"`, B+ `"<5"` |
| `ai_get_clinic_summary` | `patients_total: 107` |

107 − 100 = 7. Two buckets each bounded to 1–4 by their own `"<5"` label, emitted descending, sum 7 → **A+ = 4, B+ = 3, both exact.**

A second vector existed inside the payload: `patients_new_in_range` is an exact unsuppressed count over the same table and equals the withheld total whenever the range covers the clinic's history. `MAX_RANGE_DAYS = 400` is not a mitigation — disjoint windows sum.

### The fix: generalize instead of hide

Hiding the total everywhere was the other option and it is the wrong one. It would couple `get_clinic_summary`'s headline figure to whether some *other* grouping would suppress, leave `patients_new_in_range` summable across windows, and leave the invariant spread over five functions that each have to keep it independently — which is the shape that failed twice already.

Instead the distribution stops needing the total to be secret. Suppressed categories are no longer emitted as individually labelled cells; they are folded into **one aggregate bucket** with the exact combined count and no category names:

```json
{ "bucket": "Other", "count": 7, "display": "7",
  "suppressed": true, "suppression_reason": "aggregated",
  "grouped_bucket_count": 2 }
```

**The suppression *selection* is preserved byte-for-byte** — primary suppression below the floor, then complementary extension until at least two buckets are hidden and their sum reaches the floor. That loop is load-bearing in a new way, and the migration says so: it is exactly what guarantees the aggregate spans ≥2 categories and is itself ≥ the floor, which is what makes publishing its exact count safe.

Given that, subtraction reveals nothing new: `patients_total` minus the visible buckets *is* the aggregate, which is published outright. So the total goes back to being exact, which in turn makes the two tools agree instead of contradicting each other.

Fully suppressed distributions are still declined via `distribution_withheld` rather than emitted as one aggregate equal to the total, which would be an information-free payload dressed as data.

### What this removes

| Removed | Why |
|---|---|
| `patients_total_approx`, `patients_total_approx_direction` | The total is exact again; there is nothing to approximate. Removes M1 with it. |
| `suppression_reason: "below_floor"` / `"complementary"`, `suppressed_below_floor_count`, `suppressed_complementary_count` | The distinction existed to make per-bucket labels truthful. No bucket carries a claim about a category any more, so the split has nothing to describe. This is not a regression of review #2's H1 — it is its terminal form. |
| `noticeSuppressedMixed`, `noticeApproximateTotal` | Both described per-group facts the payload no longer contains. |
| Per-category labels for suppressed groups | Closes L4 of review #3: the partial case now takes the same position as the fully-withheld case, which already removed names on the stated reasoning that publishing a label "for nothing in return" was the wrong trade. |

### Empirical validation

Executed against local Postgres through the RPC, as an authenticated admin with `pro_ai`, across seven fixtures:

| Fixture | Before | After |
|---|---|---|
| **100 / 4 / 3** (the reproduction) | `total: null`, `approx: 105`, both cells recoverable from the sibling RPC | `total: 107` exact, O+ = 100, `Other: 7` over 2 groups. 107 − 100 = 7 = the published aggregate |
| **100 / 50 / 4** | A+ estimable to ±2 from the rounded total | `Other: 54` over 2 groups; 50 no longer appears |
| **100 / 60 / 50 / 3** | two suppressed cells labelled separately | two visible, `Other: 53` over 2 groups |
| **200 / 3** | withheld | withheld (unchanged) |
| **single bucket of 2** | `patients_total_approx: 0` | `patients_total: 2`, exact |
| **single bucket of 3** | withheld, `approx: 5` | withheld, `total: 3` exact |
| **40 / 30 / 20** | all exact | all exact (unchanged) |

---

## 3. M1 — `patients_total_approx` published `0` for a clinic with patients

Closed by H1's construction rather than by a clamp. `round(2/5)*5 = 0` produced "approximately no patients" for a two-patient clinic, alongside `patients_new_in_range: 2` in the same object. With the exact total restored there is no rounding left to misfire, and the integration suite now asserts `patients_total_exact === true` even in the fully-withheld case — the one case where the old code still rounded.

## 4. M2 — the anti-subtraction prompt rule named the wrong field

`lib/ai/prompts/staff.ts` (both locales)

The rule said *"never derive one by subtracting the visible groups from a total"*, which in context read as the total in that payload. It was the sole remaining barrier against both of H1's vectors and addressed neither by name.

Both locales now say **"never derive one by subtracting from any total — including a total returned by a different tool in this conversation"**, and the whole suppression paragraph is rewritten for the aggregate: report `Other` only as a combined "other groups" total, never guess which categories it contains or how many are in any one of them, never name a category absent from the list.

This is defence-in-depth, not the fix. `untrusted-text.ts` is explicit that the prompt layer reduces blast radius and is not what makes the system safe, and after H1 the arithmetic yields nothing regardless of what the model does with it. The rule is widened so it stops being load-bearing, not so it can be relied on.

---

## 5. Low findings — deferred, with reasons

| ID | Finding | Why deferred |
|---|---|---|
| **L1** | `usage_limit_reached` converted to a result, so the turn continues after the cap | A cost note, not a defect. The pre-stream reservation makes it rare, and changing `harden()` to special-case one reason would undo the uniformity that closed review #2's H2. Wants its own decision about whether the turn should be cut short, which is a P4.5-adjacent budget question. |
| **L2** | Whitespace collapse still lossy for pass-through free text, unsignalled | Real but narrow: report free text reaches the model reflowed to one line. Fixing it properly means a second `onTruncate`-style signal for reflow, and the rule's justification (a field must not pose as several) is sound. Worth doing with the next `run_clinic_report` change rather than alone. |
| **L3** | Tool-part denial copy has no `role="alert"` and is outside the live region | Genuine a11y gap introduced by review #2's H2 fix. Small, but it touches announcement sequencing for streaming messages and deserves testing against a screen reader rather than a blind edit. |
| **L4** | Below-floor bucket labels published in the partial case | **Closed as a side effect of H1** — suppressed categories are no longer named at all. |
| **L5** | Notices keyed by `notice.kind` | Unreachable today; `summarizeToolResult` cannot emit two notices of one kind. |

L4 is closed. The other four are recorded and carried forward.

---

## 6. Tests

**No test was deleted and no assertion was weakened.** Seven assertions changed, each because the behavior it described was the defect, and each was confirmed to **fail against the pre-fix function** before being accepted — the old `ai_get_patient_stats` body was reapplied to the live database and the suite re-run:

```
× generalizes every suppressed category into one unnamed aggregate
× makes no numeric or size claim about any individual hidden category
× publishes an exact total that reconciles with the aggregate
× leaves a residual too large and too spread out to identify anyone
× is not reversible by combining the two tools a caller always holds
× survives patients_new_in_range equalling the total
× returns exact counts when nothing needs suppressing
      Tests  7 failed | 39 passed
```

The load-bearing addition is **`is not reversible by combining the two tools a caller always holds`**. It calls `ai_get_patient_stats` and `ai_get_clinic_summary` against the same fixture, asserts the two totals agree, performs review #3's exact subtraction, and asserts it yields only `suppressed_patient_count` — the figure the payload already publishes — over an aggregate spanning ≥2 categories. This is the first assertion in the phase written over the caller's *mount* rather than over one function, which is the scope the invariant actually has to hold at.

A companion test pins the second vector: `patients_new_in_range` is asserted to equal the total on the skew fixture, so a future change that reintroduces a withheld total has to reckon with this field rather than rediscover it.

## 7. Validation

Run from a **database reset**, so the migration chain was exercised from scratch.

| Check | Result |
|---|---|
| `supabase db reset --local` | ✅ all migrations `…120000 → …170000` applied cleanly |
| `pnpm typecheck` | ✅ clean |
| `pnpm lint` | ✅ 0 errors (25 pre-existing warnings, unchanged) |
| `pnpm test` (unit) | ✅ **180 files, 1,176 tests** |
| `pnpm test:integration` (live local Postgres + PostgREST) | ✅ **23 files, 237 tests** |
| `pnpm build` | ✅ compiled successfully |
| `pnpm i18n:missing` | ✅ 2,733 base leaf messages, locale parity valid |
| `pnpm lint:i18n` | ✅ no hardcoded user-facing strings |
| Ad-hoc live RPC probes (7 fixture shapes) | ✅ H1 behavior confirmed directly, before and after |
| New assertions run against the pre-fix function | ✅ 7 fail, confirming non-vacuity |

Unit 1,177 → 1,176 (−1: two suppression tests merged into one aggregate assertion, one added). Integration 235 → 237 (+2: the cross-tool and `patients_new_in_range` regressions). Message count 2,735 → 2,733 (two notice keys removed, none added).

## 8. What is deliberately still open

- **L1, L2, L3, L5** as recorded in §5.
- **M6 of review #1 stands unchanged.** The task-class gate excludes nothing today. **P4.7's `staff_help` class and P4.11's workflow steps must not assume it constrains anything** until a registry entry declares a genuinely narrower class.
- **M4's lock/rewrite profile** remains documented rather than automated. `…170000` is a `create or replace function` and adds no lock of its own.
- **Fully suppressed distributions still return nothing**, and for small clinics grouping by `blood_type` that remains the common outcome. Generalization helps where a visible bucket survives; it cannot manufacture one where none does.
- **Review #3's I4 observation stands as the thing to watch.** Each cycle closed this finding at the scope the previous review examined: the function's arithmetic, then its rendering, now the caller's tool surface. The next scope up is the multi-turn conversation, where ranges can be varied and results accumulated across turns. Nothing in the current design bounds that, and P4.7 should not assume it does.

P4.7 was not started.
