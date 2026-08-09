import type { Locale } from "@/lib/i18n/config";
import type { P75RosterProfileDocumentCode } from "@/lib/documents/resolvers/roster-profile";
import { getSharedDocumentSectionCopy } from "@/lib/documents/shared-section-copy";

type WidenStrings<T> = {
  [K in keyof T]: T[K] extends string
    ? string
    : T[K] extends (...args: infer A) => infer R
      ? (...args: A) => R extends string ? string : R
      : T[K] extends object
        ? WidenStrings<T[K]>
        : T[K];
};
export type RosterProfileCopy = WidenStrings<ReturnType<typeof englishCopy>>;

function englishCopy(documentType: P75RosterProfileDocumentCode) {
  const shared = getSharedDocumentSectionCopy("en");
  const titles = {
    PATIENT_LIST_REPORT: "Patient List",
    PATIENT_FILE: "Patient File",
    SYSTEM_MEMBERS_REPORT: "System Members",
    STAFF_FILE: "Staff File",
  } as const;
  return {
    title: titles[documentType],
    labels: {
      documentNumber: "Document no.", issueDate: "Issued", issueTime: "Time", period: "Scope",
    },
    patientList: "Patient roster",
    systemMembers: "Members by department",
    personalDetails: "Personal details",
    employmentDetails: "Employment details",
    weeklySchedule: "Weekly schedule",
    fileNumber: "File no.", patient: "Patient", nationalId: "National ID",
    doctor: "Doctor", phone: "Phone", bloodType: "Blood type", email: "Email",
    dateOfBirth: "Date of birth", age: "Age", department: "Department",
    insurance: "Insurance", registeredSince: "Registered since", status: "Status",
    member: "Member", role: "Role", joined: "Joined", verificationCode: "Verification code",
    day: "Day", start: "Start", end: "End", duration: "Duration",
    totalWeeklyHours: "Total weekly hours", active: "Active", inactive: "Inactive",
    allDepartments: "All departments",
    scheduled: "Scheduled", unavailable: "Unavailable", noRows: "No matching records",
    administrativeNotes: "Administrative notes",
    staffNote: "This profile reflects the staff record and weekly schedule stored in ClinicFlow at issue time.",
    verificationTitle: shared.verification.genericTitle,
    verificationCaption: shared.verification.genericCaption,
    authorizedSignature: shared.signatures.authorized,
    medicalDirector: shared.signatures.medicalDirector,
    employeeSignature: shared.signatures.employee, stamp: shared.stamps.clinic,
    footerAttribution: shared.footer.medicalRecordsSystem,
    copyright: shared.footer.allRights, page: "Page", of: "of",
    membersCount: (count: number) => `${count} members`,
    patientsCount: (count: number) => `${count} patients`,
    dayName: (day: number) => ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][day] ?? "—",
    hours: (value: string) => `${value} h`,
    roleLabel: (role: string) => ({ admin: "Administrator", manager: "Manager", doctor: "Doctor",
      receptionist: "Receptionist", assistant: "Assistant" })[role] ?? role,
  };
}

function arabicCopy(documentType: P75RosterProfileDocumentCode): RosterProfileCopy {
  const shared = getSharedDocumentSectionCopy("ar");
  const titles = {
    PATIENT_LIST_REPORT: "قائمة المرضى",
    PATIENT_FILE: "ملف المريض",
    SYSTEM_MEMBERS_REPORT: "أعضاء النظام",
    STAFF_FILE: "ملف الموظف",
  } as const;
  return {
    ...englishCopy(documentType),
    title: titles[documentType],
    labels: {
      documentNumber: "رقم المستند", issueDate: "تاريخ الإصدار", issueTime: "الوقت", period: "النطاق",
    },
    patientList: "سجل المرضى", systemMembers: "الأعضاء حسب القسم",
    personalDetails: "البيانات الشخصية", employmentDetails: "بيانات العمل",
    weeklySchedule: "الجدول الأسبوعي", fileNumber: "رقم الملف", patient: "المريض",
    nationalId: "الرقم الوطني", doctor: "الطبيب", phone: "الهاتف",
    bloodType: "فصيلة الدم", email: "البريد الإلكتروني", dateOfBirth: "تاريخ الميلاد",
    age: "العمر", department: "القسم", insurance: "التأمين",
    registeredSince: "مسجل منذ", status: "الحالة", member: "العضو", role: "الدور",
    joined: "تاريخ الانضمام", verificationCode: "رمز التحقق", day: "اليوم",
    start: "البداية", end: "النهاية", duration: "المدة",
    totalWeeklyHours: "إجمالي الساعات الأسبوعية", active: "نشط", inactive: "غير نشط",
    allDepartments: "جميع الأقسام",
    scheduled: "مجدول", unavailable: "غير متاح", noRows: "لا توجد سجلات مطابقة",
    administrativeNotes: "ملاحظات إدارية",
    staffNote: "يعكس هذا الملف سجل الموظف وجدوله الأسبوعي المحفوظين في كلينيك فلو وقت الإصدار.",
    verificationTitle: shared.verification.genericTitle,
    verificationCaption: shared.verification.genericCaption,
    authorizedSignature: shared.signatures.authorized,
    medicalDirector: shared.signatures.medicalDirector,
    employeeSignature: shared.signatures.employee, stamp: shared.stamps.clinic,
    footerAttribution: shared.footer.medicalRecordsSystem,
    copyright: shared.footer.allRights, page: "صفحة", of: "من",
    membersCount: (count: number) => `${count} أعضاء`,
    patientsCount: (count: number) => `${count} مرضى`,
    dayName: (day: number) => ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"][day] ?? "—",
    hours: (value: string) => `${value} س`,
    roleLabel: (role: string) => ({ admin: "مسؤول", manager: "مدير", doctor: "طبيب",
      receptionist: "موظف استقبال", assistant: "مساعد" })[role] ?? role,
  };
}

export function getRosterProfileCopy(
  locale: Locale,
  documentType: P75RosterProfileDocumentCode,
): RosterProfileCopy {
  return locale === "ar" ? arabicCopy(documentType) : englishCopy(documentType);
}
