import { DocumentPage, type DocumentLifecycle, type DocumentRenderContextBoundary } from "@/components/documents/engine";
import {
  DataTable,
  FieldGrid,
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
import {
  formatDocDate,
  formatDocMoney,
  formatDocNumber,
  formatDocTime,
} from "@/lib/documents/format";
import type { PatientHistoryCopy } from "@/lib/documents/patient-history-copy";
import type { PatientHistoryDocumentSnapshot } from "@/lib/documents/resolvers/patient-history";
import type { Locale } from "@/lib/i18n/config";

export function PatientHistoryDocument({
  locale,
  lifecycle,
  snapshot,
  copy,
  documentNumber,
  qrDataUrl,
  renderContextBoundary,
}: {
  locale: Locale;
  lifecycle: DocumentLifecycle;
  snapshot: PatientHistoryDocumentSnapshot;
  copy: PatientHistoryCopy;
  documentNumber?: string | null;
  qrDataUrl?: string | null;
  renderContextBoundary?: DocumentRenderContextBoundary;
}) {
  const formatLocale = {
    locale,
    timeZone: snapshot.format.timeZone,
    currency: snapshot.format.currency,
    timeFormat: snapshot.format.timeFormat,
  };
  const date = (value: string) => formatDocDate(value, formatLocale, { dateStyle: "medium" });
  const time = (value: string) => formatDocTime(value, formatLocale);
  const money = (value: number) => formatDocMoney(value, formatLocale);
  const num = (value: number) => formatDocNumber(value, formatLocale);
  const period = copy.rangeLabel(snapshot.range.from, snapshot.range.to);

  const verification =
    lifecycle !== "preview" && snapshot.settings.qrEnabled && qrDataUrl ? (
      <VerificationBlock
        qrDataUrl={qrDataUrl}
        title={copy.verificationTitle}
        caption={copy.verificationCaption}
        verificationKey={documentNumber}
      />
    ) : null;

  const financialSignature =
    snapshot.documentType === "DEPOSIT_STATEMENT" ||
    snapshot.documentType === "PATIENT_FINANCIAL_SUMMARY";

  return (
    <DocumentPage
      locale={locale}
      lifecycle={lifecycle}
      branding={snapshot.branding}
      identity={{
        title: copy.title,
        documentNumber: lifecycle !== "preview" ? documentNumber : null,
        issueDate: date(snapshot.generatedAt),
        issueTime: time(snapshot.generatedAt),
        period,
        labels: copy.labels,
      }}
      watermark={{
        enabled: lifecycle !== "preview" && snapshot.settings.watermark !== null,
        text: snapshot.settings.watermark,
      }}
      footer={{
        attribution: snapshot.branding.footerText || copy.footerAttribution,
        copyright: copy.copyright,
      }}
      pageLabels={{ page: copy.page, of: copy.of }}
      renderContextBoundary={renderContextBoundary}
    >
      <FieldGrid
        columns={3}
        items={[
          { label: copy.patient, value: snapshot.patient.fullName },
          { label: copy.fileNumber, value: snapshot.patient.fileNumber, direction: "ltr" },
          { label: copy.phone, value: snapshot.patient.phone, direction: "ltr" },
          { label: copy.period, value: period },
        ]}
      />

      {snapshot.data.kind === "appointment-history" && (
        <AppointmentHistoryBody
          data={snapshot.data}
          copy={copy}
          date={date}
          money={money}
        />
      )}
      {snapshot.data.kind === "package-history" && (
        <PackageHistoryBody data={snapshot.data} copy={copy} date={date} money={money} num={num} />
      )}
      {snapshot.data.kind === "deposit-statement" && (
        <DepositStatementBody data={snapshot.data} copy={copy} date={date} money={money} />
      )}
      {snapshot.data.kind === "financial-summary" && (
        <FinancialSummaryBody data={snapshot.data} copy={copy} money={money} num={num} />
      )}

      <NotesCallout label={copy.title} tone="neutral">
        <p>{copy.scopeNote}</p>
      </NotesCallout>
      {verification}
      <SignatureBlock
        signatures={[
          {
            id: "authorized",
            label: financialSignature ? copy.accountsSignature : copy.authorizedSignature,
          },
        ]}
        stampLabel={copy.stamp}
      />
    </DocumentPage>
  );
}

type DataOf<K extends PatientHistoryDocumentSnapshot["data"]["kind"]> = Extract<
  PatientHistoryDocumentSnapshot["data"],
  { kind: K }
>;

function AppointmentHistoryBody({
  data,
  copy,
  date,
  money,
}: {
  data: DataOf<"appointment-history">;
  copy: PatientHistoryCopy;
  date: (value: string) => string;
  money: (value: number) => string;
}) {
  const columns: readonly DocumentTableColumn[] = [
    { key: "date", label: copy.date, width: "14%", direction: "ltr" },
    { key: "doctor", label: copy.doctor, width: "18%" },
    { key: "department", label: copy.department, width: "14%" },
    { key: "status", label: copy.status, width: "12%", align: "center" },
    { key: "extras", label: copy.followUp, width: "26%" },
    ...(data.financialVisible
      ? [{ key: "outstanding", label: copy.outstanding, width: "16%", direction: "ltr" as const, align: "end" as const }]
      : []),
  ];
  const rows: DocumentTableRow[] = data.entries.map((entry) => {
    const extras: string[] = [];
    if (entry.followUps.length > 0) {
      extras.push(
        entry.followUps
          .map((followUp) => copy.followUpOutcome(followUp.outcome))
          .join(copy.listSeparator),
      );
    }
    if (entry.note) extras.push(`${copy.medicalNote}: ${entry.note.slice(0, 80)}`);
    if (entry.relatedDocuments.length > 0) {
      extras.push(
        `${copy.relatedDocuments}: ${entry.relatedDocuments.map((d) => d.documentNumber).join(copy.listSeparator)}`,
      );
    }
    return {
      id: entry.id,
      cells: {
        date: date(entry.scheduledAt),
        doctor: entry.doctorName,
        department: entry.departmentName,
        status: <StatusBadge label={copy.appointmentStatus(entry.status)} tone="neutral" />,
        extras: extras.length > 0 ? extras.join(" · ") : "—",
        ...(data.financialVisible
          ? { outstanding: entry.billing ? money(entry.billing.outstanding) : "—" }
          : {}),
      },
    };
  });
  return (
    <>
      <SectionHeader title={`${copy.appointmentHistory} · ${copy.appointmentsCount(data.totalCount)}`} />
      <DataTable columns={columns} rows={rows} emptyLabel={copy.noRows} />
      {data.financialVisible && data.billingTotals && (
        <TotalsSummary
          items={[
            { label: copy.billed, value: money(data.billingTotals.billed) },
            { label: copy.collected, value: money(data.billingTotals.collected) },
            {
              label: copy.outstanding,
              value: money(data.billingTotals.outstanding),
              emphasis: "strong",
            },
          ]}
        />
      )}
    </>
  );
}

function PackageHistoryBody({
  data,
  copy,
  date,
  money,
  num,
}: {
  data: DataOf<"package-history">;
  copy: PatientHistoryCopy;
  date: (value: string) => string;
  money: (value: number) => string;
  num: (value: number) => string;
}) {
  const columns: readonly DocumentTableColumn[] = [
    { key: "name", label: copy.packageName, width: "24%" },
    { key: "department", label: copy.department, width: "16%" },
    { key: "purchased", label: copy.purchased, width: "11%", direction: "ltr", align: "center" },
    { key: "used", label: copy.used, width: "11%", direction: "ltr", align: "center" },
    { key: "remaining", label: copy.remaining, width: "11%", direction: "ltr", align: "center" },
    { key: "price", label: copy.pricePerSession, width: "13%", direction: "ltr", align: "end" },
    { key: "status", label: copy.status, width: "14%", align: "center" },
  ];
  const rows: DocumentTableRow[] = data.packages.map((pkg) => ({
    id: pkg.id,
    cells: {
      name: `${pkg.name} · ${date(pkg.createdAt)}`,
      department: pkg.departmentName,
      purchased: num(pkg.purchasedSessions),
      used: num(pkg.usedSessions),
      remaining: num(pkg.remainingSessions),
      price: pkg.pricePerSession == null ? "—" : money(pkg.pricePerSession),
      status: (
        <StatusBadge
          label={pkg.isActive ? copy.active : copy.inactive}
          tone={pkg.isActive ? "success" : "neutral"}
        />
      ),
    },
  }));
  return (
    <>
      <SectionHeader title={copy.packages} />
      <DataTable columns={columns} rows={rows} emptyLabel={copy.noRows} />
      <TotalsSummary
        items={[
          { label: copy.purchased, value: `${num(data.totals.purchasedSessions)} ${copy.sessions}` },
          { label: copy.used, value: `${num(data.totals.usedSessions)} ${copy.sessions}` },
          {
            label: copy.remaining,
            value: `${num(data.totals.remainingSessions)} ${copy.sessions}`,
            emphasis: "strong",
          },
        ]}
      />
    </>
  );
}

function DepositStatementBody({
  data,
  copy,
  date,
  money,
}: {
  data: DataOf<"deposit-statement">;
  copy: PatientHistoryCopy;
  date: (value: string) => string;
  money: (value: number) => string;
}) {
  const columns: readonly DocumentTableColumn[] = [
    { key: "date", label: copy.date, width: "18%", direction: "ltr" },
    { key: "transaction", label: copy.transaction, width: "40%" },
    { key: "amount", label: copy.amount, width: "20%", direction: "ltr", align: "end" },
    { key: "balance", label: copy.runningBalance, width: "22%", direction: "ltr", align: "end" },
  ];
  const rows: DocumentTableRow[] = data.transactions.map((tx) => ({
    id: tx.id,
    cells: {
      date: date(tx.createdAt),
      transaction: [tx.note, tx.recordedByName ? `${copy.recordedBy}: ${tx.recordedByName}` : null]
        .filter(Boolean)
        .join(" · ") || copy.transaction,
      amount: money(tx.amount),
      balance: money(tx.runningBalance),
    },
  }));
  return (
    <>
      <StatCardRow
        items={[
          { label: copy.openingBalance, value: money(data.openingBalance) },
          { label: copy.totalDeposited, value: money(data.totalDeposited) },
          { label: copy.totalUsed, value: money(data.totalSpent) },
          { label: copy.currentBalance, value: money(data.currentBalance) },
        ]}
      />
      <SectionHeader title={copy.depositStatement} />
      <DataTable columns={columns} rows={rows} emptyLabel={copy.noRows} />
      <TotalsSummary
        items={[
          { label: copy.currentBalance, value: money(data.currentBalance), emphasis: "strong" },
        ]}
      />
    </>
  );
}

function FinancialSummaryBody({
  data,
  copy,
  money,
  num,
}: {
  data: DataOf<"financial-summary">;
  copy: PatientHistoryCopy;
  money: (value: number) => string;
  num: (value: number) => string;
}) {
  return (
    <>
      <StatCardRow
        items={[
          { label: copy.appointmentCharges, value: money(data.appointmentCharges) },
          { label: copy.payments, value: money(data.payments) },
          { label: copy.outstanding, value: money(data.outstanding) },
          { label: copy.depositBalance, value: money(data.depositsBalance) },
        ]}
      />
      <SectionHeader title={copy.financialSummary} />
      <FieldGrid
        columns={2}
        items={[
          { label: copy.appointmentCharges, value: money(data.appointmentCharges), direction: "ltr" },
          { label: copy.payments, value: money(data.payments), direction: "ltr" },
          { label: copy.outstanding, value: money(data.outstanding), direction: "ltr" },
          { label: copy.totalDeposited, value: money(data.totalDeposited), direction: "ltr" },
          { label: copy.depositBalance, value: money(data.depositsBalance), direction: "ltr" },
          { label: copy.packageBalance, value: money(data.packageBalance), direction: "ltr" },
          { label: copy.activePackages, value: num(data.activePackages), direction: "ltr" },
        ]}
      />
      <TotalsSummary
        items={[
          { label: copy.outstanding, value: money(data.outstanding), emphasis: "strong" },
        ]}
      />
    </>
  );
}
