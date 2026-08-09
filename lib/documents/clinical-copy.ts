import type { Locale } from "@/lib/i18n/config";
import type { P76ClinicalDocumentCode } from "@/lib/documents/resolvers/clinical-document";
import { getSharedDocumentSectionCopy } from "@/lib/documents/shared-section-copy";

type WidenStrings<T> = { [K in keyof T]: T[K] extends string ? string
  : T[K] extends (...args: infer A) => infer R ? (...args: A) => R extends string ? string : R
    : T[K] extends object ? WidenStrings<T[K]> : T[K] };
export type ClinicalDocumentCopy = WidenStrings<ReturnType<typeof englishCopy>>;

function englishCopy(documentType: P76ClinicalDocumentCode) {
  const shared = getSharedDocumentSectionCopy("en");
  const titles = { PRESCRIPTION: "Prescription", LAB_REQUEST: "Laboratory Request",
    SICK_LEAVE_CERTIFICATE: "Sick Leave Certificate" } as const;
  return {
    title: titles[documentType], labels: { documentNumber: "Document ID", issueDate: "Issue date",
      issueTime: "Time", period: "Valid until" },
    patientInformation: "Patient information", physician: "Responsible physician",
    patientName: "Full name", fileNumber: "Patient ID", dateOfBirth: "Date of birth",
    nationalId: "National ID", phone: "Phone", bloodType: "Blood type",
    physicianName: "Physician name", professionalTitle: "Professional title",
    specialty: "Specialty", department: "Department", licenseNumber: "Professional license",
    preparedBy: "Prepared by", finalizedAt: "Finalized",
    medications: "Prescribed medications", medication: "Medication & strength", dose: "Dose",
    frequency: "Frequency", duration: "Duration", route: "Route", quantity: "Quantity",
    instructions: "Instructions", noMedications: "No medications recorded",
    prescriptionNotes: "Additional instructions and validity",
    prescriptionValidity: shared.notices.prescriptionValidity,
    controlledDisclaimer: shared.notices.controlledPrescription,
    requestedTests: "Requested examinations", testGroup: "Ordered tests", noTests: "No tests recorded",
    clinicalContext: "Clinical indications / notes", requestInstructions: "Other requests / specific instructions",
    priority: "Priority", laboratory: "Laboratory", routine: "Routine", urgent: "Urgent", stat: "STAT",
    certificateDetails: "Certificate details", leaveStart: "Leave start", leaveEnd: "Leave end",
    returnDate: "Return date", recipient: "Recipient organization", recipientReference: "Recipient reference",
    certification: (name: string, start: string, end: string, days: string) =>
      `This is to certify that ${name} was under professional medical care. Based on clinical evaluation, complete medical rest is advised from ${start} through ${end}, for ${days} consecutive day(s).`,
    restrictions: "Clinical remarks / restrictions",
    verificationTitle: shared.verification.clinicalTitle,
    verificationCaption: shared.verification.clinicalCaption,
    physicianSignature: shared.signatures.physician, manualSignature: shared.signatures.manual,
    stamp: shared.stamps.physician, clinicApprovalStamp: shared.stamps.clinicApproval,
    footerAttribution: shared.footer.medicalRecordsSystem,
    copyright: shared.footer.authenticity, page: "Page", of: "of",
  };
}

function arabicCopy(documentType: P76ClinicalDocumentCode): ClinicalDocumentCopy {
  const en = englishCopy(documentType);
  const shared = getSharedDocumentSectionCopy("ar");
  const titles = { PRESCRIPTION: "وصفة طبية", LAB_REQUEST: "طلب فحص مخبري",
    SICK_LEAVE_CERTIFICATE: "شهادة إجازة مرضية" } as const;
  return { ...en, title: titles[documentType],
    labels: { documentNumber: "رقم المستند", issueDate: "تاريخ الإصدار", issueTime: "الوقت", period: "صالح حتى" },
    patientInformation: "بيانات المريض", physician: "الطبيب المسؤول", patientName: "الاسم الكامل",
    fileNumber: "رقم الملف", dateOfBirth: "تاريخ الميلاد", nationalId: "الرقم الوطني",
    phone: "الهاتف", bloodType: "فصيلة الدم", physicianName: "اسم الطبيب",
    professionalTitle: "المسمى المهني", specialty: "التخصص", department: "القسم",
    licenseNumber: "رقم الترخيص المهني", preparedBy: "أعدّه", finalizedAt: "تاريخ الاعتماد",
    medications: "الأدوية الموصوفة", medication: "الدواء والتركيز", dose: "الجرعة",
    frequency: "التكرار", duration: "المدة", route: "طريقة الاستخدام", quantity: "الكمية",
    instructions: "التعليمات", noMedications: "لا توجد أدوية مسجلة",
    prescriptionNotes: "تعليمات إضافية وصلاحية الوصفة",
    prescriptionValidity: shared.notices.prescriptionValidity,
    controlledDisclaimer: shared.notices.controlledPrescription,
    requestedTests: "الفحوصات المطلوبة", testGroup: "الفحوصات المطلوبة", noTests: "لا توجد فحوصات مسجلة",
    clinicalContext: "الملاحظات والتشخيص السريري", requestInstructions: "طلبات أخرى / تعليمات خاصة",
    priority: "الأولوية", laboratory: "المختبر", routine: "اعتيادي", urgent: "عاجل", stat: "فوري",
    certificateDetails: "بيانات الشهادة", leaveStart: "بداية الإجازة", leaveEnd: "نهاية الإجازة",
    returnDate: "تاريخ العودة", recipient: "الجهة المستلمة", recipientReference: "مرجع الجهة",
    certification: (name: string, start: string, end: string, days: string) =>
      `نشهد بأن ${name} كان تحت الرعاية الطبية المهنية. وبناءً على التقييم السريري، يُنصح براحة طبية تامة من ${start} حتى ${end} لمدة ${days} يومًا متتاليًا.`,
    restrictions: "الملاحظات والقيود السريرية", verificationTitle: shared.verification.clinicalTitle,
    verificationCaption: shared.verification.clinicalCaption,
    physicianSignature: shared.signatures.physician, manualSignature: shared.signatures.manual,
    stamp: shared.stamps.physician, clinicApprovalStamp: shared.stamps.clinicApproval,
    footerAttribution: shared.footer.medicalRecordsSystem,
    copyright: shared.footer.authenticity, page: "صفحة", of: "من" };
}

export function getClinicalDocumentCopy(locale: Locale, documentType: P76ClinicalDocumentCode) {
  return locale === "ar" ? arabicCopy(documentType) : englishCopy(documentType);
}
