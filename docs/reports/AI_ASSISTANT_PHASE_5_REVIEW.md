# AI Assistant — Phase 5 (Domain write parity, 5a–5e) Re-review

**Verdict: not yet PASS — 2 remaining findings, both Low.**

Re-reviewed after the remediation described in `AI_ASSISTANT_PHASE_5_IMPLEMENTATION.md`, against
`docs/plans/AI_ASSISTANT_FULL_CAPABILITY_PLAN.md` §8, §11, §15 (Phase 5), §16.
Scope: the real working-tree diff only — `lib/{appointments,patients,followups,clinical,billing,settings}/mutations.ts`,
`lib/domain-mutations.ts`, `actions/_domain.ts`, the `actions/**` adapters, the six surviving `*-legacy.ts`
compatibility modules, `lib/ai/actions/**`, `lib/ai/conversation-parts.ts`, and the Phase 5 tests.
No production code was modified by this review (negative-control probes were applied and reverted; all five
probed files were verified byte-identical afterwards by checksum).

---

## Findings from the previous review: resolution status

| ID | Severity | Status | Evidence |
|---|---|---|---|
| P5-01 | Blocker | **Resolved** | `pnpm build` exits 0. No `"use server"` module under `actions/` declares a non-async exported function. The invariant test at `tests/unit/ai/phase5-domain-write-parity.test.ts:293` walks every `actions/**` module; probe (reverting one export to `export function`) fails it. |
| P5-02 | High | **Resolved** | `lib/patients/mutations.ts:508-571` restores the tenant-bound admin lookup, the patient clinic/`is_deleted` check, and `mayMutateNote` (byte-equivalent to `HEAD:actions/patients.ts:94-100`'s `canMutateMedicalNote`). The update now asserts exactly one affected row. Same-tenant integration test proves admin restore, author-doctor restore, and non-author refusal with the row unchanged; probe (deleting the ownership check) fails it. |
| P5-03 | Medium | **Resolved** | `deleteDependents` (`lib/appointments/mutations.ts:654-692`) snapshots all four dependent tables via the tenant-bound admin client, requires each delete's returned id count to equal the snapshot count, and `restoreDependents` upserts on partial failure. `permanentDeleteAppointmentMutation` requires exactly one deleted appointment row and rolls dependents back otherwise. Probe (reverting to `every(r => !r.error)`) fails `tests/unit/actions/appointment-deletion-safety.test.ts:245`. Same-tenant RLS test covers admin **and** manager for soft + permanent delete with all four dependent kinds seeded. |
| P5-04 | High | **Resolved** | `actions/_domain.ts:45-49` always populates `error` (first localized field error, else the coded message). Probe (restoring the old `undefined` branch) fails `tests/unit/actions/phase5-domain-failure-adapter.test.ts:23`. UI regression covered by `tests/unit/components/phase5-invoice-followup-validation.test.tsx`. |
| P5-05 | Medium | **Resolved** | No dotted action-error key survives as a zod `message` in any of the six mutation modules — the only custom messages left are `validation.required` / `validation.invalidFormat`. Domain-specific copy travels through `fieldErrorCodes` (`followups/mutations.ts:104,190`; `patients/mutations.ts:71`; `settings/mutations.ts:825`) and is localized by the adapter. |
| P5-06 | Low | **Resolved** | `appointments.clinicClosedOnDay` added to the weekday-localization branch (`actions/_domain.ts:36-44`); EN/AR tests assert a weekday name and reject the digit. |
| P5-07 | Medium | **Resolved** | `staff.create` is registered with `staffCreateNonPrivilegedActionSchema` — `.strict()`, no password field, `role` enum limited to `receptionist \| doctor \| assistant`. The core generates the credential server-side (`serverGeneratedTemporaryPassword`) and returns it only as `data.one_time_temporary_password`. The model-facing `execute_action` tool **previews only** (`lib/ai/tools/execute-action.ts`); execution runs through the authenticated `confirmAssistantAction` server action, whose result stays in component state (`assistant-chat.tsx:523`) and is rendered as a one-time card. Receipts store digests only (`lib/ai/actions/execute.ts:144-156`). `boundedAssistantParts` additionally redacts any `*password*` key before persistence. Manager/admin creation via the Assistant is refused at schema level. |
| P5-08 | Medium | **Resolved** | `patient-packages-legacy.ts` and `package-templates-legacy.ts` are gone; the six surviving compatibility modules export no superseded mutation symbol, asserted by an invariant over a 59-name list. |
| P5-09 | Medium | **Substantially resolved** — see F-2 for residual depth gaps | The source-text "same core" assertion is gone. The role matrix is now discriminating: for all 74 actions × 5 roles it requires the registry's declared roles to match the `DomainMutationAuthorizationError` the real core raises — probe (adding `"doctor"` to `appointments.soft_delete`) fails it. Independently, I compared every role array against `HEAD` (`requireMutationRole` / `requireRole` / `CLINICAL_PREPARER_ROLES`): appointments create/replace/delete/undo/start-session, follow-ups, patients, medical notes, clinical (all five roles), billing, package templates, and settings (admin+manager, admin-only for working hours and staff schedules) all match exactly. Same-tenant positive RLS coverage now exists for the paths P5-02/P5-03 implicated. |
| P5-10 | Low | **Resolved** | `seedDefaultPagePermissions` restores the `user_customizations` fallback on a missing `user_page_permissions` table; `rollbackCreatedStaff` deletes the profile **and** the auth user; department and supervising-doctor validation runs before auth-user creation. Four dedicated tests (`auth-staff-boundaries.test.ts:405,437,467`). |
| P5-11 | Low | **Partially resolved** — see F-1 | `appointments.confirm_and_displace` is reclassified `bulk` with a per-conflict preview row, and the appointment `idAction` previews now lead with `appointmentIdentifier` (patient, doctor, scheduled time, id) rather than stringified objects. The fix was not extended to the other destructive families, and the registry-wide acceptance test was not written. |

Also confirmed:

- **No Phase 5f or out-of-scope surface leaked in.** The 74 registered ids contain no role change, permission grant,
  staff activate/deactivate/delete, password reset, plan/billing/subscription or operator action; no action declares
  `risk: "privileged"` or `ai.write_privileged`. Role/activation/deletion/password paths in `actions/settings.ts`
  are explicit re-exports of the legacy UI-only implementations.
- **All 74 definitions wire to a real shared core**, verified by reading every definition in
  `lib/ai/actions/definitions/{appointments,followups,patients,clinical,billing,settings}.ts`, not only via the test.
- **UI adapters and Assistant actions share the same cores.** No converted adapter contains `.from(` or
  `createClient(`; `createAppointment`'s `redirect` and `createPatient`/`softDeletePatient`'s redirects are preserved.
- **Unrelated dirty work is untouched.** Every file modified during remediation has a Phase 5 mtime; the P7 document
  platform (`lib/documents/**`, `components/documents/**`, migrations, `types/database.ts`) is unchanged by it.
  The only non-Phase-5 files touched are `lib/ai/conversation-parts.ts` (credential redaction), `assistant-chat.tsx`
  and the message catalogs (one-time-password card) — all required by P5-07.

---

## F-1 — Low — Destructive patient-lifecycle previews name no record and verify nothing

**Where:** `lib/patients/mutations.ts:246-255` (`mutatePatientLifecycle`, preview branch);
`lib/ai/actions/definitions/patients.ts:160-174` (`patientLifecycleAction.preview`)

`patients.soft_delete` and `patients.archive` are `risk: "destructive"`. §11 requires that for a destructive action
"the preview must name the exact records" — the requirement P5-11 raised and that was fixed for appointments only.

The preview branch returns an audit with `after` only: no `before`, and no read of the patient at all. Because
`scalarChanges` renders a missing `before` as `null`, the confirmation card the human approves reads:

```
is_deleted   — → true
deleted_at   — → 2026-08-14T…
is_archived  — → —
archived_at  — → —
```

No name, no file number, not even the patient id. Two consequences:

1. The named-records guarantee of §11 is not met for the most consequential destructive family in the phase.
2. Preview performs no existence or tenant pre-check, so a well-formed uuid that does not exist — or belongs to
   another clinic — still produces a successful preview and a valid confirm token. The write itself is safe
   (`soft_delete_patient` is clinic-scoped and execute returns `patients.patientNotFound`), so this is a preview
   fidelity defect, not an isolation defect. It does contradict §8.3's "all business-rule pre-checks + a dry-run
   against the domain core."

A lesser instance of the same shape: `billing.undo_appointment_completion` (destructive) previews `patient_id`
and amounts, identifying the record only by uuid. `medical_notes.delete` shows the note text, and the settings
`*.soft_delete` / `*.permanent_delete` previews carry the directory row's `name`, so those are acceptable as-is.

The acceptance test P5-11 asked for — "every `destructive`/`bulk` action's preview `changes` contain human-readable
record identifiers and no `{`-prefixed JSON" — was not written. What exists is a unit assertion on the
`appointmentIdentifier` helper plus a risk-class check on `appointments.confirm_and_displace`
(`phase5-domain-write-parity.test.ts:431`), which cannot see the patient family.

**Required fix:** in the patient lifecycle preview, read the patient tenant-scoped (`full_name`, `file_number`, `id`),
set `audit.before`, and lead the `changes` list with a `patient` entry in the shape `appointmentIdentifier` uses;
give `billing.undo_appointment_completion` the same treatment. Then add the registry-wide test: for every action with
`risk` in `{destructive, bulk}`, the preview's `changes` must contain at least one entry whose rendered value is a
human-readable identifier and none that begins with `{`.

**Acceptance:** deleting the patient-name entry from any destructive preview fails the suite.

---

## F-2 — Low — Residual P5-09 coverage gaps

The tautological tests are gone and the replacements are genuinely discriminating — I confirmed that by probe for
the role matrix, the async-export invariant, the failure adapter, dependent-delete row counts, and medical-note
ownership. Three gaps remain against the review's stated required fix.

**(a) The definition → core mapping is asserted by a hand-maintained table, not by the definitions.**
`invokeSharedCore` (`phase5-domain-write-parity.test.ts:81-194`) is an independent literal map from action id to core.
The test therefore proves that each *core* exists and enforces its own validation and role boundary; it does not prove
that the *definition* with that id calls that core. Rewiring `patients.archive` to `softDeletePatientMutation` would
keep the suite green. I verified all 74 wirings by reading, so there is no defect today — only no guard against one.

**(b) Role arrays are still not asserted against the surviving UI source of truth.** The review asked for the legacy
constants to be imported and compared. `CLINICAL_PREPARER_ROLES` (`actions/clinical/_shared.ts:10`) still exists and is
still what the UI clinical actions enforce, yet `CLINICAL_MUTATION_ROLES` re-declares the same five roles by hand with
no assertion tying them together. The runtime matrix compares registry-to-core; a change applied to both at once
passes. (I verified equality against `HEAD` manually for every family — they match.)

**(c) Same-tenant positive integration coverage is narrow, and the admin path is not exercised under RLS.**
`phase5-domain-write-rls.test.ts` adds positives only for medical-note restore and appointment soft/permanent delete —
not "every extracted write" as required. Separately, the suite mocks `createClinicScopedAdminClient` to return the
plain service-role client (`:20-25`), so every admin-client path in the cores runs with RLS fully bypassed and the
helper's own tenant binding is never tested. The cores do bind `clinic_id` explicitly at each call site, which is why
this is Low rather than Medium.

**Required fix:** (a) derive the core under test from the definition — e.g. spy on the mutation modules and assert the
expected export was called when `previewRegisteredAction` runs — or drop the claim that the test covers the wiring;
(b) import `CLINICAL_PREPARER_ROLES` and assert set-equality with `CLINICAL_MUTATION_ROLES`, and do the same for any
other legacy constant still in the tree; (c) extend the same-tenant positives to at least one write per 5a–5e family,
and add one case that exercises the real `createClinicScopedAdminClient` to prove its clinic binding holds.

**Acceptance:** repointing any definition at a different core fails the suite; widening `CLINICAL_PREPARER_ROLES`
alone fails the suite; each of the six domains has an executed same-tenant positive.

---

## Verification performed

All commands run on this working tree; local Supabase keys from `supabase status -o env`.

| Check | Result |
|---|---|
| `pnpm build` | **Pass** (exit 0) — resolves P5-01 |
| `pnpm typecheck` | Pass |
| `pnpm test` | Pass — 343 files, 2,502 tests |
| `pnpm test:integration` (local stack) | Pass — 53 files passed / 1 skipped; 455 tests passed / 3 skipped |
| `pnpm test:ai-adversarial` | Pass — 2 files, 109 tests |
| `pnpm lint` | Pass — 0 errors, 26 pre-existing warnings outside the remediated files |
| `pnpm lint:rtl` | Pass — 666 files, 17 documented exceptions |
| `pnpm lint:i18n` | Pass — 438 files, 43 documented exceptions |
| `pnpm i18n:missing` / `pnpm i18n:unused` | Pass — 3,968 base leaf messages; no unreferenced keys |
| Negative control: widen `appointments.soft_delete` roles with `"doctor"` | **Caught** — role-matrix test fails |
| Negative control: `export async function softDeleteDepartment` → `export function` | **Caught** — async-export invariant fails |
| Negative control: `_domain.ts` drops `error` on `validationError` | **Caught** — failure-adapter test fails |
| Negative control: `deleteDependents` ignores row counts | **Caught** — `appointment-deletion-safety.test.ts:245` fails |
| Negative control: remove `mayMutateNote` from `restoreMedicalNoteMutation` | **Caught** — same-tenant RLS test fails |
| Role arrays vs `git show HEAD:actions/**` (`requireMutationRole` / `requireRole` / `CLINICAL_PREPARER_ROLES`) | Identical for every family |
| All 74 definition → core wirings read individually | Correct |
| Probed files restored and checksum-verified | 5/5 byte-identical |

## Required before Phase 5 can pass

1. F-1: name the record in the destructive patient-lifecycle (and `billing.undo_appointment_completion`) previews,
   and add the registry-wide destructive/bulk preview test P5-11 specified.
2. F-2: close (a), (b) and (c), or record an explicit waiver for each.

Nothing in F-1 or F-2 blocks deployment or affects tenant isolation; both are preview-fidelity and
test-durability items. All eleven original findings' functional and security substance is resolved.
