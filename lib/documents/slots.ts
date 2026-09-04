import {
  DOCUMENT_CATALOG,
  type DocumentFilterKey,
  type RegisteredDocumentTypeCode,
} from "@/lib/documents/catalog";
import { resolveDateRange, type DateRangePreset } from "@/lib/date-range";

/**
 * Phase 6 — the §10 slot-filling contract.
 *
 * A "slot" is one key of a document type's own params schema, projected next to
 * the catalog `filterSchema` key it corresponds to. This module is deliberately
 * pure and dependency-free: it decides *what to ask for*, never *what to
 * return*. Authorization stays with `assertDocumentTypeAccess`, and the values
 * themselves are still validated by the type's real zod schema in
 * `lib/documents/mutations.ts` — a slot list is a UX affordance, never a gate.
 *
 * The invariant Phase 6 must hold: the Assistant asks only for slots that are
 * (a) required, (b) still empty after auto-fill, and (c) not derivable from the
 * session or the conversation context.
 */

export type DocumentSlotKind =
  | "uuid"
  | "date"
  | "date_range"
  | "text"
  | "enum"
  | "rich_text";

/** What the server can fill without asking the user. */
export type DocumentSlotAutoFill = "session" | "date_range" | null;

/**
 * Which resolver turns a natural-language mention into the slot's id. The
 * assistant must run that resolver first (and clarify when ambiguous) rather
 * than guessing a UUID.
 */
export type DocumentSlotResolver =
  | "patient"
  | "staff"
  | "doctor"
  | "department"
  | "appointment"
  | "clinical_record";

export type DocumentSlot = {
  key: string;
  filterKey: DocumentFilterKey | null;
  required: boolean;
  kind: DocumentSlotKind;
  autoFill: DocumentSlotAutoFill;
  resolver?: DocumentSlotResolver;
  description: { en: string; ar: string };
};

function slot(
  key: string,
  filterKey: DocumentFilterKey | null,
  required: boolean,
  kind: DocumentSlotKind,
  description: { en: string; ar: string },
  extra: { autoFill?: DocumentSlotAutoFill; resolver?: DocumentSlotResolver } = {},
): DocumentSlot {
  return {
    key,
    filterKey,
    required,
    kind,
    autoFill: extra.autoFill ?? null,
    ...(extra.resolver ? { resolver: extra.resolver } : {}),
    description,
  };
}

const DATE_FROM = slot(
  "from",
  "dateRange",
  true,
  "date",
  {
    en: "Start of the reporting period (YYYY-MM-DD).",
    ar: "بداية فترة التقرير (YYYY-MM-DD).",
  },
  { autoFill: "date_range" },
);
const DATE_TO = slot(
  "to",
  "dateRange",
  true,
  "date",
  {
    en: "End of the reporting period (YYYY-MM-DD).",
    ar: "نهاية فترة التقرير (YYYY-MM-DD).",
  },
  { autoFill: "date_range" },
);
const DOCTOR = slot(
  "doctorId",
  "doctor",
  false,
  "uuid",
  { en: "Limit to one doctor.", ar: "التحديد لطبيب واحد." },
  { resolver: "doctor" },
);
const DEPARTMENT = slot(
  "departmentId",
  "department",
  false,
  "uuid",
  { en: "Limit to one department.", ar: "التحديد لقسم واحد." },
  { resolver: "department" },
);
const RECEPTIONIST = slot(
  "receptionistId",
  "employee",
  false,
  "uuid",
  { en: "Limit to one receptionist.", ar: "التحديد لموظف استقبال واحد." },
  { resolver: "staff" },
);

const REVENUE_SLOTS = [DATE_FROM, DATE_TO, DOCTOR, DEPARTMENT] as const;

const PATIENT_SLOT = slot(
  "patientId",
  "patient",
  true,
  "uuid",
  { en: "The patient this document is about.", ar: "المريض المعني بهذا المستند." },
  { resolver: "patient" },
);

const STAFF_SLOT = slot(
  "staffId",
  "employee",
  true,
  "uuid",
  { en: "The staff member this document is about.", ar: "الموظف المعني بهذا المستند." },
  { resolver: "staff" },
);

const ROSTER_ROLE_SLOT = slot("role", null, false, "enum", {
  en: "Limit the roster to one staff role.",
  ar: "قصر القائمة على دور وظيفي واحد.",
});
const ROSTER_SEARCH_SLOT = slot("search", "search", false, "text", {
  en: "Free-text roster search.",
  ar: "بحث نصي في القائمة.",
});

/**
 * Roster types share one params schema but different catalog filter sets, so
 * the subject narrowing differs: a patient roster may be narrowed to a patient,
 * a staff roster to an employee. Both narrowings are optional — a roster with no
 * subject filter is the normal case.
 */
const PATIENT_ROSTER_SLOTS = [
  { ...PATIENT_SLOT, required: false },
  DEPARTMENT,
  DOCTOR,
  ROSTER_ROLE_SLOT,
  ROSTER_SEARCH_SLOT,
] as const;

// No doctor filter: the staff roster's catalog `filterSchema` does not declare
// one, and a slot must never claim a filter the document platform lacks.
const STAFF_ROSTER_SLOTS = [
  { ...STAFF_SLOT, required: false },
  DEPARTMENT,
  ROSTER_ROLE_SLOT,
  ROSTER_SEARCH_SLOT,
] as const;

const PATIENT_HISTORY_SLOTS = [
  PATIENT_SLOT,
  slot(
    "preset",
    "dateRange",
    false,
    "enum",
    {
      en: "Named period: all, last_week, last_month, last_year, or custom.",
      ar: "الفترة: الكل أو الأسبوع الماضي أو الشهر الماضي أو السنة الماضية أو مخصص.",
    },
    { autoFill: "date_range" },
  ),
  slot(
    "from",
    "dateRange",
    false,
    "date",
    { en: "Custom period start (YYYY-MM-DD).", ar: "بداية الفترة المخصصة." },
    { autoFill: "date_range" },
  ),
  slot(
    "to",
    "dateRange",
    false,
    "date",
    { en: "Custom period end (YYYY-MM-DD).", ar: "نهاية الفترة المخصصة." },
    { autoFill: "date_range" },
  ),
] as const;

const CLINICAL_SLOTS = [
  slot(
    "recordId",
    null,
    true,
    "uuid",
    {
      en: "The existing clinical record (prescription, lab request, or sick leave) to issue.",
      ar: "السجل السريري الموجود (وصفة أو طلب تحاليل أو إجازة مرضية) المطلوب إصداره.",
    },
    { resolver: "clinical_record" },
  ),
] as const;

const INVOICE_SLOTS = [
  slot(
    "appointmentId",
    null,
    true,
    "uuid",
    {
      en: "The completed appointment the invoice belongs to.",
      ar: "الموعد المكتمل الذي تخص الفاتورة.",
    },
    { resolver: "appointment" },
  ),
] as const;

const GENERIC_SLOTS = [
  slot("title", null, true, "text", {
    en: "Document title.",
    ar: "عنوان المستند.",
  }),
  slot("blocks", null, true, "rich_text", {
    en: "Authored body blocks.",
    ar: "فقرات نص المستند.",
  }),
] as const;

const SLOTS_BY_CODE: Record<RegisteredDocumentTypeCode, readonly DocumentSlot[]> = {
  REVENUE_REPORT: REVENUE_SLOTS,
  FOLLOW_UP_PAGE_REPORT: [DATE_FROM, DATE_TO, DOCTOR],
  CANCELLATION_REPORT: [DATE_FROM, DATE_TO, DOCTOR],
  NO_SHOW_REPORT: [DATE_FROM, DATE_TO, DOCTOR],
  SALES_REPORT: [DATE_FROM, DATE_TO],
  FOLLOW_UP_ANALYTICS_REPORT: [DATE_FROM, DATE_TO, DOCTOR],
  DOCTOR_PERFORMANCE_REPORT: [DATE_FROM, DATE_TO, DOCTOR, DEPARTMENT],
  RECEPTIONIST_PERFORMANCE_REPORT: [DATE_FROM, DATE_TO, RECEPTIONIST],
  PATIENT_LIST_REPORT: PATIENT_ROSTER_SLOTS,
  PATIENT_FILE: [PATIENT_SLOT],
  SYSTEM_MEMBERS_REPORT: STAFF_ROSTER_SLOTS,
  STAFF_FILE: [STAFF_SLOT],
  PRESCRIPTION: CLINICAL_SLOTS,
  SICK_LEAVE_CERTIFICATE: CLINICAL_SLOTS,
  LAB_REQUEST: CLINICAL_SLOTS,
  INVOICE: INVOICE_SLOTS,
  APPOINTMENT_HISTORY_REPORT: PATIENT_HISTORY_SLOTS,
  PACKAGE_HISTORY_REPORT: PATIENT_HISTORY_SLOTS,
  DEPOSIT_STATEMENT: PATIENT_HISTORY_SLOTS,
  PATIENT_FINANCIAL_SUMMARY: PATIENT_HISTORY_SLOTS,
  GENERIC_DOCUMENT: GENERIC_SLOTS,
};

/** Every input slot a type accepts, required ones first. */
export function documentIssueSlots(
  code: RegisteredDocumentTypeCode,
): readonly DocumentSlot[] {
  return [...SLOTS_BY_CODE[code]].sort(
    (a, b) => Number(b.required) - Number(a.required),
  );
}

/** Analytical/revenue types name themselves through `documentType`. */
export function documentTypeIsSelfDescribing(
  code: RegisteredDocumentTypeCode,
): boolean {
  return code !== "REVENUE_REPORT" && code !== "INVOICE";
}

export type DocumentSlotEvaluation = {
  documentType: RegisteredDocumentTypeCode;
  filled: { key: string; value: string }[];
  /** The only thing the assistant is allowed to ask the user for. */
  missingRequired: DocumentSlot[];
  optional: DocumentSlot[];
  unknownKeys: string[];
  ready: boolean;
};

function presentValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.trim() === "" ? null : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.length === 0 ? null : `${value.length} item(s)`;
  return "set";
}

export function evaluateDocumentSlots(
  code: RegisteredDocumentTypeCode,
  params: Record<string, unknown> = {},
): DocumentSlotEvaluation {
  const slots = documentIssueSlots(code);
  const known = new Set(slots.map((entry) => entry.key));
  const filled: { key: string; value: string }[] = [];
  const missingRequired: DocumentSlot[] = [];
  const optional: DocumentSlot[] = [];

  for (const entry of slots) {
    const value = presentValue(params[entry.key]);
    if (value !== null) {
      filled.push({ key: entry.key, value });
      continue;
    }
    if (entry.required) missingRequired.push(entry);
    else optional.push(entry);
  }

  return {
    documentType: code,
    filled,
    missingRequired,
    optional,
    // `documentType` is server-supplied, never a user-answerable slot.
    unknownKeys: Object.keys(params).filter(
      (key) => !known.has(key) && key !== "documentType",
    ),
    ready: missingRequired.length === 0,
  };
}

export type DocumentAutoFillHint = {
  preset?: DateRangePreset;
  from?: string;
  to?: string;
  now?: Date;
  /** Conversation-scoped entity defaults already resolved server-side. */
  patientId?: string | null;
  appointmentId?: string | null;
};

export type DocumentAutoFillResult = {
  params: Record<string, unknown>;
  /** Which slots the server filled, so the assistant can state it honestly. */
  autoFilled: { key: string; source: "session" | "date_range" | "context" }[];
};

/**
 * §10 step 3 — fill everything obtainable without asking. Date ranges resolve
 * through the same `resolveDateRange` core the reports pages use, so a document
 * the Assistant issues covers byte-identical bounds to the report the user can
 * open. Entity defaults come from the server-derived conversation context, never
 * from model-supplied ids.
 *
 * An explicitly supplied value is never overwritten.
 */
export function autoFillDocumentSlots(
  code: RegisteredDocumentTypeCode,
  params: Record<string, unknown> = {},
  hint: DocumentAutoFillHint = {},
): DocumentAutoFillResult {
  const next: Record<string, unknown> = { ...params };
  const autoFilled: DocumentAutoFillResult["autoFilled"] = [];
  const slots = documentIssueSlots(code);
  const has = (key: string) => presentValue(next[key]) !== null;
  const slotFor = (key: string) => slots.find((entry) => entry.key === key);

  const needsRange = Boolean(slotFor("from") && slotFor("to"));
  const rangeIsRequired = slotFor("from")?.required === true;
  if (needsRange && (rangeIsRequired || hint.preset || (hint.from && hint.to))) {
    if (!has("from") || !has("to")) {
      const resolved = resolveDateRange({
        preset: hint.preset,
        from: hint.from,
        to: hint.to,
        now: hint.now,
      });
      if (!has("from")) {
        next.from = resolved.from;
        autoFilled.push({ key: "from", source: "date_range" });
      }
      if (!has("to")) {
        next.to = resolved.to;
        autoFilled.push({ key: "to", source: "date_range" });
      }
      if (slotFor("preset") && !has("preset")) {
        next.preset = "custom";
        autoFilled.push({ key: "preset", source: "date_range" });
      }
    }
  }

  if (slotFor("patientId") && !has("patientId") && hint.patientId) {
    next.patientId = hint.patientId;
    autoFilled.push({ key: "patientId", source: "context" });
  }
  if (slotFor("appointmentId") && !has("appointmentId") && hint.appointmentId) {
    next.appointmentId = hint.appointmentId;
    autoFilled.push({ key: "appointmentId", source: "context" });
  }

  if (documentTypeIsSelfDescribing(code)) next.documentType = code;

  return { params: next, autoFilled };
}

/**
 * Turn a zod validation failure into a per-slot question (§10 step 5). Issues
 * whose path names a declared slot become that slot's question; anything else
 * is reported under its raw path so nothing is silently swallowed.
 */
export function documentValidationQuestions(
  code: RegisteredDocumentTypeCode,
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): { key: string; question: string }[] {
  const slots = documentIssueSlots(code);
  const seen = new Set<string>();
  const questions: { key: string; question: string }[] = [];
  for (const issue of issues) {
    const key = issue.path.length > 0 ? String(issue.path[0]) : "documentType";
    if (seen.has(key)) continue;
    seen.add(key);
    const declared = slots.find((entry) => entry.key === key);
    questions.push({
      key,
      question: declared
        ? `${declared.description.en} (${issue.message})`
        : issue.message,
    });
  }
  return questions;
}

/**
 * Slot filter keys this module claims that the catalog does not actually
 * declare. Exported so a registry test can assert the projection never invents
 * a filter the document platform does not have.
 *
 * The reverse direction is deliberately *not* an invariant: `filterSchema` is
 * the documents module's listing/filter vocabulary, and several of its keys
 * (`status`, `documentNumber`, `creator`, `date`, and an invoice's `patient` /
 * `dateRange`) describe how issued documents are *found*, never how one is
 * *issued*. An invoice is issued from an appointment, not from a date range.
 */
export function undeclaredSlotFilterKeys(
  code: RegisteredDocumentTypeCode,
): DocumentFilterKey[] {
  const declared = new Set<DocumentFilterKey>(DOCUMENT_CATALOG[code].filterSchema);
  return documentIssueSlots(code).flatMap((entry) =>
    entry.filterKey && !declared.has(entry.filterKey) ? [entry.filterKey] : [],
  );
}
