# P7-5 Review — Roster and profile document batch (archetypes B & C)

**Reviewer:** Claude (independent review)
**Date:** 2026-08-01
**Branch:** `feat/p7-document-platform`
**Scope reviewed:** P7-5 — documents 03 (Patient List), 04 (Patient File), 14 (System Members),
15 (Staff File): the four catalog entries, the versioned discriminated roster/profile snapshot
contract, the RLS-scoped resolvers, the optional attachment picker + `pdf-lib` merge, the shared
Layer-2 template, the roster/profile renderer, the shared contextual `/documents/roster-profile/[document]`
page, the issuance path, the canonical reprint RPC, lifecycle history, extended public verification,
the Patient List / Patient detail / System Staff / staff-row contextual triggers, AR/EN copy, and
migration `20260801150000_p75_roster_profile_document_batch.sql`.
**Method:** Read the analysis set (docs 01–15, especially roadmap §P7-5, catalog/taxonomy 02,
lifecycle 05, numbering 06, verification 07, data model 11, integration/reuse map 12), the four
P7-5 AR/EN `FIGMA_REFERENCE.md` files, the P7-4 review handoff, and the P7-5 implementation report;
read every P7-5-changed file plus the reused P7-0 issuance / P7-1 PDF+QR / P7-3 verification
infrastructure and the reused attachment sources (`patient_documents`, staff `clinic-assets`
paths); independently re-queried Figma via MCP for Patient File EN (`12:192`) and Staff File AR
(`23:3517`); cross-checked the frozen P7-2 conformance manifest; verified DB objects against
`types/database.ts`; and ran `tsc`, the P7-5 unit suite, and the message-parity gate.

Findings use stable IDs for the Claude→Codex handoff contract.

---

## Verdict summary

The roster + profile batch is complete and matches the approved roadmap (doc 13 §P7-5). All four
documents preview as DRAFT (no number, no verification block), issue through the frozen P7-0
idempotent foundation, freeze an immutable `version: 1` discriminated snapshot, allocate
per-clinic/per-type numbers (`PL`/`PF`/`SM`/`SF`), render server-side PDFs with QR, reprint the
canonical artifact, record actor-attributed history, and expose the unchanged five-field public
verification. Patient File and Staff File add opt-in issue-time attachment selection that is
tenant-scoped at listing, re-validated at issue, type/count/size/page-limited, and merged into the
single canonical artifact so reprints never re-read the sources. No engine or frozen
primitive-contract change was made. No P7-6+ clinical, module, settings, or delivery scope leaked.
Tests are meaningful and fail closed. Independent Figma re-inspection confirms the AR/EN node
mapping is correct (no reversal like Revenue's) and the templates reproduce the approved layouts.

No required fixes. Six non-blocking observations follow (three carried forward from P7-3/P7-4).

**Verdict: APPROVED.**

---

## Required verifications

### 1. Matches the approved roadmap — ✅ PASS

Doc 13 §P7-5 prescribes 03 Patient List + 14 System Members (GroupedTables roster) and 04 Patient
File + 15 Staff File (IdentityHero + FieldGrid + schedule profile) **with the attachment picker +
`pdf-lib` merge**, ordered roster → profiles → attachment merge. All four are present, correctly
archetyped, and depend only on P7-0…P7-3:

- `PATIENT_LIST_REPORT` (`roster`), `SYSTEM_MEMBERS_REPORT` (`roster`), `PATIENT_FILE` (`profile`),
  `STAFF_FILE` (`profile`) with frozen prefixes `PL`/`PF`/`SM`/`SF`
  ([lib/documents/catalog.ts:212-265](../../lib/documents/catalog.ts#L212-L265)); the two profiles
  carry `supportsAttachments: true`, the two rosters do not (asserted by
  [p75-roster-profile-documents.test.tsx:86-93](../../tests/unit/components/p75-roster-profile-documents.test.tsx#L86-L93)).
- Together with P7-3 Revenue + the P7-4 analytical seven this makes **12/16** documents complete —
  exactly the roadmap's P7-5 deliverable.
- The frozen P7-2 conformance manifest records all four as `verified` with the correct AR/EN node
  pairs and the exact primitive hierarchy each template composes
  ([p72-conformance-manifest.ts:116-128](../../components/documents/harness/p72-conformance-manifest.ts#L116-L128)).

### 2. Patient List, Patient File, System Members, Staff File complete in AR/EN — ✅ PASS

Each has a catalog entry, a thin body in the shared template
([roster-profile-documents.tsx](../../components/documents/templates/roster-profile-documents.tsx)),
full AR + EN copy including day names, role labels, and pluralized counts
([roster-profile-copy.ts](../../lib/documents/roster-profile-copy.ts)), a contextual trigger, and a
complete draft → locale-switch → draft-print → issue → reprint → history flow through the one
shared page ([documents/roster-profile/[document]/page.tsx](<../../app/(protected)/documents/roster-profile/[document]/page.tsx>)).
All new UI strings resolve through `documentPlatform.ui` keys present in both `messages/en.json` and
`messages/ar.json` (12/12 new keys mirrored). The component test renders all four in EN issued
(asserting exact primitive order + document number + real QR `<img src>`) and in AR issued
(asserting `dir="rtl"` and **no** Arabic-Indic digits).

### 3. Optional attachment inclusion is correct and safe — ✅ PASS

- **Opt-in, default none.** Attachments resolve only when `options.attachmentKeys?.length`
  ([roster-profile.ts:270](../../lib/documents/resolvers/roster-profile.ts#L270)); preview never
  passes keys, so drafts merge nothing. The picker only renders for the two profile types and only
  in draft state ([roster-profile-document-actions.tsx:65](../../components/documents/roster-profile-document-actions.tsx#L65)).
- **Tenant + subject scoped at listing.** Patient sources come from `patient_documents` filtered by
  `clinic_id` + `patient_id` + `deleted_at is null` + mergeable MIME; staff sources are enumerated
  only under `staff/{clinicId}/{staffId}` in `clinic-assets`
  ([roster-profile.ts:202-240](../../lib/documents/resolvers/roster-profile.ts#L202-L240)).
- **Re-validated at issue.** `selectAttachments` re-lists the current options and rejects any key
  not present, so a forged/stale key cannot inject a cross-tenant, cross-patient, or cross-staff
  path ([roster-profile.ts:242-253](../../lib/documents/resolvers/roster-profile.ts#L242-L253)).
- **Defense in depth at download.** `downloadAttachment` re-fetches through the authenticated
  client (storage RLS applies) and rejects any file whose live size differs from the recorded
  `sizeBytes` ([merge-attachments.ts:16-24](../../lib/documents/pdf/merge-attachments.ts#L16-L24)).
- **Word deliberately excluded.** The mergeable set is PDF/JPEG/PNG/WebP only; staff `mimeFromName`
  maps no other extension and the patient query filters by MIME, so stored Word files remain but are
  never offered — matching the approved contract.

### 4. Attachment type, count, size, and page limits enforced — ✅ PASS

All four limits are enforced, most in more than one place (fail-closed):

| Limit | Value | Enforcement |
|---|---|---|
| Count | 10 | `attachmentKeysSchema.max(10)` ([actions/documents.ts:51](../../actions/documents.ts#L51)); `selectAttachments` throws > `MAX_MERGED_ATTACHMENTS`; client disables Issue > 10 |
| Combined bytes | 25 MiB | `selectAttachments` and `mergeRosterProfileAttachments` both sum `sizeBytes`; client disables Issue > 25 MiB |
| Per-file bytes | 10 MiB | `downloadAttachment` throws when live `data.size > 10 MiB` |
| Merged pages | 100 | checked after **each** appended source in the merge loop ([merge-attachments.ts:69-71](../../lib/documents/pdf/merge-attachments.ts#L69-L71)) |
| Type | PDF/JPEG/PNG/WebP | `mergeableMimeSchema` + `mimeFromName`; non-matching content makes `pdf-lib` load throw → issue fails |

### 5. PDF merging preserves order and cannot cross tenant boundaries — ✅ PASS

- **Order preserved.** Sources are appended in selection order — PDF pages via
  `copyPages(source, getPageIndices())` then `addPage`, images fitted onto a fresh A4 page — after
  the canonical profile pages ([merge-attachments.ts:44-68](../../lib/documents/pdf/merge-attachments.ts#L44-L68)).
  The merge test proves a PDF + WebP append yields 3 self-contained pages.
- **No tenant crossing.** Every merged path originates from the clinic/subject-scoped listing and is
  re-validated by `selectAttachments`; the download runs under the caller's RLS session. There is no
  code path that accepts a raw path from the client — only opaque keys resolved against the scoped
  option set.
- **Self-contained.** The merge test clears the source store before re-loading `merged.pdf` and
  still reads 3 pages, proving the bytes carry no external reference.

### 6. Snapshot immutability and canonical reprint include selected attachments — ✅ PASS

- The selected `attachments` are frozen into the `version: 1` snapshot at reservation and merged
  into the artifact the moment it is stored ([renderers/roster-profile.tsx:28-29](../../lib/documents/renderers/roster-profile.tsx#L28-L29)).
- Reprint calls `record_roster_profile_document_reprint`, which returns the **stored**
  `pdf_storage_path` and never re-renders or re-reads the source attachments; the action mints only
  a 5-minute signed URL ([actions/documents.ts:708-731](../../actions/documents.ts#L708-L731)). Thus
  later deletion or replacement of a source cannot change a reprint (doc 11 §6 satisfied).
- `getIssuedRosterProfileDocument` pins `clinic_id` + `doc_type` + `id` and re-checks
  `snapshot.documentType`, and the renderer hard-fails when `reservation.documentType !==
  snapshot.documentType` — snapshot/identity/type cannot drift.

### 7. Contextual actions and public verification labels correct — ✅ PASS

- Triggers deep-link to the shared route with the right scope: Patient List from `/patients`
  (forwarding department/doctor/search query), Patient File from the patient detail page
  (`?patientId=`), System Members from `/settings/staff`, and Staff File from the staff-row menu
  (`?staffId=`). Labels resolve through `DocumentTriggerLabel` / `staffFileDocument` i18n keys.
- The public verify page adds all four type labels
  ([verify/[token]/page.tsx:114-117](<../../app/(public)/verify/[token]/page.tsx#L114-L117>)) while
  the type-agnostic `lib/documents/verification.ts` disclosure boundary (five fields) is unchanged;
  `robots: noindex`, closed-mode IP rate limiting, token-shape validation, and enumeration-safe
  collapse to `unavailable` are all retained from P7-3/P7-4.

### 8. Existing lifecycle, numbering, QR, history, branding, settings reused correctly — ✅ PASS

- Issuance flows through the frozen `issueDocumentFoundation` → `reserve_document_issue` →
  `allocate_document_number` guard; the batch never touches the allocator directly and inherits the
  idempotency + render-failure rollback semantics (namespaced key
  `roster-profile:<type>:<uuid>`).
- Numbering prefix / yearly-reset / padding resolve override → global → catalog default
  ([roster-profile.ts:289-293](../../lib/documents/resolvers/roster-profile.ts#L289-L293)); watermark
  and QR toggle resolve from `document_settings` with the same precedence.
- QR encodes the opaque verification token via the frozen `generateDocumentVerificationQrDataUrl`,
  never the sequential number, and only when `settings.qrEnabled`.
- Branding (name, logo, address, phone, email, website, license, tax id, footer) is read from
  `clinics` and inlined at issue time; history reuses the actor-attributed `document_events` read.
- The reprint RPC is `SECURITY DEFINER`, `search_path = ''`, `owner to postgres`,
  `revoke … from public, anon`, `FOR UPDATE` clinic + type + status scoped, with a per-type role
  gate: staff types (`SYSTEM_MEMBERS`/`STAFF_FILE`) → admin/manager; patient types
  (`PATIENT_LIST`/`PATIENT_FILE`) → SCOPED_OPERATIONAL_ROLES. These exactly match the catalog
  `pageRoles`, and every action independently re-authorizes via `requireRosterProfileDocumentAccess`.

### 9. Visual polish improves quality without redesigning Figma — ✅ PASS

The template composes **only** frozen Layer-1 primitives in the P7-2-approved order per document
(verified one-to-one against the manifest). Independent Figma re-inspection: node `12:192` renders
Patient File in English (LTR) with the identity hero → profile-details section → two-column field
grid → dual signatures → QR, and node `23:3517` renders Staff File in Arabic (RTL) with the
identity block → weekly schedule table → 40.0-hour total → administrative notes → signatures → QR.
Both match the templates' structure. No new primitive, no engine change, no `@page`/pagination
change.

### 10. No P7-6+ scope leaked — ✅ PASS

`DOCUMENT_CATALOG` registers only Revenue + the analytical seven + the four P7-5 types + the P7-0
Invoice skeleton; `PRESCRIPTION`, `SICK_LEAVE_CERTIFICATE`, `LAB_REQUEST` remain type codes only,
unregistered. Under `app/(protected)/documents/` there is only `engine-harness` (P7-1/P7-2 dev
route) and the P7-5 `roster-profile` contextual route — no `/documents` list/detail/new module, no
`/settings/documents`, no delivery flow. The only new dependency is `pdf-lib` (roadmap-sanctioned);
`sharp` was already present. `types/database.ts` adds only the one reprint RPC.

### 11. Tests meaningful and fail closed — ✅ PASS

- **Component** ([p75-roster-profile-documents.test.tsx](../../tests/unit/components/p75-roster-profile-documents.test.tsx)):
  pins the exact primitive hierarchy per type, the rendered document number, the real QR `<img>`,
  AR `dir="rtl"`, absence of Arabic-Indic digits, attachments opt-in, and the admin/manager gate on
  System Members.
- **Merge** ([p75-pdf-attachment-merge.test.ts](../../tests/unit/lib/p75-pdf-attachment-merge.test.ts)):
  proves order + self-contained bytes across PDF + WebP, and rejects a source whose bytes changed
  after selection (fail closed).
- **Migration** ([p75-roster-profile-document-batch-migration.test.ts](../../tests/unit/db/p75-roster-profile-document-batch-migration.test.ts)):
  restricts reprint to the four types, excludes `INVOICE`/`PRESCRIPTION`, asserts clinic scope,
  counter increment, `reprinted` history, `security definer`, empty `search_path`, no `delete`, and
  the staff-vs-patient role split.
- **Catalog** ([p70-document-catalog.test.ts](../../tests/unit/lib/p70-document-catalog.test.ts))
  covers the registration invariants.

---

## Independent validation run

| Check | Command | Result |
|---|---|---|
| TypeScript | `tsc --noEmit` (`pnpm typecheck`) | ✅ exit 0 |
| P7-5 unit suite | `vitest run` merge + component + migration + catalog | ✅ 4 files, 16 tests |
| Message parity | `node scripts/check-messages.mjs` (via test suite gates) | ✅ 12/12 new keys mirrored AR/EN |
| Figma MCP re-inspection | `get_screenshot` Patient File EN `12:192` + Staff File AR `23:3517` | ✅ mapping + layout confirmed, no reversal |
| Conformance manifest | P7-2 entries 3/4/14/15 | ✅ `verified`, correct AR/EN nodes, hierarchy matches templates |

(Full `pnpm lint` / `lint:rtl` / `lint:i18n` / `pnpm build` and the local migration apply were
reported green by the implementation report; I did not re-run the full lint/build here — nothing in
the reviewed diff suggests a regression, and typecheck plus the RTL/Latin-digit/i18n assertions in
the suite pass.)

---

## Non-blocking observations

- **P7-5-N1 (fidelity, defer to P7-10 QA): staff photo path is reconstructed by convention at
  issue.** `loadStaffFile` inlines the staff photo from a *derived* path
  `staff/{clinicId}/{id}/photo.{ext}` (ext parsed from `avatar_url`), while preview shows the raw
  `avatar_url`. If the real storage layout differs, the issued Staff File PDF can silently omit the
  photo the draft displayed. Cosmetic, fail-safe (missing image, never a wrong one) — flag for the
  §P7-10 AR/EN visual pass.

- **P7-5-N2 (informational): reprint permitted on `void`/`cancelled` and increments `print_count`
  on retired documents.** Same accepted semantics as **P7-3-N2 / P7-4-N2**, now propagated to the
  four roster/profile types. Intentional, but re-serving a voided document's counter remains a minor
  oddity to revisit in P7-10.

- **P7-5-N3 (informational): idempotency key regenerated per page render.** The `randomUUID()` is
  minted in the server page and passed to the action, so a browser **refresh** then re-issue mints a
  second document + number for the same subject/filters. Identical to **P7-3-N1 / P7-4-N1**; still
  consistent with doc 05's "regenerate = new issue" semantics. Worth the founder confirming no
  natural-key backstop is wanted before more surfaces copy it.

- **P7-5-N4 (test depth): reprint RPC covered by source-assertion + local apply, not a live
  integration test.** Unlike P7-4 (which exercised cross-tenant `P0002` and role `42501` on the
  running stack), P7-5 asserts the migration text and relies on the local apply. The assertions are
  meaningful, but a live integration test proving tenant isolation + the staff-vs-patient role gate
  against the real RPC would strengthen the guarantee. Recommend adding it in P7-10 hardening.

- **P7-5-N5 (informational): Patient List doctor department-scope is skipped when the doctor has no
  `departmentId`.** `loadPatientList` narrows to the doctor's department only `if (user.role ===
  "doctor" && user.departmentId)`; a doctor without a department sees all active clinic patients.
  This mirrors the likely on-screen `/patients` behavior, but confirm it is the intended scope for a
  department-less doctor.

- **P7-5-N6 (copy latitude, informational): platform vocabulary differs from Stitch placeholder
  copy.** The Figma frames use placeholder labels ("PATIENT PROFILE", "Profile Details", "Patient
  Affairs Approval"); the implementation uses the platform's consistent bilingual vocabulary
  ("Patient File", "Personal details", "Medical director"). Layout, hierarchy, and tokens conform —
  this is deliberate localized copy, not a redesign. Noted only for completeness.

---

## Verdict

APPROVED
