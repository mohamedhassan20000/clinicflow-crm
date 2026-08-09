import type { Locale } from "@/lib/i18n/config";
import type { P712PatientHistoryDocumentCode } from "@/lib/documents/resolvers/patient-history";
import { getSharedDocumentSectionCopy } from "@/lib/documents/shared-section-copy";

/**
 * P7-12 — self-contained bilingual copy for the patient history/financial
 * documents (mirrors the roster/profile copy module: AR + EN inline, no runtime
 * i18n dependency in the render path so the canonical PDF is deterministic).
 */

type WidenStrings<T> = {
  [K in keyof T]: T[K] extends string
    ? string
    : T[K] extends (...args: infer A) => infer R
      ? (...args: A) => R extends string ? string : R
      : T[K] extends object
        ? WidenStrings<T[K]>
        : T[K];
};
export type PatientHistoryCopy = WidenStrings<ReturnType<typeof englishCopy>>;

function englishCopy(documentType: P712PatientHistoryDocumentCode) {
  const shared = getSharedDocumentSectionCopy("en");
  const titles = {
    APPOINTMENT_HISTORY_REPORT: "Appointment History Report",
    PACKAGE_HISTORY_REPORT: "Package History Report",
    DEPOSIT_STATEMENT: "Deposit Statement",
    PATIENT_FINANCIAL_SUMMARY: "Patient Financial Summary",
  } as const;
  const presets = {
    all: "All time",
    last_week: "Last week",
    last_month: "Last month",
    last_year: "Last year",
    custom: "Custom range",
  } as const;
  return {
    title: titles[documentType],
    labels: {
      documentNumber: "Document no.",
      issueDate: "Issued",
      issueTime: "Time",
      period: "Period",
    },
    patient: "Patient",
    fileNumber: "File no.",
    phone: "Phone",
    period: "Period",
    // appointment history
    appointmentHistory: "Appointment history",
    date: "Date",
    doctor: "Doctor",
    department: "Department",
    status: "Status",
    followUp: "Follow-up",
    medicalNote: "Medical note",
    relatedDocuments: "Related documents",
    billing: "Billing",
    billed: "Billed",
    collected: "Collected",
    outstanding: "Outstanding",
    accountTotals: "Account totals (all appointments)",
    appointmentsCount: (count: number) => `${count} appointments`,
    appointmentStatus: (status: string) => ({
      pending: "Pending",
      confirmed: "Confirmed",
      arrived: "Arrived",
      in_session: "In session",
      completed: "Completed",
      cancelled: "Cancelled",
      no_show: "No-show",
      replaced: "Replaced",
    })[status] ?? "Unknown",
    followUpOutcome: (outcome: string) => ({
      all_fine: "All fine",
      has_problem: "Has a problem",
      no_response: "No response",
    })[outcome] ?? "Not specified",
    listSeparator: ", ",
    // package history
    packages: "Packages",
    packageName: "Package",
    purchased: "Purchased",
    used: "Used",
    remaining: "Remaining",
    pricePerSession: "Price / session",
    sessions: "sessions",
    active: "Active",
    inactive: "Inactive",
    packageTotals: "Package totals",
    // deposit statement
    depositStatement: "Deposit statement",
    openingBalance: "Opening balance",
    currentBalance: "Current balance",
    totalDeposited: "Total deposited",
    totalUsed: "Total used",
    amount: "Amount",
    runningBalance: "Balance",
    recordedBy: "Recorded by",
    transaction: "Transaction",
    // financial summary
    financialSummary: "Financial summary",
    appointmentCharges: "Appointment charges",
    payments: "Payments",
    depositBalance: "Deposit balance",
    packageBalance: "Package balance",
    activePackages: "Active packages",
    // shared chrome
    noRows: "No records for this period",
    scopeNote:
      "This document reflects the patient records stored in ClinicFlow at issue time.",
    verificationTitle: shared.verification.genericTitle,
    verificationCaption: shared.verification.genericCaption,
    authorizedSignature: shared.signatures.authorized,
    accountsSignature: shared.signatures.accountsAuthorized,
    stamp: shared.stamps.clinic,
    footerAttribution: shared.footer.medicalRecordsSystem,
    copyright: shared.footer.allRights,
    page: "Page",
    of: "of",
    presetLabel: (preset: string) =>
      presets[preset as keyof typeof presets] ?? presets.all,
    rangeLabel: (from: string | null, to: string | null) =>
      from && to ? `${from} → ${to}` : from ? `From ${from}` : to ? `Until ${to}` : "All time",
  };
}

function arabicCopy(
  documentType: P712PatientHistoryDocumentCode,
): PatientHistoryCopy {
  const shared = getSharedDocumentSectionCopy("ar");
  const titles = {
    APPOINTMENT_HISTORY_REPORT: "تقرير سجل المواعيد",
    PACKAGE_HISTORY_REPORT: "تقرير سجل الباقات",
    DEPOSIT_STATEMENT: "كشف حساب الوديعة",
    PATIENT_FINANCIAL_SUMMARY: "الملخص المالي للمريض",
  } as const;
  const presets = {
    all: "كل الفترات",
    last_week: "الأسبوع الماضي",
    last_month: "الشهر الماضي",
    last_year: "السنة الماضية",
    custom: "نطاق مخصص",
  } as const;
  return {
    ...englishCopy(documentType),
    title: titles[documentType],
    labels: {
      documentNumber: "رقم المستند",
      issueDate: "تاريخ الإصدار",
      issueTime: "الوقت",
      period: "الفترة",
    },
    patient: "المريض",
    fileNumber: "رقم الملف",
    phone: "الهاتف",
    period: "الفترة",
    appointmentHistory: "سجل المواعيد",
    date: "التاريخ",
    doctor: "الطبيب",
    department: "القسم",
    status: "الحالة",
    followUp: "المتابعة",
    medicalNote: "الملاحظة الطبية",
    relatedDocuments: "المستندات المرتبطة",
    billing: "الفوترة",
    billed: "المستحق",
    collected: "المحصّل",
    outstanding: "المتبقي",
    accountTotals: "إجماليات الحساب (كل المواعيد)",
    appointmentsCount: (count: number) => `${count} موعد`,
    appointmentStatus: (status: string) => ({
      pending: "قيد الانتظار",
      confirmed: "مؤكد",
      arrived: "وصل",
      in_session: "في الجلسة",
      completed: "مكتمل",
      cancelled: "ملغى",
      no_show: "عدم حضور",
      replaced: "مُستبدَل",
    })[status] ?? "غير معروف",
    followUpOutcome: (outcome: string) => ({
      all_fine: "كل شيء بخير",
      has_problem: "توجد مشكلة",
      no_response: "لا توجد استجابة",
    })[outcome] ?? "غير محدد",
    listSeparator: "، ",
    packages: "الباقات",
    packageName: "الباقة",
    purchased: "المشتراة",
    used: "المستخدمة",
    remaining: "المتبقية",
    pricePerSession: "سعر الجلسة",
    sessions: "جلسات",
    active: "نشطة",
    inactive: "غير نشطة",
    packageTotals: "إجماليات الباقات",
    depositStatement: "كشف حساب الوديعة",
    openingBalance: "الرصيد الافتتاحي",
    currentBalance: "الرصيد الحالي",
    totalDeposited: "إجمالي الإيداع",
    totalUsed: "إجمالي المستخدم",
    amount: "المبلغ",
    runningBalance: "الرصيد",
    recordedBy: "سجّله",
    transaction: "الحركة",
    financialSummary: "الملخص المالي",
    appointmentCharges: "رسوم المواعيد",
    payments: "المدفوعات",
    depositBalance: "رصيد الوديعة",
    packageBalance: "رصيد الباقات",
    activePackages: "الباقات النشطة",
    noRows: "لا توجد سجلات لهذه الفترة",
    scopeNote: "يعكس هذا المستند سجلات المريض المحفوظة في كلينيك فلو وقت الإصدار.",
    verificationTitle: shared.verification.genericTitle,
    verificationCaption: shared.verification.genericCaption,
    authorizedSignature: shared.signatures.authorized,
    accountsSignature: shared.signatures.accountsAuthorized,
    stamp: shared.stamps.clinic,
    footerAttribution: shared.footer.medicalRecordsSystem,
    copyright: shared.footer.allRights,
    page: "صفحة",
    of: "من",
    presetLabel: (preset: string) =>
      presets[preset as keyof typeof presets] ?? presets.all,
    rangeLabel: (from: string | null, to: string | null) =>
      from && to ? `${from} ← ${to}` : from ? `من ${from}` : to ? `حتى ${to}` : "كل الفترات",
  };
}

export function getPatientHistoryCopy(
  locale: Locale,
  documentType: P712PatientHistoryDocumentCode,
): PatientHistoryCopy {
  return locale === "ar"
    ? arabicCopy(documentType)
    : englishCopy(documentType);
}
