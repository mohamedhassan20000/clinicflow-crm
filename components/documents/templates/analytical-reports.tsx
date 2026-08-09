import type { ReactNode } from "react";
import {
  DocumentPage,
  type DocumentLifecycle,
  type DocumentRenderContextBoundary,
} from "@/components/documents/engine";
import {
  DataTable,
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
import type { AnalyticalReportCopy } from "@/lib/documents/analytical-copy";
import {
  formatDocDate,
  formatDocMoney,
  formatDocNumber,
  formatDocPercent,
  formatDocTime,
} from "@/lib/documents/format";
import type { AnalyticalDocumentSnapshot } from "@/lib/documents/resolvers/analytical-report";
import type { Locale } from "@/lib/i18n/config";

export type AnalyticalReportDocumentProps = {
  locale: Locale;
  lifecycle: DocumentLifecycle;
  snapshot: AnalyticalDocumentSnapshot;
  copy: AnalyticalReportCopy;
  documentNumber?: string | null;
  qrDataUrl?: string | null;
  renderContextBoundary?: DocumentRenderContextBoundary;
};

type Formatters = {
  number: (value: number) => string;
  money: (value: number) => string;
  percent: (value: number) => string;
  date: (value: string) => string;
  time: (value: string) => string;
};

export function AnalyticalReportDocument({
  locale,
  lifecycle,
  snapshot,
  copy,
  documentNumber,
  qrDataUrl,
  renderContextBoundary,
}: AnalyticalReportDocumentProps) {
  const formatLocale = {
    locale,
    timeZone: snapshot.format.timeZone,
    currency: snapshot.format.currency,
    timeFormat: snapshot.format.timeFormat,
  };
  const formatters: Formatters = {
    number: (value) => formatDocNumber(value, formatLocale),
    money: (value) => formatDocMoney(value, formatLocale, {
      currencyDisplay: "code",
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }),
    percent: (value) => formatDocPercent(value / 100, formatLocale),
    date: (value) => formatDocDate(value, formatLocale, { dateStyle: "medium" }),
    time: (value) => formatDocTime(value, formatLocale),
  };
  const period = [snapshot.range.start, snapshot.range.end]
    .map(formatters.date)
    .join(" — ");

  return (
    <DocumentPage
      locale={locale}
      lifecycle={lifecycle}
      branding={snapshot.branding}
      identity={{
        title: copy.title,
        documentNumber: lifecycle !== "preview" ? documentNumber : null,
        issueDate: formatters.date(snapshot.generatedAt),
        issueTime: formatters.time(snapshot.generatedAt),
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
      <AnalyticalBody snapshot={snapshot} copy={copy} formatters={formatters} />

      {lifecycle !== "preview" && snapshot.settings.qrEnabled && qrDataUrl && (
        <VerificationBlock
          qrDataUrl={qrDataUrl}
          title={copy.verificationTitle}
          caption={copy.verificationCaption}
        />
      )}

      <SignatureBlock signatures={[
        { id: "authorized-signature", label: `${copy.signatureLabel} · ${copy.signatureRole}` },
      ]} />
    </DocumentPage>
  );
}

function AnalyticalBody({
  snapshot,
  copy,
  formatters,
}: {
  snapshot: AnalyticalDocumentSnapshot;
  copy: AnalyticalReportCopy;
  formatters: Formatters;
}) {
  switch (snapshot.data.kind) {
    case "follow-up-page":
      return <FollowUpPageBody data={snapshot.data} copy={copy} f={formatters} />;
    case "cancellation":
      return <CancellationBody data={snapshot.data} copy={copy} f={formatters} />;
    case "no-show":
      return <NoShowBody data={snapshot.data} copy={copy} f={formatters} />;
    case "sales":
      return <SalesBody data={snapshot.data} copy={copy} f={formatters} />;
    case "follow-up-analytics":
      return <FollowUpAnalyticsBody data={snapshot.data} copy={copy} f={formatters} />;
    case "doctor-performance":
      return <DoctorPerformanceBody data={snapshot.data} copy={copy} f={formatters} />;
    case "receptionist-performance":
      return <ReceptionistPerformanceBody data={snapshot.data} copy={copy} f={formatters} />;
  }
}

type SnapshotData<K extends AnalyticalDocumentSnapshot["data"]["kind"]> = Extract<
  AnalyticalDocumentSnapshot["data"],
  { kind: K }
>;

function FollowUpPageBody({
  data,
  copy,
  f,
}: {
  data: SnapshotData<"follow-up-page">;
  copy: AnalyticalReportCopy;
  f: Formatters;
}) {
  const columns: readonly DocumentTableColumn[] = [
    { key: "status", label: copy.terms.status, width: "12%" },
    { key: "recorded", label: copy.terms.recorded, width: "16%", direction: "ltr" },
    { key: "patient", label: copy.terms.patient, width: "16%" },
    { key: "doctor", label: copy.terms.doctor, width: "20%" },
    { key: "outcome", label: copy.terms.outcome, width: "14%" },
    { key: "notes", label: copy.terms.notes, width: "22%" },
  ];
  const rows: readonly DocumentTableRow[] = data.rows.map((row) => ({
    id: row.id,
    cells: {
      status: <StatusBadge label={copy.terms.completed} tone="success" />,
      recorded: <>{f.date(row.recordedAt)}<br /><small>{f.time(row.recordedAt)}</small></>,
      patient: <>{row.patientName}{row.patientFileNumber && <><br /><small>{row.patientFileNumber}</small></>}</>,
      doctor: <>{row.doctorName}{row.departmentName && <><br /><small>{row.departmentName}</small></>}</>,
      outcome: copy.outcomes[row.outcome],
      notes: row.notes || "—",
    },
  }));
  return (
    <>
      <SectionHeader title={`${copy.terms.dailyFollowup} · ${copy.terms.finalReview}`} />
      <StatCardRow items={[
        { label: copy.terms.awaitingFollowup, value: f.number(data.pendingCount) },
        { label: copy.terms.allFine, value: f.number(data.allFineCount) },
        { label: copy.terms.hasProblem, value: f.number(data.hasProblemCount) },
        { label: copy.terms.noResponse, value: f.number(data.noResponseCount) },
      ]} />
      <DataTable
        columns={columns}
        rows={rows}
        emptyLabel={copy.empty}
        caption={copy.terms.completedFollowupDetails}
      />
    </>
  );
}

function CancellationBody({ data, copy, f }: {
  data: SnapshotData<"cancellation">;
  copy: AnalyticalReportCopy;
  f: Formatters;
}) {
  const columns: readonly DocumentTableColumn[] = [
    { key: "doctor", label: copy.terms.doctor, width: "40%" },
    { key: "total", label: copy.terms.total, align: "end", direction: "ltr" },
    { key: "cancelled", label: copy.terms.cancelled, align: "end", direction: "ltr" },
    { key: "rate", label: copy.terms.rate, align: "end", direction: "ltr" },
  ];
  const reasons = data.byReason.length
    ? data.byReason.map((row) => `${row.reason} (${f.number(row.count)})`).join(" · ")
    : copy.terms.noReasons;
  return (
    <>
      <NotesCallout label={copy.notesTitle}>
        <p>{copy.description}</p>
        <p><strong>{copy.terms.topCancellationReasons}:</strong> {reasons}</p>
        <p><strong>{copy.terms.auditTrail}:</strong> {copy.terms.dataAccuracy} — {copy.terms.verified}</p>
      </NotesCallout>
      <StatCardRow items={[
        { label: copy.terms.appointments, value: f.number(data.totalAppointments) },
        { label: copy.terms.cancelled, value: f.number(data.cancelledCount) },
        { label: copy.terms.cancellationRate, value: f.percent(data.cancellationRate) },
        { label: copy.terms.replaced, value: f.number(data.replacedCount) },
      ]} />
      <SectionHeader title={copy.sectionTitle} />
      <DataTable
        columns={columns}
        rows={data.byDoctor.map((row) => ({ id: row.doctorId, cells: {
          doctor: row.doctorName,
          total: f.number(row.total),
          cancelled: f.number(row.cancelled),
          rate: f.percent(row.rate),
        } }))}
        totals={{
          doctor: copy.terms.grandTotal,
          total: f.number(data.totalAppointments),
          cancelled: f.number(data.cancelledCount),
          rate: f.percent(data.cancellationRate),
        }}
        emptyLabel={copy.empty}
      />
      <TotalsSummary items={[
        { label: copy.terms.replacementRate, value: f.percent(data.replacementRate), emphasis: "strong" },
      ]} />
    </>
  );
}

function NoShowBody({ data, copy, f }: {
  data: SnapshotData<"no-show">;
  copy: AnalyticalReportCopy;
  f: Formatters;
}) {
  const columns: readonly DocumentTableColumn[] = [
    { key: "doctor", label: copy.terms.doctor, width: "40%" },
    { key: "total", label: copy.terms.total, align: "end", direction: "ltr" },
    { key: "noShows", label: copy.terms.noShows, align: "end", direction: "ltr" },
    { key: "rate", label: copy.terms.rate, align: "end", direction: "ltr" },
  ];
  return (
    <>
      <StatCardRow items={[
        { label: copy.terms.appointments, value: f.number(data.totalAppointments) },
        { label: copy.terms.noShows, value: f.number(data.noShowCount) },
        { label: copy.terms.noShowRate, value: f.percent(data.noShowRate) },
        { label: copy.terms.replaced, value: f.number(data.replacedCount) },
      ]} />
      <SectionHeader title={copy.sectionTitle} />
      <DataTable
        columns={columns}
        rows={data.byDoctor.map((row) => ({ id: row.doctorId, cells: {
          doctor: row.doctorName,
          total: f.number(row.total),
          noShows: f.number(row.noShow),
          rate: f.percent(row.rate),
        } }))}
        totals={{
          doctor: copy.terms.grandTotal,
          total: f.number(data.totalAppointments),
          noShows: f.number(data.noShowCount),
          rate: f.percent(data.noShowRate),
        }}
        emptyLabel={copy.empty}
      />
      <TotalsSummary items={[
        { label: copy.terms.replacementRate, value: f.percent(data.replacementRate) },
      ]} />
      <NotesCallout label={copy.terms.internalNotes}>
        <p>{copy.notesBody}</p>
        <p><strong>{copy.terms.medicalDirectorReview}:</strong> {copy.terms.signatureDate}</p>
      </NotesCallout>
    </>
  );
}

function SalesBody({ data, copy, f }: {
  data: SnapshotData<"sales">;
  copy: AnalyticalReportCopy;
  f: Formatters;
}) {
  const metricColumns: readonly DocumentTableColumn[] = [
    { key: "metric", label: copy.terms.metric },
    { key: "value", label: copy.terms.value, align: "end", direction: "ltr" },
  ];
  const paymentColumns: readonly DocumentTableColumn[] = [
    { key: "method", label: copy.terms.paymentMethod },
    { key: "amount", label: copy.terms.amount, align: "end", direction: "ltr" },
  ];
  return (
    <>
      <SectionHeader title={copy.sectionTitle} />
      <StatCardRow items={[
        { label: copy.terms.collectedRevenue, value: f.money(data.collectedTotal) },
        { label: copy.terms.serviceTotal, value: f.money(data.serviceTotal) },
        { label: copy.terms.primaryPayments, value: f.money(data.primaryTotal) },
        { label: copy.terms.secondaryPayments, value: f.money(data.secondaryTotal) },
        { label: copy.terms.insurance, value: f.money(data.insuranceTotal) },
        { label: copy.terms.deposits, value: f.money(data.depositTotal) },
        { label: copy.terms.settlements, value: f.money(data.settlementTotal) },
        { label: copy.terms.outstanding, value: f.money(data.outstandingTotal) },
      ]} />
      <DataTable
        columns={metricColumns}
        rows={[
          { id: "transactions", cells: { metric: copy.terms.transactions, value: f.number(data.transactionCount) } },
          { id: "settlements", cells: { metric: copy.terms.settlementPayments, value: f.number(data.settlementCount) } },
          { id: "collected", cells: { metric: copy.terms.collectedRevenue, value: f.money(data.collectedTotal) } },
          { id: "outstanding", cells: { metric: copy.terms.outstanding, value: f.money(data.outstandingTotal) } },
        ]}
        emptyLabel={copy.empty}
      />
      <DataTable
        columns={paymentColumns}
        rows={data.paymentMethods.map((row, index) => ({
          id: `${row.method}-${index}`,
          cells: {
            method: copy.paymentMethods[row.method] ?? copy.paymentMethods.other,
            amount: f.money(row.amount),
          },
        }))}
        emptyLabel={copy.empty}
      />
      <TotalsSummary items={[
        { label: copy.terms.grandTotal, value: f.money(data.collectedTotal), emphasis: "strong" },
      ]} />
      <NotesCallout label={copy.notesTitle}><p>{copy.notesBody}</p></NotesCallout>
    </>
  );
}

function ShareBar({ value, formatted }: { value: number; formatted: string }) {
  const width = `${Math.max(0, Math.min(100, value))}%`;
  return (
    <div style={{ display: "grid", gap: "4px", minInlineSize: "96px" }}>
      <bdi className="cf-doc-ltr">{formatted}</bdi>
      <span
        aria-hidden
        style={{ display: "block", blockSize: "4px", background: "var(--doc-panel-blue)", borderRadius: "999px", overflow: "hidden" }}
      >
        <span style={{ display: "block", inlineSize: width, blockSize: "100%", background: "var(--doc-accent-bright)" }} />
      </span>
    </div>
  );
}

function FollowUpAnalyticsBody({ data, copy, f }: {
  data: SnapshotData<"follow-up-analytics">;
  copy: AnalyticalReportCopy;
  f: Formatters;
}) {
  const columns: readonly DocumentTableColumn[] = [
    { key: "outcome", label: copy.terms.outcome, width: "35%" },
    { key: "count", label: copy.terms.count, width: "20%", align: "end", direction: "ltr" },
    { key: "rate", label: copy.terms.rate, width: "20%", align: "end", direction: "ltr" },
    { key: "share", label: copy.terms.share, width: "25%" },
  ];
  return (
    <>
      <SectionHeader title={copy.sectionTitle} />
      <NotesCallout label={copy.notesTitle}><p>{copy.description}</p></NotesCallout>
      <StatCardRow items={[
        { label: copy.terms.completedFollowups, value: f.number(data.completedCount) },
        { label: copy.terms.allFine, value: f.number(data.allFineCount) },
        { label: copy.terms.hasProblem, value: f.number(data.hasProblemCount) },
        { label: copy.terms.noResponse, value: f.number(data.noResponseCount) },
      ]} />
      <DataTable
        columns={columns}
        rows={data.outcomes.map((row) => ({
          id: row.outcome,
          cells: {
            outcome: copy.outcomes[row.outcome],
            count: f.number(row.count),
            rate: f.percent(row.rate),
            share: <ShareBar value={row.rate} formatted={f.percent(row.rate)} />,
          },
        }))}
        totals={{
          outcome: copy.terms.grandTotal,
          count: f.number(data.completedCount),
          rate: f.percent(data.completedCount > 0 ? 100 : 0),
        }}
        emptyLabel={copy.empty}
      />
    </>
  );
}

function DoctorPerformanceBody({ data, copy, f }: {
  data: SnapshotData<"doctor-performance">;
  copy: AnalyticalReportCopy;
  f: Formatters;
}) {
  const sessions = data.doctors.reduce((sum, row) => sum + row.sessions, 0);
  const completed = data.doctors.reduce((sum, row) => sum + row.completed, 0);
  const revenue = data.doctors.reduce((sum, row) => sum + row.revenue, 0);
  const impact = data.doctors.length === 1 ? data.doctors[0] : null;
  const columns: readonly DocumentTableColumn[] = [
    { key: "doctor", label: copy.terms.doctor, width: "18%" },
    { key: "sessions", label: copy.terms.sessions, align: "end", direction: "ltr" },
    { key: "completed", label: copy.terms.completed, align: "end", direction: "ltr" },
    { key: "cancelled", label: copy.terms.cancelled, align: "end", direction: "ltr" },
    { key: "noShow", label: copy.terms.noShows, align: "end", direction: "ltr" },
    { key: "patients", label: copy.terms.patients, align: "end", direction: "ltr" },
    { key: "revenue", label: copy.terms.revenue, align: "end", direction: "ltr" },
    { key: "completion", label: copy.terms.completionRate, align: "end", direction: "ltr" },
    { key: "cancellation", label: copy.terms.cancellationShort, align: "end", direction: "ltr" },
    { key: "deptShare", label: copy.terms.departmentRevenueShare, align: "end", direction: "ltr" },
  ];
  return (
    <>
      <StatCardRow items={[
        { label: copy.terms.doctors, value: f.number(data.doctors.length) },
        { label: copy.terms.sessions, value: f.number(sessions) },
        { label: copy.terms.completed, value: f.number(completed) },
        { label: copy.terms.totalRevenue, value: f.money(revenue) },
      ]} />
      <SectionHeader title={copy.sectionTitle} />
      <DataTable
        columns={columns}
        rows={data.doctors.map((row) => ({ id: row.doctorId, cells: {
          doctor: row.doctorName,
          sessions: f.number(row.sessions),
          completed: f.number(row.completed),
          cancelled: f.number(row.cancelled),
          noShow: f.number(row.noShow),
          patients: f.number(row.uniquePatients),
          revenue: f.money(row.revenue),
          completion: f.percent(row.completionRate),
          cancellation: f.percent(row.cancellationRate),
          deptShare: f.percent(row.deptRevenueShare),
        } }))}
        emptyLabel={copy.empty}
      />
      <NotesCallout label={copy.terms.departmentImpact}>
        <p>{copy.notesBody}</p>
        {impact && (
          <p>
            {copy.terms.clinicPatientContribution}: {f.percent(impact.clinicPatientShare)} ·{" "}
            {copy.terms.clinicRevenueContribution}: {f.percent(impact.clinicRevenueShare)} ·{" "}
            {copy.terms.departmentRevenueContribution}: {f.percent(impact.deptRevenueShare)}
          </p>
        )}
      </NotesCallout>
    </>
  );
}

function ReceptionistPerformanceBody({ data, copy, f }: {
  data: SnapshotData<"receptionist-performance">;
  copy: AnalyticalReportCopy;
  f: Formatters;
}) {
  const booked = data.receptionists.reduce((sum, row) => sum + row.appointmentsBooked, 0);
  const handled = data.receptionists.reduce((sum, row) => sum + row.followupsHandled, 0);
  const columns: readonly DocumentTableColumn[] = [
    { key: "receptionist", label: copy.terms.receptionists, width: "28%" },
    { key: "booked", label: copy.terms.appointmentsBooked, align: "end", direction: "ltr" },
    { key: "appointmentShare", label: copy.terms.appointmentShare, align: "end", direction: "ltr" },
    { key: "handled", label: copy.terms.followupsHandled, align: "end", direction: "ltr" },
    { key: "followupShare", label: copy.terms.followupShare, align: "end", direction: "ltr" },
  ];
  return (
    <>
      <SectionHeader title={copy.sectionTitle} />
      <NotesCallout label={copy.notesTitle}><p>{copy.description}</p></NotesCallout>
      <StatCardRow items={[
        { label: copy.terms.receptionists, value: f.number(data.receptionists.length) },
        { label: copy.terms.appointmentsBooked, value: f.number(booked) },
        { label: copy.terms.followupsHandled, value: f.number(handled) },
      ]} />
      <DataTable
        columns={columns}
        rows={data.receptionists.map((row) => ({ id: row.id, cells: {
          receptionist: row.name,
          booked: f.number(row.appointmentsBooked),
          appointmentShare: f.percent(row.appointmentShare),
          handled: f.number(row.followupsHandled),
          followupShare: f.percent(row.followupShare),
        } }))}
        totals={{
          receptionist: copy.terms.total,
          booked: f.number(booked),
          appointmentShare: f.percent(data.receptionists.length ? 100 : 0),
          handled: f.number(handled),
          followupShare: f.percent(data.receptionists.length ? 100 : 0),
        }}
        emptyLabel={copy.empty}
      />
    </>
  );
}

export function FollowUpPageReportTemplate(props: AnalyticalReportDocumentProps): ReactNode {
  return <AnalyticalReportDocument {...props} />;
}
export function CancellationReportTemplate(props: AnalyticalReportDocumentProps): ReactNode {
  return <AnalyticalReportDocument {...props} />;
}
export function NoShowReportTemplate(props: AnalyticalReportDocumentProps): ReactNode {
  return <AnalyticalReportDocument {...props} />;
}
export function SalesReportTemplate(props: AnalyticalReportDocumentProps): ReactNode {
  return <AnalyticalReportDocument {...props} />;
}
export function FollowUpAnalyticsReportTemplate(props: AnalyticalReportDocumentProps): ReactNode {
  return <AnalyticalReportDocument {...props} />;
}
export function DoctorPerformanceReportTemplate(props: AnalyticalReportDocumentProps): ReactNode {
  return <AnalyticalReportDocument {...props} />;
}
export function ReceptionistPerformanceReportTemplate(props: AnalyticalReportDocumentProps): ReactNode {
  return <AnalyticalReportDocument {...props} />;
}
