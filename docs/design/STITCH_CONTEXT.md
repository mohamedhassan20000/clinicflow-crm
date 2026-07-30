# ClinicFlow Document System — Stitch Design Handoff

**Purpose:** Design ClinicFlow's complete printable document ecosystem, including the committed P7 document families. Preserve the current ClinicFlow application and create an implementation-ready visual language for every printable artifact.

**Source of truth:** The field, permission, lifecycle, numbering, legal, and delivery requirements live in `docs/documents/`. This handoff explains the product and visual context; it does not replace those specifications.

## 1. Project overview

### What ClinicFlow is

ClinicFlow is a multi-tenant clinic operations SaaS for managing patients, appointments, billing, follow-ups, staff, reports, messaging, and an authorized AI assistant. It serves day-to-day medical administration while protecting tenant boundaries, patient privacy, and role-specific access.

The P7 document system adds eight committed professional document families:

| Document | Paper | Primary actor | Output |
|---|---|---|---|
| Invoice | A4 portrait | Authorized billing staff | Preview, print, PDF; existing manual Email/WhatsApp delivery |
| Receipt | A5 portrait | Authorized payment actor | Preview, print, PDF |
| Prescription | A5 portrait | Authorized doctor | Preview, print, PDF |
| Medical report | A4 portrait | Authorized doctor | Preview, print, PDF |
| Sick-leave certificate | A4 portrait | Authorized doctor | Preview, print, PDF |
| Referral | A4 portrait | Authorized doctor | Preview, print, PDF |
| Lab request | A4 portrait | Authorized doctor | Preview, print, PDF |
| Consent-form family | A4 portrait | Authorized staff prepares an unsigned form | Preview, print, PDF |

### Target users

- Clinic owners and administrators: governance, branding, billing, and document oversight.
- Managers: permitted operational and financial workflows.
- Receptionists: high-frequency patient, appointment, payment, invoice, receipt, and form workflows.
- Doctors: clinical documents within their authorized patient scope.
- Patients and external recipients: readers of clear, credible, privacy-conscious documents.
- Auditors or verifiers: readers who need document identity and authenticity without unnecessary medical or financial exposure.

### Product philosophy

ClinicFlow is operational software, not a decorative wellness product. It favors:

- clarity before novelty;
- accurate, source-backed data before convenience;
- explicit human confirmation for consequential actions;
- role-aware workflows and privacy by default;
- calm, compact interfaces for repeated daily use;
- Arabic and English as equal product experiences;
- reusable systems that allow additive growth without redesign.

### Premium SaaS positioning

The desired quality is comparable to high-end commercial medical software: polished, composed, and dependable. “Premium” means excellent typography, disciplined alignment, strong information hierarchy, robust edge cases, and faithful output—not ornament, luxury styling, or visual excess.

The documents should feel unmistakably related to ClinicFlow while allowing each clinic’s identity to lead. ClinicFlow supplies the system; the clinic remains the visible issuer.

## 2. Existing visual identity

### Color palette

The application uses semantic OKLCH tokens. Approximate sRGB values below are for visual handoff; preserve the semantic roles rather than treating the hex values as a new palette.

| Role | Current appearance | Use |
|---|---:|---|
| Primary teal | `#0095AB` | Primary actions, focus, selected states, restrained document accents |
| Cyan accent | `#1ACFDF` | Secondary emphasis; use sparingly on documents |
| Deep teal/navy | `#001F35` | Sidebar and high-trust dark surfaces; suitable as primary document ink |
| Light background | `#F6FCFD` | Application canvas |
| White | `#FFFFFF` | Cards, popovers, and document paper |
| Foreground ink | `#001B29` | Primary text |
| Muted surface | `#EBF6F8` | Subtle grouping and table headers |
| Muted text | `#506E7A` | Secondary labels and metadata |
| Border | `#D7E4E7` | Fine separators and control outlines |
| Success | `#00B26A` | Valid/success state, never the only cue |
| Warning | `#F2A618` | Attention and incomplete requirements |
| Destructive | `#F22C2D` | Invalid, void, or destructive state |

For printed documents, use a predominantly white, deep-ink, and neutral system. Teal is an identifying accent, not a large color wash. Designs must remain legible in grayscale and on ordinary office printers. Do not use clinical/status color as the only carrier of meaning.

### Typography

- English UI: **Manrope**, variable weight.
- Arabic UI: **Thmanyah Sans**, weights 300, 400, 500, 700, and 900. It has no true 600 weight and no italics.
- English headings use compact tracking (`-0.02em`) and generally 600 weight.
- Arabic body defaults to 400 with approximately 1.65 line height; Arabic headings use 700 with approximately 1.35 line height and normal tracking.
- Data and identifiers use tabular alignment where useful. Serial numbers, codes, URLs, email addresses, and QR labels remain isolated LTR runs with ASCII digits in both languages.

Thmanyah is the application’s licensed Arabic face, but its PDF-embedding rights are not assumed. The document system must remain visually sound with an approved, embeddable Arabic sans fallback. Font licensing and Arabic shaping are release gates, not details to resolve through visual substitution at implementation time.

### Spacing, radius, and shadows

- The application follows a 4 px spacing base, most often using 8, 12, 16, 20, 24, 32, and 40 px.
- Compact controls are typically 32–36 px tall; important navigation targets are at least 44 px.
- Base radius is 8 px. Controls use about 8 px; cards, dialogs, and active navigation commonly use 12 px.
- Cards are separated primarily by a 1 px border/ring, not elevation.
- Shadows are restrained: small on active cards, medium on popovers, and large only on overlays/sheets. Print output removes shadows.

P7B may define a print-specific spacing and type scale, but its rhythm should remain recognizably ClinicFlow. Paper layouts should use grids, rules, whitespace, and bands rather than reproducing dashboard cards and rounded containers everywhere.

### Existing component style

- White or dark token-based surfaces with fine borders.
- Rounded rectangular controls, simple Lucide line icons, and concise sentence-case labels.
- Teal-filled primary buttons; outline, ghost, muted, and low-tint destructive alternatives.
- Cards use clear headers, compact metadata, and restrained section dividers.
- Tables use a solid muted header, strong header rule, lighter row dividers, hover feedback, and tabular numeric alignment.
- Empty states use a small icon, direct explanation, and an optional next action—not illustration-heavy scenes.
- Motion is short and functional: fades, small zooms, pulses, and sheet transitions.

### Light and dark mode

The authenticated application supports per-user light and dark themes. All application chrome around document creation and preview must work in both.

The document artifact itself is theme-independent: a white paper canvas with stable print colors in light mode, dark mode, PDF, and print. Do not create a dark document variant. A dark application preview should frame the same white document with sufficient separation and no color adaptation inside the issued artifact.

### RTL and accessibility

- English is LTR; Arabic is semantic RTL.
- Layout uses logical start/end properties and mirrors directional icons.
- Arabic tables may mirror approved column order; embedded LTR runs must not reorder or break.
- Locale changes content and direction, never theme.
- Use semantic headings, labels, tables, captions, page landmarks, and status messages.
- Maintain visible keyboard focus, accessible names, logical focus order, 44 px primary touch targets, and WCAG-compliant contrast.
- Loading regions use an announced status; errors are specific and actionable.
- Do not encode status only through hue, watermark, icon, or position.

## 3. Existing application UX

### Shell and navigation

The desktop application has a persistent deep-teal sidebar, 288 px expanded or 80 px collapsed, plus a 72 px top header. Navigation is role-aware and server-derived. The active item is a rounded high-contrast row; inactive items are quiet and become stronger on hover/focus.

Below the medium breakpoint, the sidebar disappears and opens as a 288 px inline-start sheet from a menu button. The header retains the ClinicFlow mark, theme control, and user menu. The main content area uses approximately 20 px mobile / 40 px large-screen horizontal padding and 24 px / 32 px vertical padding.

Stitch must not add or reorganize top-level navigation for P7. Document actions enter from the existing patient, appointment, billing, or later document-generation surfaces defined by P7E.

### Page and dashboard style

Pages open with a compact title, short description, optional breadcrumbs/back link, and a wrapped action group. Dashboards use responsive KPI grids and bordered panels with restrained charts. The hierarchy is shallow, scan-friendly, and optimized for operational density.

The document preview experience should sit naturally inside this shell: familiar page header and action placement outside a focused paper workspace.

### Forms

Forms use visible labels, compact inputs/selects, inline localized validation, optional hints, and clear required/optional language. Related fields are grouped in bordered cards or sections. Desktop grids collapse to a single column on narrow screens. Primary action and cancel are explicit, and unsaved work is protected.

Document authoring should reuse this hierarchy. Required document data must be resolved or entered before issue; optional fields must not create noise. Long clinical/legal text requires comfortable multiline editing and a clear distinction between authored content and system-sourced identity data.

### Tables

Tables have muted headers, strong header separation, light row rules, hover states, and right/end-aligned tabular numbers. Dense tables are already used for print-facing reports. On narrow screens, tables scroll horizontally rather than crushing content.

Document tables need print-specific rules: fixed readable column hierarchy, repeatable headers, protected totals, and predictable continuation across pages. Do not rely on horizontal scrolling inside the paper canvas.

### Dialogs

Dialogs use a soft backdrop, 12 px radius, fine ring, compact header, close control, and muted footer band. On mobile, actions stack; on larger screens, they align to the end. Destructive actions use a dedicated confirmation pattern.

Use dialogs only for short confirmation or blocking decisions such as issue, void, replace, or manual invoice send. The main document preview should not be trapped inside a small generic dialog.

### Search and filters

Search uses labeled inputs or searchable comboboxes. Filters appear as compact outline chips; active filters gain a low-tint teal treatment, show the selected value, and provide clear/apply actions. Filter state commonly survives in the URL.

If a future document list uses search or filters, preserve this pattern. Do not introduce a separate filter language in the document module.

### Mobile behavior

- Navigation becomes an inline-start sheet.
- Page actions wrap or stack.
- Multi-column forms and dashboards collapse progressively.
- Dialog actions become full-width/stacked where needed.
- Tables retain structure through horizontal overflow.
- Touch targets and labels remain explicit.

For document preview, mobile is a review and action surface, not a miniature editable sheet. Keep the full paper ratio, allow controlled zoom/fit-width behavior, and place actions outside the canvas. Do not reflow the issued artifact into a different mobile document.

## 4. P7 document experience

### Shared lifecycle

Design the states as one coherent sequence:

1. **Preview:** authenticated, source-resolved, visibly marked `DRAFT`, no permanent number, not sendable.
2. **Issue:** explicit confirmation after authorization and validation; the issued artifact gains its permanent number and timestamp.
3. **Print / PDF / allowed delivery:** always use the same immutable issued snapshot.
4. **Replace:** a correction creates a new document and preserves the relationship to the original.
5. **Void:** the original remains visible and auditable with a clear void treatment, reason, actor, and time.

Consent forms are the exception: P7 renders a blank or prefilled **unsigned** form identified by form code and version. Do not portray it as issued consent, patient acceptance, or e-signature history.

### Preview

- Present a focused, centered paper canvas with page boundaries and realistic A4/A5 proportions.
- Keep document controls, validation, and metadata outside the paper canvas.
- Show the exact final hierarchy, line wrapping, page breaks, repeated headers, and optional-field behavior.
- Show a clear localized `DRAFT` marker that cannot be confused with an issued artifact.
- Missing required data produces an actionable summary and points to the exact field; issuance stays unavailable.
- Long-content and multi-page previews need visible page count and predictable navigation/zoom.
- The same paper canvas appears inside both light and dark application chrome.

### PDF and printing

- Preview, PDF, and print are three outputs of one design—not separate templates.
- For a given issued instance, content, pagination, serial, status, QR, and definition version must match exactly.
- Respect A4/A5 portrait size, safe printer margins, grayscale legibility, and font embedding.
- Repeat an approved compact identification header and page number on later pages.
- Never orphan a table header, totals block, signature block, or critical label from its content.
- Hide all application navigation and controls from print.

### QR verification

- The QR block is optional and appears only when a real rate-limited, audited verification service exists.
- Use a quiet, labeled verification block with enough print contrast and scan clearance.
- The QR contains only an opaque revocable HTTPS token—never patient, diagnosis, medication, national ID, or amount data.
- Design minimal verification-result states for **valid**, **void**, **replaced**, and **unavailable/invalid**, revealing only document type, issuer clinic, issue date, authenticity state, and a masked safe reference.
- Never imitate a Ministry, regulator, or government QR.
- When QR is unavailable, remove the whole block and reflow; do not show a placeholder frame.

For consent forms, any future QR may identify the approved blank form/version only. It must never imply that a patient signed or accepted it.

### Signatures and attestations

P7 supports a printed issuer identity, role, department/specialty where valid, professional licence where required, an attestation timestamp, and a wet-signature/stamp line.

P7 does not support cryptographic signatures, signature-pad capture, patient acceptance, countersignatures, or inferred signatures from uploaded images. Do not design those states or controls. If a signature image/QR is unavailable, render the approved typed/wet-sign alternative without an empty image box.

### Branding

Create one adaptive branding primitive shared by every document:

- required clinic name as selectable/searchable text;
- optional logo with clinic-name typographic fallback;
- optional address, primary/secondary phone, email, website, and social links;
- conditional tax/VAT registration and clinic licence identifiers;
- optional custom footer and approved metadata.

The block must work with a wide, square, tall, or absent logo; short and long bilingual clinic names; sparse or complete contact data; and one or multiple legal identifiers. An absent optional value removes its label, separator, and reserved space. The clinic brand should lead without overpowering patient identity or document purpose.

### Empty, loading, and error states

**Empty**

- Surrounding application states follow the existing small-icon, direct-copy, optional-action pattern.
- Optional document blocks collapse completely when empty.
- Core empty tables or missing required sections show a specific preview message and normally block issue.
- Never print generic UI placeholder copy unless the document specification explicitly defines a legitimate empty statement.

**Loading**

- Use skeletons that preserve the preview workspace, paper frame, metadata panel, and action-bar rhythm.
- Announce loading with an accessible status and keep decorative skeletons hidden from assistive technology.
- Avoid layout jumps and never flash data from a previously viewed patient/document.
- PDF generation and issue actions need clear progress, disabled duplicate actions, and a stable cancel/return path where cancellation is safe.

**Errors**

- Use plain, localized, field-specific language: what failed, what is affected, and what the user can do next.
- Preserve author input after recoverable validation or generation failures.
- Separate missing-data blockers, authorization denial, rendering/PDF failure, verification unavailability, and network failure; do not collapse them into “Something went wrong.”
- Keep sensitive document content out of URLs, filenames, logs, analytics, and generic error details.
- Destructive or immutable transitions—issue, void, and replace—require explicit confirmation and must describe the consequence.

## 5. Printable Experience Scope

Stitch must design every printable artifact in ClinicFlow, not only the eight committed P7 document families. Existing printable artifacts include, where applicable:

- All Reports;
- revenue reports;
- performance reports;
- operational reports;
- future reports;
- patient printable profile;
- patient printable file;
- follow-up print view;
- invoice;
- receipt;
- prescription;
- medical report;
- referral;
- sick leave;
- laboratory request;
- consent forms.

Any current or future screen that exposes a **Print** action must use the same shared design language.

### Missing printable workflows

Some workflows do not currently expose printing but are expected to support it in future releases. Stitch should design reusable patterns that can accommodate future Print actions, including:

- invoice printing;
- automatic invoice numbering;
- printable financial outputs;
- printable patient summaries;
- printable operational exports.

These are design-system expectations only. They do not define backend behavior or change the committed P7 requirements.

## 6. Unified Print Design Language

All printable artifacts across ClinicFlow must share one visual system covering:

- typography;
- header;
- footer;
- branding;
- QR;
- tables;
- totals;
- status labels;
- pagination;
- signature areas;
- watermarks;
- metadata blocks;
- page numbering;
- print margins.

Every printed page should feel immediately recognizable as ClinicFlow, regardless of document type.

## 7. Design constraints

Stitch must preserve:

- the existing ClinicFlow shell, navigation, page hierarchy, component language, teal identity, and role-aware workflow;
- the current patient, appointment, billing, and manual invoice-send entry points;
- the enterprise medical tone: calm, precise, credible, private, and fast to scan;
- Arabic/English parity, semantic RTL/LTR, bidi-safe identifiers, and accessible contrast/focus;
- one reusable primitive system for all documents, with additive extension for future definitions;
- exact print/PDF constraints, variable-length data, multi-page content, and deterministic optional-field degradation;
- clinic branding as dynamic data, never hardcoded artwork;
- white-paper output that is stable across application themes.

Do not:

- redesign the application, sidebar, header, navigation, forms, tables, dialogs, search, or filters;
- create free-form page art that cannot be reproduced with shared engine primitives;
- imitate government or regulator documents, seals, or QR codes;
- invent missing medical, legal, licence, tax, signature, or verification data;
- introduce e-signature, patient-consent capture, AI-authored content, or new messaging workflows;
- use decorative gradients, large color fields, excessive shadows, or rounded-card stacking as a substitute for document hierarchy;
- create a separate mobile, PDF, or print document layout.

The desired appearance is trustworthy, minimal, modern, and premium through precision.

## 8. Deliverables expected from Stitch

Provide:

1. **Shared Print Design System**
   - print color roles, type scale, spacing, page grid, margins, rules, status treatments, and A4/A5 behavior;
   - a PDF-safe Arabic/English typography recommendation with licensing assumptions clearly flagged.

2. **Shared Printable Components**
   - branding/header, document identity/status, patient and issuer details, section heading, key-value group, data table, totals, notes, alert/legal text, signature/attestation, QR verification, footer, pagination, and draft/void/replaced treatments;
   - defined behavior for missing optional data, long text, and page continuation.

3. **Templates for all current printable artifacts**
   - English/LTR and Arabic/RTL;
   - short, typical, long, sparse-branding, and multi-page representative fixtures;
   - all existing printable reports, patient outputs, follow-up views, and document families in the Printable Experience Scope;
   - consent shown as unsigned render-only output, not acceptance evidence;
   - no change to the committed P7 document-family requirements.

4. **Extensible patterns for future printable artifacts**
   - reusable patterns for future reports, financial outputs, patient summaries, operational exports, and Print actions;
   - additive growth without requiring a separate visual language.

5. **Responsive preview behavior**
   - desktop, tablet, and mobile framing;
   - light and dark application chrome around one theme-independent paper artifact;
   - action placement, zoom/fit behavior, loading, empty, blocking-error, and generation-progress states.

6. **Implementation-ready handoff**
   - measured dimensions, tokens, component variants, content order, mirroring rules, pagination rules, and annotations;
   - no ambiguous visual-only effects that depend on manual composition;
   - approval-ready files organized per document so designs can be approved one at a time after the shared primitive contract is fixed.

The final design should allow engineering to reproduce every approved printable layout faithfully from shared primitives without redesigning it during P7C–P7E or future printable-workflow releases.
