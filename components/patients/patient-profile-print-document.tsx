import { formatDoctorName } from "@/lib/format-doctor";

type BillingTotals = {
  billed: number;
  collected: number;
  outstanding: number;
  accountBalance: number;
};

type AppointmentPrintItem = {
  id: string;
  scheduledAt: string;
  status: string;
  departmentName: string | null;
  doctorName: string | null;
  totalAmount: number | null;
  outstandingAmount: number | null;
};

interface PatientProfilePrintDocumentProps {
  avatarUrl: string | null;
  fullName: string;
  initials: string;
  fileNumber: string | null;
  nationalId: string | null;
  phone: string | null;
  email: string | null;
  dateOfBirth: string | null;
  age: number | null;
  bloodType: string | null;
  departmentName: string | null;
  treatingDoctorName: string | null;
  insuranceName: string | null;
  registrationDate: string | null;
  billingTotals: BillingTotals;
  canViewBilling: boolean;
  appointments: AppointmentPrintItem[];
  generatedAt: Date;
}

export function PatientProfilePrintDocument({
  avatarUrl,
  fullName,
  initials,
  fileNumber,
  nationalId,
  phone,
  email,
  dateOfBirth,
  age,
  bloodType,
  departmentName,
  treatingDoctorName,
  insuranceName,
  registrationDate,
  billingTotals,
  canViewBilling,
  appointments,
  generatedAt,
}: PatientProfilePrintDocumentProps) {
  const completedCount = appointments.filter((item) => item.status === "completed").length;
  const upcomingCount = appointments.filter((item) => {
    const scheduled = new Date(item.scheduledAt).getTime();
    return Number.isFinite(scheduled) && scheduled > generatedAt.getTime();
  }).length;
  const recentAppointments = appointments.slice(0, 8);

  return (
    <article
      className="hidden print:hidden"
      data-patient-profile-print-document
      aria-label="Patient profile print document"
    >
      <header className="border-b border-slate-900 pb-5">
        <div className="flex items-start justify-between gap-8">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-sm border border-slate-900 text-sm font-bold text-slate-900">
                CF
              </div>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-700">
                  ClinicFlow Medical Center
                </p>
                <p className="text-[10px] text-slate-500">
                  Patient profile report
                </p>
              </div>
            </div>
            <h1 className="mt-5 text-[28px] font-semibold leading-tight text-slate-950">
              {fullName}
            </h1>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-slate-700">
              <span className="rounded-sm border border-slate-900 bg-slate-100 px-2 py-1 font-mono text-sm font-semibold text-slate-950">
                {empty(fileNumber)}
              </span>
              <span>Registered {formatDate(registrationDate)}</span>
              <span aria-hidden>·</span>
              <span>Generated {formatDateTime(generatedAt.toISOString())}</span>
            </div>
          </div>

          <div className="shrink-0 text-right">
            <div className="ml-auto flex h-32 w-28 items-center justify-center overflow-hidden rounded-sm border border-slate-900 bg-white text-lg font-semibold text-slate-900">
              {avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={avatarUrl}
                  alt={`${fullName} patient photo`}
                  className="h-full w-full object-cover"
                  data-patient-profile-print-photo
                />
              ) : (
                <span>{initials || "PT"}</span>
              )}
            </div>
            <p className="mt-2 text-[10px] uppercase tracking-[0.14em] text-slate-500">
              Patient photo
            </p>
          </div>
        </div>
      </header>

      <section className="mt-5 grid grid-cols-[1.05fr_0.95fr] gap-4">
        <PrintPanel title="Patient Identity">
          <PrintField label="Full name" value={fullName} />
          <PrintField label="File number" value={fileNumber} mono />
          <PrintField label="National ID" value={nationalId} mono />
          <PrintField label="Birth date" value={formatDate(dateOfBirth)} />
          <PrintField label="Age" value={age === null ? null : `${age} years`} />
          <PrintField label="Blood type" value={bloodType} />
        </PrintPanel>

        <PrintPanel title="Care & Contact">
          <PrintField label="Phone" value={phone} />
          <PrintField label="Email" value={email} />
          <PrintField label="Department" value={departmentName ?? "Unassigned"} />
          <PrintField
            label="Treating doctor"
            value={
              treatingDoctorName
                ? formatDoctorName(treatingDoctorName)
                : "Unassigned"
            }
          />
          <PrintField label="Insurance" value={insuranceName ?? "No insurance"} />
          <PrintField label="Registered" value={formatDate(registrationDate)} />
        </PrintPanel>
      </section>

      <section className="mt-5">
        <SectionHeading
          title="Billing Summary"
          subtitle={canViewBilling ? "Current patient financial overview" : "Restricted"}
        />
        {canViewBilling ? (
          <div className="mt-3 grid grid-cols-4 overflow-hidden rounded-sm border border-slate-900">
            <SummaryBox label="Billed" value={fmtTRY(billingTotals.billed)} />
            <SummaryBox label="Collected" value={fmtTRY(billingTotals.collected)} />
            <SummaryBox label="Outstanding" value={fmtTRY(billingTotals.outstanding)} />
            <SummaryBox label="Account balance" value={fmtTRY(billingTotals.accountBalance)} />
          </div>
        ) : (
          <p className="mt-3 rounded-sm border border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-700">
            Billing summary is restricted for this user role.
          </p>
        )}
      </section>

      <section className="mt-5">
        <SectionHeading
          title="Appointments Summary"
          subtitle={`${appointments.length} total · ${completedCount} completed · ${upcomingCount} upcoming`}
        />

        {recentAppointments.length > 0 ? (
          <table className="mt-3 w-full border-collapse text-[10.5px] text-slate-950">
            <thead>
              <tr>
                <PrintTh>Date</PrintTh>
                <PrintTh>Status</PrintTh>
                <PrintTh>Department</PrintTh>
                <PrintTh>Doctor</PrintTh>
                <PrintTh align="right">Total</PrintTh>
                <PrintTh align="right">Outstanding</PrintTh>
              </tr>
            </thead>
            <tbody>
              {recentAppointments.map((item) => (
                <tr key={item.id}>
                  <PrintTd>{formatDateTime(item.scheduledAt)}</PrintTd>
                  <PrintTd className="capitalize">
                    {item.status.replaceAll("_", " ")}
                  </PrintTd>
                  <PrintTd>{empty(item.departmentName)}</PrintTd>
                  <PrintTd>
                    {item.doctorName ? formatDoctorName(item.doctorName) : "Unassigned"}
                  </PrintTd>
                  <PrintTd align="right">
                    {item.totalAmount === null ? "-" : fmtTRY(item.totalAmount)}
                  </PrintTd>
                  <PrintTd align="right">
                    {item.outstandingAmount === null
                      ? "-"
                      : fmtTRY(item.outstandingAmount)}
                  </PrintTd>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="mt-3 rounded-sm border border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-700">
            No appointments recorded.
          </p>
        )}
      </section>

      <footer className="mt-6 flex items-center justify-between border-t border-slate-300 pt-3 text-[9px] text-slate-500">
        <span>ClinicFlow Medical Center · Confidential patient document</span>
        <span>Generated {formatDateTime(generatedAt.toISOString())}</span>
      </footer>
    </article>
  );
}

function SectionHeading({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="flex items-end justify-between gap-4 border-b border-slate-300 pb-1.5">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-950">
        {title}
      </h2>
      <p className="text-[10px] text-slate-500">{subtitle}</p>
    </div>
  );
}

function PrintPanel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-sm border border-slate-300">
      <h2 className="border-b border-slate-300 bg-slate-100 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-950">
        {title}
      </h2>
      <dl>{children}</dl>
    </section>
  );
}

function PrintField({
  label,
  value,
  mono,
}: {
  label: string;
  value: string | number | null | undefined;
  mono?: boolean;
}) {
  return (
    <div className="grid grid-cols-[38%_1fr] border-b border-slate-200 text-[11px] last:border-b-0">
      <dt className="bg-slate-50 px-3 py-2 font-medium text-slate-600">
        {label}
      </dt>
      <dd className={`px-3 py-2 text-slate-950 ${mono ? "font-mono" : ""}`}>
        {empty(value)}
      </dd>
    </div>
  );
}

function SummaryBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-r border-slate-300 bg-white px-3 py-3 last:border-r-0">
      <p className="text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-500">
        {label}
      </p>
      <p className="mt-1 text-sm font-semibold tabular-nums text-slate-950">
        {value}
      </p>
    </div>
  );
}

function PrintTh({
  children,
  align = "left",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th
      className={`border border-slate-300 bg-slate-100 px-2 py-1.5 font-semibold uppercase tracking-[0.06em] text-slate-700 ${
        align === "right" ? "text-right" : "text-left"
      }`}
    >
      {children}
    </th>
  );
}

function PrintTd({
  children,
  align = "left",
  className = "",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
  className?: string;
}) {
  return (
    <td
      className={`border border-slate-300 px-2 py-1.5 align-top ${
        align === "right" ? "text-right tabular-nums" : "text-left"
      } ${className}`}
    >
      {children}
    </td>
  );
}

function empty(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === "") return "-";
  return value;
}

function formatDate(value: string | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleDateString("en-GB", {
    timeZone: "Europe/Istanbul",
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("en-GB", {
    timeZone: "Europe/Istanbul",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function fmtTRY(n: number) {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "TRY",
    maximumFractionDigits: 2,
  }).format(Number.isFinite(n) ? n : 0);
}
