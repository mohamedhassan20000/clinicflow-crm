import type { ReactNode } from "react";
import { DocumentPage } from "@/components/documents/engine";
import type { Locale } from "@/lib/i18n/config";
import { formatDocMoney, formatDocNumber } from "@/lib/documents/format";
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
import type {
  P72BodyPrimitive,
  P72ConformanceEntry,
} from "./p72-conformance-manifest";

const COPY = {
  en: {
    section: "Conformance fixture",
    patient: "Mert Kaya",
    identifier: "PAT-88210",
    detail: "Dermatology Department",
    status: "ACTIVE",
    labels: ["Department", "Phone", "Amount"],
    values: ["Dermatology", "+90 555 012 3456"],
    stats: ["Total", "Records", "Outstanding"],
    table: ["Item", "Quantity", "Total"],
    service: "Medical consultation",
    empty: "No records",
    group: "Current records",
    count: "1 record",
    totals: ["Subtotal", "Coverage", "Amount due"],
    checklist: "Requested tests",
    checkItems: ["Complete blood count", "Lipid profile"],
    prose: "This certifies that the approved document region is reproduced with the frozen engine primitives.",
    noteLabel: "Notes",
    note: "Fixture content exercises wrapping, spacing, and bidirectional isolation.",
    verifyTitle: "Record verification",
    verifyCaption: "Scan to verify this issued record on ClinicFlow.",
    signature: "Authorized signature",
    stamp: "Clinic stamp",
    attribution: "ClinicFlow Systems · Conformance fixture",
  },
  ar: {
    section: "عينة المطابقة",
    patient: "أحمد محمد",
    identifier: "PAT-88210",
    detail: "قسم الأمراض الجلدية",
    status: "نشط",
    labels: ["القسم", "الهاتف", "المبلغ"],
    values: ["الأمراض الجلدية", "+90 555 012 3456"],
    stats: ["الإجمالي", "السجلات", "المستحق"],
    table: ["البند", "الكمية", "الإجمالي"],
    service: "استشارة طبية",
    empty: "لا توجد سجلات",
    group: "السجلات الحالية",
    count: "1 سجل",
    totals: ["الإجمالي الفرعي", "التغطية", "المبلغ المستحق"],
    checklist: "الفحوص المطلوبة",
    checkItems: ["تعداد الدم الكامل", "تحليل الدهون"],
    prose: "تشهد هذه العينة بأن منطقة المستند المعتمدة قابلة لإعادة البناء باستخدام مكونات المحرك المجمدة.",
    noteLabel: "ملاحظات",
    note: "تختبر بيانات العينة التفاف النص والمسافات والعزل ثنائي الاتجاه.",
    verifyTitle: "التحقق من السجل",
    verifyCaption: "امسح الرمز للتحقق من السجل الصادر عبر كلينيك فلو.",
    signature: "توقيع المعتمد",
    stamp: "ختم العيادة",
    attribution: "نظام كلينيك فلو · عينة مطابقة",
  },
} as const;

function primitiveFixture(
  primitive: P72BodyPrimitive,
  locale: Locale,
  qrDataUrl: string,
  instance: number,
): ReactNode {
  const copy = COPY[locale];
  const formatLocale = { locale, timeZone: "Europe/Istanbul", currency: "TRY", timeFormat: "24h" as const };
  const columns: readonly DocumentTableColumn[] = [
    { key: "item", label: copy.table[0] },
    { key: "quantity", label: copy.table[1], align: "end", direction: "ltr", width: "22%" },
    { key: "total", label: copy.table[2], align: "end", direction: "ltr", width: "28%" },
  ];
  const rows: readonly DocumentTableRow[] = [{
    id: `row-${instance}`,
    cells: {
      item: copy.service,
      quantity: formatDocNumber(2, formatLocale),
      total: formatDocMoney(4000, formatLocale),
    },
  }];

  switch (primitive) {
    case "SectionHeader":
      return <SectionHeader title={copy.section} />;
    case "IdentityHero":
      return <IdentityHero name={copy.patient} identifier={copy.identifier} initials={locale === "ar" ? "أم" : "MK"} detail={copy.detail} />;
    case "FieldGrid":
      return <FieldGrid items={[
        { label: copy.labels[0], value: copy.values[0] },
        { label: copy.labels[1], value: copy.values[1], direction: "ltr" },
        { label: copy.labels[2], value: formatDocMoney(4000, formatLocale), direction: "ltr" },
      ]} />;
    case "StatCardRow":
      return <StatCardRow items={[
        { label: copy.stats[0], value: formatDocMoney(5800, formatLocale) },
        { label: copy.stats[1], value: formatDocNumber(24, formatLocale) },
        { label: copy.stats[2], value: formatDocMoney(1800, formatLocale) },
      ]} />;
    case "StatusBadge":
      return <div><StatusBadge label={copy.status} tone="success" /></div>;
    case "DataTable":
      return <DataTable columns={columns} rows={rows} emptyLabel={copy.empty} caption={copy.section} />;
    case "GroupedTables":
      return <GroupedTables columns={columns} groups={[{ id: `group-${instance}`, title: copy.group, countLabel: copy.count, rows }]} emptyLabel={copy.empty} />;
    case "TotalsSummary":
      return <TotalsSummary items={[
        { label: copy.totals[0], value: formatDocMoney(5800, formatLocale) },
        { label: copy.totals[1], value: formatDocMoney(1800, formatLocale) },
        { label: copy.totals[2], value: formatDocMoney(4000, formatLocale), emphasis: "strong" },
      ]} />;
    case "ChecklistPanel":
      return <ChecklistPanel groups={[{ title: copy.checklist, items: copy.checkItems.map((label, index) => ({ id: `${instance}-${index}`, label, checked: index === 0 })) }]} />;
    case "CertifyingProse":
      return <CertifyingProse>{copy.prose}</CertifyingProse>;
    case "NotesCallout":
      return <NotesCallout label={copy.noteLabel}>{copy.note}</NotesCallout>;
    case "VerificationBlock":
      return <VerificationBlock qrDataUrl={qrDataUrl} title={copy.verifyTitle} caption={copy.verifyCaption} verificationKey="P72-VERIFY-2026-0001" />;
    case "SignatureBlock":
      return <SignatureBlock signatures={[{ id: `signature-${instance}`, label: copy.signature }]} stampLabel={copy.stamp} />;
  }
}

/** Non-production structural proof; it is not a production document template. */
export function DocumentConformanceHarness({
  entry,
  locale,
  qrDataUrl,
}: {
  entry: P72ConformanceEntry;
  locale: Locale;
  qrDataUrl: string;
}) {
  const copy = COPY[locale];
  return (
    <div
      data-testid="p72-conformance-document"
      data-document-code={entry.code}
      data-primitive-map={entry.primitives.join(",")}
    >
      <DocumentPage
        locale={locale}
        lifecycle="issued"
        branding={{ name: locale === "ar" ? "مجموعة كلينيك فلو الطبية" : "ClinicFlow Medical Group", footerText: copy.attribution }}
        identity={{
          title: entry.title.toLocaleUpperCase("en-US"),
          documentNumber: `P72-${String(entry.ordinal).padStart(2, "0")}`,
          issueDate: "01 Aug 2026",
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
        watermark={{ enabled: false }}
        footer={{ attribution: copy.attribution }}
      >
        {entry.primitives.map((primitive, index) => (
          <div key={`${primitive}-${index}`} data-p72-primitive={primitive}>
            {primitiveFixture(primitive, locale, qrDataUrl, index)}
          </div>
        ))}
      </DocumentPage>
    </div>
  );
}
