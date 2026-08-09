# P7-0 — Document Platform Foundations — Independent Engineering Review

**Reviewer:** Claude (independent review; validated against the running local stack, not the report alone)
**Date:** 2026-08-01
**Branch:** `feat/p7-document-platform`
**Scope reviewed:** every file changed by P7-0, the approved architecture (`docs/designs/document-platform/analysis/01–15` + `README`), the reconciled roadmap (`13-implementation-roadmap.md` §P7-0), the data model (`11-data-model.md`), numbering (`06`), lifecycle/idempotency (`05` §3.1), `docs/documents/README.md`, `docs/AI_AGENT_PLAN.md` (Phase 7), and `docs/reports/P7-0_IMPLEMENTATION.md`.

Finding IDs are stable for the Claude→Codex handoff contract.

---

## 1. Verdict summary

P7-0 is a faithful, well-tested implementation of the approved type-agnostic foundation. The schema, RLS, atomic numbering, idempotent issuance/rollback, tenant-isolation triggers, branding migration + settings surface, Latin-digit/bidi utilities, and the catalog skeleton all match the locked architecture, with **no P7-1+ scope implemented**.

One **reproduced correctness defect** exists in delivered code — the `clinic-documents` storage read policy is non-functional (fail-closed) because of an off-by-one path index. It is not exercised by P7-0 (no authenticated read path ships until P7-1/P7-3), so it does not break P7-0's own deliverables or tests, but it is wrong as written and the implementation report describes it as working. Plus one documentation inaccuracy.

**Original verdict: APPROVED WITH REQUIRED FIXES.**

**Final re-review verdict (2026-08-01): APPROVED.** All required fixes are in place and independently verified (see §8).

---

## 2. Independent validation performed

| Check | Result |
|---|---|
| Focused P7-0 unit/static suite (5 files) | **18/18 passed** (re-run locally) |
| `tsc --noEmit` | **pass** (clean) |
| `check-messages.mjs missing` (EN/AR parity) | **pass** — 3,260 base leaf messages |
| `storage.foldername()` semantics on the running DB | **reproduced** the policy defect (§4, P70-R1) |
| Migration ↔ `types/database.ts` drift | new tables + 4 RPCs + branding columns present and typed |

I did not re-run the live Supabase integration suite (`tests/unit/integration/p70-*`) or `pnpm build`; the report records those green and the code paths they exercise were read directly.

---

## 3. Architecture & scope conformance (confirmed correct)

- **Type-agnostic persistence** — `documents`, `document_events`, `document_counters`, `document_settings` are all `doc_type`-as-data (roadmap correction #6). No per-type schema. ✔
- **Numbering** — per-`(clinic, doc_type, period_key)` via `allocate_document_number` (locked upsert `next_seq = next_seq + 1 RETURNING next_seq - 1`) + `unique (clinic_id, doc_type, document_number)` backstop. Matches doc 06 §3 exactly. Full visible number is frozen at allocation (`document_number`, `numbering_prefix_snapshot`) and immutable (doc 06 §5). ✔
- **Idempotent issuance** — `reserve_document_issue` takes `pg_advisory_xact_lock(hash(clinic:key))`, dedupes on `unique (clinic_id, idempotency_key)`, returns the original reservation on identical retry, and **rejects** conflicting reuse (`DOCUMENT_IDEMPOTENCY_CONFLICT`) by comparing actor/type/locale/params/subject refs. Allocates a number at most once. ✔
- **Render-failure rollback** — split reserve/complete/fail. `fail_document_issue` marks `failed`, keeps the allocated number (retire-not-reuse, doc 06 §4 / §11), and a retry reuses the same row+number. This is precisely the "allocation-before-render" alternative sanctioned by doc 05 §3.1. ✔
- **Partial-issue invisibility** — `documents_state_completeness` CHECK + the `documents_select_scoped` RLS filter `status in ('issued','void','cancelled')` guarantee `rendering`/`failed` reservations are never returned by authenticated SELECT. Verified by the integration test (`keeps a failed reservation hidden`). ✔
- **Coordinator rollback ordering** — `issueDocumentWithGuard` fails-then-cleans, and critically refuses to delete the canonical PDF when `fail` returns `false` (completion may have committed with a lost response). Covered by the "ambiguous committed completion" unit test. This is a correct and non-obvious safety property. ✔
- **Tenant isolation (defense-in-depth)** — `validate_document_tenant_references` trigger re-checks every subject/actor/predecessor UUID against the row's `clinic_id` on insert/update, independent of the service-role boundary. ✔
- **Branding** — the exact doc 11 §5 field set (email, website, license_no, tax_id, document_footer, branding_metadata bag) with length/shape CHECKs; the `prevent_manager_clinic_privilege_update` trigger is extended to protect all six from Manager forgery. Verified by integration test (manager + cross-tenant writes rejected/no-op). ✔
- **Latin digits / bidi** — `format.ts` forces `nu-latn` for number/money/percent/date/time and normalizes both Arabic-Indic ranges; `bidi.ts` provides `<bdi>` props + FSI/LRI/RLI isolation. Unit-tested for AR + EN. ✔
- **Catalog skeleton** — 16 authoritative `DOCUMENT_TYPE_CODES` with only `REVENUE_REPORT` + `INVOICE` registered as data-only entries (explicitly the "tax-branding reference"; roadmap "types + a couple of entries"). `verificationDisclosure` locked to the 5 safe fields; page roles exclude doctor/assistant. ✔

**No P7-1+ scope present.** No `DocumentPage`, primitives, Chromium/PDF renderer, QR, font embedding, templates, resolvers, preview/download/verification routes, module UI, or documents-settings page. The `render` step is injected, never implemented. ✔

---

## 4. Findings

### P70-R1 — REQUIRED — `clinic-documents` storage read policy is non-functional (wrong path index)

**File:** `supabase/migrations/20260801120000_p70_document_foundations.sql:932-949`

The `clinic_documents_select_scoped` policy extracts the document-id filename segment with `(storage.foldername(name))[4]`:

```sql
where d.id = split_part((storage.foldername(name))[4], '.', 1)::uuid
  ...
  and d.doc_type = (storage.foldername(name))[3]
```

`storage.foldername()` returns the path segments **excluding the filename**. Reproduced on the running local DB for a canonical path `documents/<clinic>/<doc_type>/<id>.pdf`:

```
storage.foldername(...) = {documents, <clinic>, REVENUE_REPORT}   -- 3 elements
(storage.foldername(...))[4] IS NULL = true
```

So `[4]` is `NULL`, `split_part(NULL,'.',1)::uuid` is `NULL`, and `d.id = NULL` is never true → **the EXISTS never matches → the policy denies every authenticated read of the bucket.**

- **Impact now:** none functionally — P7-0 ships no authenticated read/signed-URL path, so nothing exercises it and all tests pass. It is **fail-closed** (over-restrictive, not a leak), so there is no security regression.
- **Impact later:** when P7-1/P7-3 wire authenticated signed-URL reads against this RLS (doc 11 §7), legitimate clinic reads will be denied. The implementation report §2 states "The read policy validates both the clinic folder and document ownership/state" — as written it validates nothing, because it can never pass.
- **Fix:** index the filename segment correctly, e.g. `storage.filename(name)` (then `split_part(..., '.', 1)`), or `(string_to_array(name, '/'))[4]`. The `[1]`/`[2]`/`[3]` folder checks and the `d.pdf_storage_path = name` equality are already correct; only the id extraction is wrong. Add a storage-RLS read test (authenticated own-clinic read allowed; cross-clinic / non-issued denied) so this cannot regress silently.

### P70-R2 — MINOR (doc) — Implementation report misstates the storage path shape

**File:** `docs/reports/P7-0_IMPLEMENTATION.md:42-46`

The report says objects use `<clinic-id>/<document-id>/<document-id>.pdf`. The actual (and correct, per doc 11 §7) path produced by the migration CHECK, `complete_document_issue`, and `lib/supabase/admin.ts:clinicDocumentStoragePath` is `documents/<clinic-id>/<doc_type>/<document-id>.pdf`. Code is consistent with the design; only the report prose is wrong. Correct the report to avoid confusing P7-1 implementers.

### P70-N1 — NIT — `complete_document_issue` `reused` flag is effectively dead on the write path

**File:** `supabase/migrations/…_p70_document_foundations.sql:826-831` and `lib/documents/issuance.ts:200-218`

On the non-idempotent completion branch the RPC returns `reused = not v_changed`, which is always `false` (v_changed is set `true` just above). The coordinator then uses `reservation.reused` (from reserve), not the completion's value, so the final result is correct regardless. No action required; noted only so it isn't mistaken for a signal later.

---

## 5. Security / correctness / regression sweep (no issues found)

- **RLS inheritance is correct where it matters:** `document_events_select_scoped` and the storage policy both re-select `public.documents` inside their `USING` clause, so document-level subject scoping (doctor/assistant patient/doctor visibility) is inherited automatically rather than duplicated. Good pattern (the storage policy's *intent* is right; only P70-R1's index is wrong).
- **Counters are unreachable by clients:** no authenticated SELECT/DML policy on `document_counters`; `allocate_document_number` is `SECURITY DEFINER`, `owner postgres`, execute granted to `service_role` only. ✔
- **All four issuance RPCs** are `SECURITY DEFINER` with `set search_path` pinned, `revoke … from public, anon, authenticated`, execute to `service_role`. Actor authorization (`is_active`, `not is_deleted`, `deleted_at is null`, same clinic) is re-checked in-RPC. ✔
- **Admin service wrappers** live behind `import "server-only"`; `issuance.ts` is `server-only` and injects render, so no client bundle exposure. ✔
- **Branding write gating is layered:** action writes branding only when `role === "admin"`; DB trigger blocks Manager forgery; the settings page is `readOnly` for non-admins (pre-existing behavior, not changed by P7-0). No regression to existing manager-editable clinic fields. ✔
- **Validation ↔ DB constraint alignment:** zod (`clinicSchema`) email/website/length/JSON-object bounds are compatible with the migration CHECKs; empty optionals normalize to `null`. ✔
- **No unnecessary complexity/duplication:** utilities are small and single-purpose; issuance is a clean dependency-injected guard with a thin concrete adapter. ✔

---

## 6. Roadmap / scope boundary confirmation

- P7-0 deliverables (roadmap §P7-0) — schema+RLS ✔, atomic numbering RPC + concurrency test ✔, retry-safe idempotent issue with render-failure rollback proven by test ✔, branding fields live in Clinic Settings ✔, formatter unit-tested for AR/EN Latin digits ✔.
- No P7-1 (engine/primitives/Chromium/QR), P7-2 (conformance sheets), P7-3 (vertical slice/resolver/routes), or later scope leaked in.
- Doc reconciliation (16-doc set supersedes the 8-doc catalog; P7-0…P7-10 naming) is reflected in `AI_AGENT_PLAN.md` and `docs/documents/README.md` doc-only edits.

---

## 7. Required before merge

1. **P70-R1** — fix the storage read policy id extraction and add a storage-RLS read test. (Correctness; fail-closed today, blocking for P7-1/P7-3 reads.)
2. **P70-R2** — correct the storage-path description in the implementation report.

P70-N1 is optional.

Nothing in P7-0 must be re-architected; the foundation is sound and the fixes are localized.

---

## 8. Final re-review — fix verification (2026-08-01)

Second independent pass over every file the P7-0 fixes touched (migration, integration test, implementation report). Production code was not modified during this review. Independent validation re-run against the live local stack.

### Finding disposition

| ID | Severity | Status | Evidence |
|---|---|---|---|
| **P70-R1** | REQUIRED | **RESOLVED** | Storage read policy now extracts the id via `split_part(storage.filename(name), '.', 1)::uuid` (`…_p70_document_foundations.sql:942`). Verified on the running DB: `storage.filename('documents/<clinic>/REVENUE_REPORT/<id>.pdf')` → `<id>.pdf`, `split_part(…,'.',1)` → the correct id UUID. The policy now passes for legitimate reads instead of failing closed. |
| **P70-R2** | MINOR (doc) | **RESOLVED** | `P7-0_IMPLEMENTATION.md:48-51` now states the correct path `documents/<clinic-id>/<doc_type>/<document-id>.pdf` and accurately describes what the read policy validates. |
| **P70-N1** | NIT | **RESOLVED** | `complete_document_issue` now returns a literal `false` on the publishing branch (`…:829`) and `true` only on the already-issued replay branch (`…:766`); no dead `not v_changed` flag remains. |

### New storage-RLS regression test (P70-R1 follow-up) — verified adequate

`tests/unit/integration/p70-document-foundations.test.ts:211-261` ("allows only own-clinic reads of an issued canonical PDF") covers all three required cases, and the clients are genuine RLS-scoped authenticated JWTs (`adminA`/`adminB` sign in via the publishable key; `adminB` belongs to a different clinic), not the service role:

- **Incomplete** — read of an uploaded object whose row is still `rendering` is denied (`:229-232`). ✔
- **Own-clinic** — after `complete_document_issue`, the owning clinic's authenticated read succeeds (`:244-249`). ✔ (This is the case that would have failed under the pre-fix `[4]` index — it proves R1 is really fixed.)
- **Cross-clinic** — the other clinic's authenticated read of the same issued object is denied (`:246, :250`). ✔

### Scope check

No P7-1+ scope or unrelated changes introduced by the fixes. `lib/documents/` still contains only `bidi.ts`, `catalog.ts`, `format.ts`, `issuance.ts`; no Chromium/Puppeteer/Playwright/QR/`pdf-lib`/`DocumentPage`/render-route markers anywhere in `lib/documents/` or `app/`. The catalog still registers only `REVENUE_REPORT` + `INVOICE`.

### Independent validation re-run

| Check | Result |
|---|---|
| Focused P7-0 unit/static suite (5 files) | **18/18 passed** |
| Live P7-0 Supabase integration (incl. new storage-RLS test) | **4/4 passed** |
| `tsc --noEmit` | **pass** (clean) |
| `storage.filename` id-extraction semantics on running DB | **confirmed correct** |

All required fixes verified; the storage-RLS test correctly covers incomplete, own-clinic, and cross-clinic reads; P70-R2 and P70-N1 are resolved; no scope creep.

---

## Verdict

**APPROVED**
