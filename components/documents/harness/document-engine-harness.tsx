import type { Locale } from "@/lib/i18n/config";
import { DocumentPage, type DocumentRenderContextBoundary } from "@/components/documents/engine";
import {
  CertifyingProse,
  ChecklistPanel,
  DataTable,
  FieldGrid,
  GroupedTables,
  IdentityHero,
  NotesCallout,
  SectionHeader,
  SignatureBlock,
  StatCardRow,
  StatusBadge,
  TotalsSummary,
  VerificationBlock,
  type DocumentTableColumn,
  type DocumentTableRow,
} from "@/components/documents/primitives";
import { formatDocMoney, formatDocNumber } from "@/lib/documents/format";

const COPY = {
  en: {
    title: "ENGINE PRIMITIVE HARNESS",
    period: "01 Jul — 31 Jul 2026",
    section: "Shared primitive coverage",
    patient: "Mert Kaya",
    patientId: "PAT-88210",
    active: "ACTIVE",
    kpis: ["Total revenue", "Completed visits", "Outstanding"],
    table: ["Service", "Quantity", "Total"],
    empty: "No records",
    group: "Dermatology",
    patients: "2 patients",
    fields: ["Department", "Phone", "Email", "Optional field"],
    note: "Notes and long content wrap without changing the surrounding layout.",
    noteLabel: "Document notes",
    certify: "This certifies that the shared prose primitive preserves readable line length, emphasis, and bidirectional isolation.",
    checklist: ["Hematology", "Biochemistry"],
    tests: ["Complete blood count", "Lipid profile", "Liver function"],
    totals: ["Subtotal", "Coverage", "Amount due"],
    signature: ["Authorized signature", "Patient signature"],
    stamp: "Clinic stamp",
    verificationTitle: "Record verification",
    verificationCaption: "Scan to verify this issued record on ClinicFlow.",
    attribution: "ClinicFlow Systems · Confidential medical record",
    copyright: "© 2026 ClinicFlow. All rights reserved.",
    terms: "Terms of Service",
    privacy: "Privacy Policy",
  },
  ar: {
    title: "معاينة مكونات محرك المستندات",
    period: "01 يوليو — 31 يوليو 2026",
    section: "تغطية المكونات المشتركة",
    patient: "أحمد محمد",
    patientId: "PAT-88210",
    active: "نشط",
    kpis: ["إجمالي الإيرادات", "الزيارات المكتملة", "المبلغ المستحق"],
    table: ["الخدمة", "الكمية", "الإجمالي"],
    empty: "لا توجد سجلات",
    group: "الأمراض الجلدية",
    patients: "2 مريض",
    fields: ["القسم", "الهاتف", "البريد الإلكتروني", "حقل اختياري"],
    note: "تلتف الملاحظات والمحتويات الطويلة دون تغيير توازن التخطيط المحيط.",
    noteLabel: "ملاحظات المستند",
    certify: "تشهد هذه الفقرة بأن مكوّن النص الرسمي يحافظ على طول السطر المقروء والعزل الصحيح للمحتوى ثنائي الاتجاه.",
    checklist: ["أمراض الدم", "الكيمياء الحيوية"],
    tests: ["تعداد الدم الكامل", "تحليل الدهون", "وظائف الكبد"],
    totals: ["الإجمالي الفرعي", "تغطية التأمين", "المبلغ المتبقي"],
    signature: ["توقيع المعتمد", "توقيع المريض"],
    stamp: "ختم العيادة",
    verificationTitle: "التحقق من السجل",
    verificationCaption: "امسح الرمز للتحقق من السجل الصادر عبر كلينيك فلو.",
    attribution: "نظام كلينيك فلو · سجل طبي سري",
    copyright: "© 2026 كلينيك فلو. جميع الحقوق محفوظة.",
    terms: "شروط الخدمة",
    privacy: "سياسة الخصوصية",
  },
} as const;

export function DocumentEngineHarness({
  locale,
  qrDataUrl,
  lifecycle = "preview",
  renderContextBoundary,
}: {
  locale: Locale;
  qrDataUrl: string;
  lifecycle?: "preview" | "issued";
  renderContextBoundary?: DocumentRenderContextBoundary;
}) {
  const copy = COPY[locale];
  const formatLocale = {
    locale,
    timeZone: "Europe/Istanbul",
    currency: "TRY",
    timeFormat: "24h" as const,
  };
  const columns: readonly DocumentTableColumn[] = [
    { key: "service", label: copy.table[0] },
    { key: "quantity", label: copy.table[1], align: "end", direction: "ltr", width: "22%" },
    { key: "total", label: copy.table[2], align: "end", direction: "ltr", width: "28%" },
  ];
  const rows: readonly DocumentTableRow[] = [
    {
      id: "service-1",
      cells: {
        service: locale === "ar" ? "استشارة طبية" : "Medical consultation",
        quantity: formatDocNumber(2, formatLocale),
        total: formatDocMoney(4000, formatLocale),
      },
    },
    {
      id: "service-2",
      cells: {
        service: locale === "ar" ? "فحص مختبري" : "Laboratory screening",
        quantity: formatDocNumber(1, formatLocale),
        total: formatDocMoney(1800, formatLocale),
      },
    },
  ];

  return (
    <DocumentPage
      locale={locale}
      lifecycle={lifecycle}
      branding={{
        name: locale === "ar" ? "مجموعة كلينيك فلو الطبية" : "ClinicFlow Medical Group",
        address: locale === "ar" ? "124 شارع الرعاية الصحية" : "124 Healthcare Avenue",
        phone: "+90 555 012 3456",
        email: "care@clinicflow.fit",
        licenseNo: "MED-9920-X",
        footerText: copy.attribution,
      }}
      identity={{
        title: copy.title,
        documentNumber: lifecycle === "issued" ? "ENG-2026-0001" : null,
        issueDate: "01 Aug 2026",
        issueTime: "17:45",
        period: copy.period,
        labels: locale === "ar" ? {
          documentNumber: "رقم المستند",
          issueDate: "تاريخ الإصدار",
          issueTime: "الوقت",
          period: "الفترة",
        } : {
          documentNumber: "Document no.",
          issueDate: "Issued",
          issueTime: "Time",
          period: "Period",
        },
      }}
      watermark={{ enabled: true, text: locale === "ar" ? "رسمي" : "OFFICIAL" }}
      footer={{
        attribution: copy.attribution,
        copyright: copy.copyright,
        links: [{ label: copy.terms }, { label: copy.privacy }],
      }}
      renderContextBoundary={renderContextBoundary}
    >
      <SectionHeader title={copy.section} />
      <IdentityHero
        name={copy.patient}
        identifier={copy.patientId}
        initials={locale === "ar" ? "أم" : "MK"}
        detail={locale === "ar" ? "قسم الأمراض الجلدية" : "Dermatology Department"}
        status={<StatusBadge label={copy.active} tone="success" />}
      />
      <FieldGrid
        items={[
          { label: copy.fields[0], value: locale === "ar" ? "الأمراض الجلدية" : "Dermatology" },
          { label: copy.fields[1], value: "+90 555 012 3456", direction: "ltr" },
          { label: copy.fields[2], value: "patient@example.com", direction: "ltr" },
          { label: copy.fields[3], value: null },
        ]}
      />
      <StatCardRow items={[
        { label: copy.kpis[0], value: formatDocMoney(7800, formatLocale), detail: locale === "ar" ? "الجلسات والدفعات" : "Sessions and deposits" },
        { label: copy.kpis[1], value: formatDocNumber(24, formatLocale) },
        { label: copy.kpis[2], value: formatDocMoney(5100, formatLocale) },
      ]} />
      <DataTable
        caption={copy.section}
        columns={columns}
        rows={rows}
        emptyLabel={copy.empty}
        totals={{ service: copy.totals[0], total: formatDocMoney(5800, formatLocale) }}
      />
      <GroupedTables
        columns={columns}
        groups={[{ id: "dermatology", title: copy.group, countLabel: copy.patients, rows }]}
        emptyLabel={copy.empty}
      />
      <TotalsSummary items={[
        { label: copy.totals[0], value: formatDocMoney(7800, formatLocale) },
        { label: copy.totals[1], value: formatDocMoney(1700, formatLocale) },
        { label: copy.totals[2], value: formatDocMoney(6100, formatLocale), emphasis: "strong" },
      ]} />
      <ChecklistPanel groups={copy.checklist.map((title, groupIndex) => ({
        title,
        items: copy.tests.map((label, index) => ({
          id: `${groupIndex}-${index}`,
          label,
          checked: index <= groupIndex,
        })),
      }))} />
      <CertifyingProse>{copy.certify}</CertifyingProse>
      <NotesCallout label={copy.noteLabel}>{copy.note}</NotesCallout>
      <VerificationBlock
        qrDataUrl={qrDataUrl}
        title={copy.verificationTitle}
        caption={copy.verificationCaption}
        verificationKey="ENG-VERIFY-2026-0001"
      />
      <SignatureBlock
        signatures={copy.signature.map((label, index) => ({ id: `signature-${index}`, label }))}
        stampLabel={copy.stamp}
      />
    </DocumentPage>
  );
}
