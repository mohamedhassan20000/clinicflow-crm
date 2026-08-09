# ClinicFlow Document Platform — Design Intake

**Status:** Design-intake structure only. No production functionality, migrations,
templates, numbering, barcodes, QR, verification, or settings are implemented here.
**Roadmap:** [`docs/AI_AGENT_PLAN.md`](../../AI_AGENT_PLAN.md) §8 (P7 — Premium Document System, design-first)
**Related requirements:** [`docs/documents/`](../../documents/) (P7A written catalog),
[`docs/design/STITCH_CONTEXT.md`](../../design/STITCH_CONTEXT.md) (Stitch handoff context)

## Purpose

This directory is the **manual design-intake staging area** for the future
ClinicFlow Document Platform. It exists so the founder can drop in the Arabic and
English full-page screenshots and the Stitch exports for each built-in document,
in one predictable place, before any design system or engine work begins.

It is documentation and empty intake folders only. It does **not** implement,
authorize, or design anything. Every folder is a labelled inbox waiting for a
manual import.

## How to use this directory

1. Read [`DESIGN_IMPORT_GUIDE.md`](DESIGN_IMPORT_GUIDE.md) — where exactly to place
   each file.
2. Read [`shared/SHARED_REQUIREMENTS.md`](shared/SHARED_REQUIREMENTS.md) — the
   approved cross-document requirements every design must eventually satisfy.
3. Open the numbered folder for the document you are importing and follow its
   `NOTES.md`.

Every document folder has the identical intake structure:

```
<document-folder>/
├── ar/
│   ├── screenshot/       # Arabic full-page screenshot → reference.png
│   └── stitch-export/    # Arabic Stitch export (keep internal structure)
├── en/
│   ├── screenshot/       # English full-page screenshot → reference.png
│   └── stitch-export/    # English Stitch export (keep internal structure)
├── assets/               # document-specific shared assets
└── NOTES.md              # per-document capture sheet
```

Shared assets used by more than one document live in [`shared/assets/`](shared/assets/).

## Document catalog — 16 built-in document types

| # | Stable code | English name | Arabic name | Folder | Current intended product surface | Arabic design | English design | Stitch export | Implementation |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `REVENUE_REPORT` | Revenue Report | تقرير الإيرادات | [`01-revenue-report/`](01-revenue-report/) | Revenue page | Awaiting manual import | Awaiting manual import | Awaiting manual import | Not started |
| 2 | `FOLLOW_UP_PAGE_REPORT` | Follow-up Page Report | تقرير المتابعة | [`02-follow-up-page-report/`](02-follow-up-page-report/) | Follow-ups page | Awaiting manual import | Awaiting manual import | Awaiting manual import | Not started |
| 3 | `PATIENT_LIST_REPORT` | Patient List Report | تقرير قائمة المرضى | [`03-patient-list-report/`](03-patient-list-report/) | Patients page | Awaiting manual import | Awaiting manual import | Awaiting manual import | Not started |
| 4 | `PATIENT_FILE` | Patient File | ملف المريض | [`04-patient-file/`](04-patient-file/) | Individual patient profile | Awaiting manual import | Awaiting manual import | Awaiting manual import | Not started |
| 5 | `PRESCRIPTION` | Prescription | الوصفة الطبية | [`05-prescription/`](05-prescription/) | Patient visit workspace | Awaiting manual import | Awaiting manual import | Awaiting manual import | Not started |
| 6 | `SICK_LEAVE_CERTIFICATE` | Sick Leave Certificate | شهادة الإجازة المرضية | [`06-sick-leave-certificate/`](06-sick-leave-certificate/) | Patient visit workspace | Awaiting manual import | Awaiting manual import | Awaiting manual import | Not started |
| 7 | `LAB_REQUEST` | Lab Request | طلب مختبر | [`07-lab-request/`](07-lab-request/) | Patient visit workspace | Awaiting manual import | Awaiting manual import | Awaiting manual import | Not started |
| 8 | `CANCELLATION_REPORT` | Cancellation Report | تقرير الإلغاء | [`08-cancellation-report/`](08-cancellation-report/) | Reports page | Awaiting manual import | Awaiting manual import | Awaiting manual import | Not started |
| 9 | `NO_SHOW_REPORT` | No-show Report | تقرير عدم الحضور | [`09-no-show-report/`](09-no-show-report/) | Reports page | Awaiting manual import | Awaiting manual import | Awaiting manual import | Not started |
| 10 | `SALES_REPORT` | Sales Report | تقرير المبيعات | [`10-sales-report/`](10-sales-report/) | Reports page | Awaiting manual import | Awaiting manual import | Awaiting manual import | Not started |
| 11 | `FOLLOW_UP_ANALYTICS_REPORT` | Follow-up Analytics Report | تقرير الفولو أب | [`11-follow-up-analytics-report/`](11-follow-up-analytics-report/) | Reports page | Awaiting manual import | Awaiting manual import | Awaiting manual import | Not started |
| 12 | `DOCTOR_PERFORMANCE_REPORT` | Doctor Performance Report | تقرير أداء الطبيب | [`12-doctor-performance-report/`](12-doctor-performance-report/) | Reports page | Awaiting manual import | Awaiting manual import | Awaiting manual import | Not started |
| 13 | `RECEPTIONIST_PERFORMANCE_REPORT` | Receptionist Performance Report | تقرير أداء موظف الاستقبال | [`13-receptionist-performance-report/`](13-receptionist-performance-report/) | Reports page | Awaiting manual import | Awaiting manual import | Awaiting manual import | Not started |
| 14 | `SYSTEM_MEMBERS_REPORT` | System Members Report | أعضاء النظام | [`14-system-members-report/`](14-system-members-report/) | Settings / Staff list | Awaiting manual import | Awaiting manual import | Awaiting manual import | Not started |
| 15 | `STAFF_FILE` | Staff File | ملف الموظف | [`15-staff-file/`](15-staff-file/) | Individual staff profile | Awaiting manual import | Awaiting manual import | Awaiting manual import | Not started |
| 16 | `INVOICE` | Invoice | الفاتورة | [`16-invoice/`](16-invoice/) | Patient profile, appointment billing, invoice history, WhatsApp delivery, and email delivery | Awaiting manual import | Awaiting manual import | Awaiting manual import | Not started |

### Catalog notes

- **10 · Sales Report** is a **separate** document from the **1 · Revenue Report**
  (Revenue page report). The two are not the same printout.
- **11 · Follow-up Analytics Report** is a **separate** document from the
  **2 · Follow-up Page Report** (the direct Follow-ups page printout).

### Status legend

- **Awaiting manual import** — the founder has not yet placed this reference.
- **Not started** — no implementation exists; this is intake staging only.
