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
  const recentAppointments = appointments.slice(0, 6);

  return (
    <article
      className="hidden print:hidden"
      data-patient-profile-print-document
      aria-label="Patient profile print document"
    >
      <header className="flex items-start justify-between gap-8 border-b-2 border-black pb-5">
        <div className="space-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-black">
            Patient Profile
          </p>
          <h1 className="text-3xl font-semibold tracking-normal text-black">
            {fullName}
          </h1>
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-black">
            <span>
              File No: <strong className="font-mono">{empty(fileNumber)}</strong>
            </span>
            <span>Registered: {formatDate(registrationDate)}</span>
            <span>Printed: {formatDateTime(generatedAt.toISOString())}</span>
          </div>
        </div>
        <div className="flex h-32 w-28 shrink-0 items-center justify-center overflow-hidden border border-black bg-white text-lg font-semibold text-black">
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
      </header>

      <section className="mt-5 grid grid-cols-2 gap-5">
        <PrintPanel title="Identity">
          <PrintField label="Full name" value={fullName} />
          <PrintField label="File number" value={fileNumber} mono />
          <PrintField label="National ID" value={nationalId} mono />
          <PrintField label="Date of birth" value={formatDate(dateOfBirth)} />
          <PrintField label="Age" value={age === null ? null : `${age} years`} />
          <PrintField label="Blood type" value={bloodType} />
        </PrintPanel>

        <PrintPanel title="Contact & Care">
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
          <PrintField label="Registration date" value={formatDate(registrationDate)} />
        </PrintPanel>
      </section>

      <section className="mt-5">
        <h2 className="border-b border-black pb-1 text-xs font-semibold uppercase tracking-[0.18em] text-black">
          Billing Summary
        </h2>
        {canViewBilling ? (
          <div className="mt-3 grid grid-cols-4 border border-black text-sm text-black">
            <SummaryBox label="Billed" value={fmtTRY(billingTotals.billed)} />
            <SummaryBox label="Collected" value={fmtTRY(billingTotals.collected)} />
            <SummaryBox label="Outstanding" value={fmtTRY(billingTotals.outstanding)} />
            <SummaryBox label="Account balance" value={fmtTRY(billingTotals.accountBalance)} />
          </div>
        ) : (
          <p className="mt-3 border border-black px-3 py-2 text-sm text-black">
            Billing summary is restricted for this user role.
          </p>
        )}
      </section>

      <section className="mt-5">
        <div className="flex items-end justify-between border-b border-black pb-1">
          <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-black">
            Appointments Summary
          </h2>
          <p className="text-xs text-black">
            {appointments.length} total / {completedCount} completed / {upcomingCount} upcoming
          </p>
        </div>

        {recentAppointments.length > 0 ? (
          <table className="mt-3 w-full border-collapse text-xs text-black">
            <thead>
              <tr>
                <th className="border border-black px-2 py-1.5 text-left font-semibold">
                  Date
                </th>
                <th className="border border-black px-2 py-1.5 text-left font-semibold">
                  Status
                </th>
                <th className="border border-black px-2 py-1.5 text-left font-semibold">
                  Department
                </th>
                <th className="border border-black px-2 py-1.5 text-left font-semibold">
                  Doctor
                </th>
                <th className="border border-black px-2 py-1.5 text-right font-semibold">
                  Total
                </th>
                <th className="border border-black px-2 py-1.5 text-right font-semibold">
                  Outstanding
                </th>
              </tr>
            </thead>
            <tbody>
              {recentAppointments.map((item) => (
                <tr key={item.id}>
                  <td className="border border-black px-2 py-1.5">
                    {formatDateTime(item.scheduledAt)}
                  </td>
                  <td className="border border-black px-2 py-1.5 capitalize">
                    {item.status.replaceAll("_", " ")}
                  </td>
                  <td className="border border-black px-2 py-1.5">
                    {empty(item.departmentName)}
                  </td>
                  <td className="border border-black px-2 py-1.5">
                    {item.doctorName ? formatDoctorName(item.doctorName) : "Unassigned"}
                  </td>
                  <td className="border border-black px-2 py-1.5 text-right tabular-nums">
                    {item.totalAmount === null ? "-" : fmtTRY(item.totalAmount)}
                  </td>
                  <td className="border border-black px-2 py-1.5 text-right tabular-nums">
                    {item.outstandingAmount === null
                      ? "-"
                      : fmtTRY(item.outstandingAmount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="mt-3 border border-black px-3 py-2 text-sm text-black">
            No appointments recorded.
          </p>
        )}
      </section>
    </article>
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
    <section className="border border-black">
      <h2 className="border-b border-black px-3 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-black">
        {title}
      </h2>
      <dl className="divide-y divide-black">{children}</dl>
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
    <div className="grid grid-cols-[42%_1fr] text-sm text-black">
      <dt className="border-r border-black px-3 py-2 font-medium">{label}</dt>
      <dd className={`px-3 py-2 ${mono ? "font-mono" : ""}`}>{empty(value)}</dd>
    </div>
  );
}

function SummaryBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-r border-black px-3 py-2 last:border-r-0">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em]">
        {label}
      </p>
      <p className="mt-1 text-base font-semibold tabular-nums">{value}</p>
    </div>
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
