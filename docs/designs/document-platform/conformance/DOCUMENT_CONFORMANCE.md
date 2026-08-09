# P7-2 Per-Document Conformance Sheet

**Gate result:** PASSED. All 32 variants have complete Figma inspection evidence and all sixteen
documents conform after the approved Prescription A4 cleanup.
`DocumentHeader` and `DocumentFooter` are implicit for every row because `DocumentPage` owns them.

Evidence labels:

- **verified** — node inspected through Figma MCP and mapped to the frozen contract;
- **approved cleanup** — inspected source inconsistency is normalized under an explicit decision
  without expanding the frozen engine contract.

Revenue Report mapping correction (2026-08-01): direct Figma re-inspection confirmed that the
imported locale references were reversed; Arabic is `8:262` and English is `8:18`. The source
records were corrected without changing the primitive map or gate result.

| # | Document | Archetype | Arabic | English | Frozen body primitive map | Cleanup / decision | Result |
|---:|---|---|---|---|---|---|---|
| 01 | Revenue Report | analytical | `8:262` verified | `8:18` verified | StatCardRow → SectionHeader → DataTable → TotalsSummary → NotesCallout → VerificationBlock → SignatureBlock | common cleanup | conformant |
| 02 | Follow-up Page Report | analytical | `11:638` verified | `11:507` verified | SectionHeader → StatCardRow → DataTable → StatusBadge → VerificationBlock → SignatureBlock | common cleanup | conformant |
| 03 | Patient List Report | roster | `11:1121` verified | `11:814` verified | GroupedTables → StatusBadge → VerificationBlock → SignatureBlock | grouped department tables and blood/status cells fit frozen primitives | conformant |
| 04 | Patient File | profile | `12:19` verified | `12:192` verified | IdentityHero → SectionHeader → FieldGrid → StatusBadge → VerificationBlock → SignatureBlock | identity banner, profile grid, verification, and signatures confirmed | conformant |
| 05 | Prescription | clinical | `12:367` verified | `12:521` verified | FieldGrid → SectionHeader → DataTable → NotesCallout → VerificationBlock → SignatureBlock | normalize both inconsistent A5 frames to shared A4 portrait while preserving hierarchy, spacing, content, and RTL/LTR balance | conformant |
| 06 | Sick Leave Certificate | clinical | `16:335` verified | `14:187` verified | SectionHeader → FieldGrid → CertifyingProse → NotesCallout → VerificationBlock → SignatureBlock | common cleanup | conformant |
| 07 | Lab Request | clinical | `17:496` verified | `17:736` verified | FieldGrid → SectionHeader → ChecklistPanel → NotesCallout → VerificationBlock → SignatureBlock | common cleanup | conformant |
| 08 | Cancellation Report | analytical | `18:1168` verified | `18:956` verified | NotesCallout → StatCardRow → SectionHeader → DataTable → TotalsSummary → VerificationBlock → SignatureBlock | remove captured application chrome and floating controls | conformant |
| 09 | No-show Report | analytical | `19:1381` verified | `19:1552` verified | StatCardRow → SectionHeader → DataTable → TotalsSummary → NotesCallout → VerificationBlock → SignatureBlock | common cleanup | conformant |
| 10 | Sales Report | financial | `19:1718` verified | `19:1882` verified | SectionHeader → StatCardRow → DataTable → TotalsSummary → NotesCallout → VerificationBlock → SignatureBlock | repeated tables remain DataTable compositions | conformant |
| 11 | Follow-up Analytics Report | analytical | `20:2232` verified | `20:2074` verified | SectionHeader → NotesCallout → StatCardRow → DataTable → VerificationBlock → SignatureBlock | progress/share visuals are cell content, not a primitive | conformant |
| 12 | Doctor Performance Report | analytical | `20:2398` verified | `20:2595` verified | StatCardRow → SectionHeader → DataTable → NotesCallout → VerificationBlock → SignatureBlock | departmental metrics reuse stat/table content | conformant |
| 13 | Receptionist Performance Report | analytical | `21:2783` verified | `21:2934` verified | SectionHeader → NotesCallout → StatCardRow → DataTable → VerificationBlock → SignatureBlock | remove print controls explicitly marked non-document content | conformant |
| 14 | System Members Report | roster | `22:3305` verified | `22:3081` verified | FieldGrid → GroupedTables → StatusBadge → NotesCallout → VerificationBlock | role/status variants fit existing badge/table contracts | conformant |
| 15 | Staff File | profile | `23:3517` verified | `23:3734` verified | SectionHeader → IdentityHero → FieldGrid → StatusBadge → DataTable → TotalsSummary → NotesCallout → SignatureBlock → VerificationBlock | sample photo/signature/QR become governed slots | conformant |
| 16 | Invoice | financial | `24:3936` verified | `24:4133` verified | IdentityHero → StatusBadge → TotalsSummary → DataTable → NotesCallout → FieldGrid → VerificationBlock → SignatureBlock | sample tax/brand/payment values remain dynamic | conformant |

## Common cleanup

Every row removes non-printable canvas/browser capture artifacts, replaces placeholder QR artwork
with the generated verification QR, and converts sample branding and issue data into dynamic slots.

## Reproduction proof

The development-only harness renders both locales of every candidate map through `DocumentPage`.
Tests prove exact catalog coverage, exact map order, membership in the frozen primitive set, RTL/LTR
direction, Latin digits, portrait orientation, and data-URI-only images. The Prescription harness
uses the same A4 `DocumentPage` geometry as every other portrait document; no A5 engine mode exists.
