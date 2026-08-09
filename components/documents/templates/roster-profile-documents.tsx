import { DocumentPage, type DocumentLifecycle, type DocumentRenderContextBoundary } from "@/components/documents/engine";
import {
  AvatarName, DataTable, FieldGrid, GroupedTables, IdentityHero, NotesCallout, SectionHeader,
  SignatureBlock, StatusBadge, TotalsSummary, VerificationBlock,
  type DocumentTableColumn, type DocumentTableGroup,
} from "@/components/documents/primitives";
import { formatDocDate, formatDocNumber, formatDocTime } from "@/lib/documents/format";
import type { RosterProfileCopy } from "@/lib/documents/roster-profile-copy";
import type { RosterProfileDocumentSnapshot } from "@/lib/documents/resolvers/roster-profile";
import type { Locale } from "@/lib/i18n/config";

export function RosterProfileDocument({
  locale, lifecycle, snapshot, copy, documentNumber, qrDataUrl, renderContextBoundary,
}: {
  locale: Locale;
  lifecycle: DocumentLifecycle;
  snapshot: RosterProfileDocumentSnapshot;
  copy: RosterProfileCopy;
  documentNumber?: string | null;
  qrDataUrl?: string | null;
  renderContextBoundary?: DocumentRenderContextBoundary;
}) {
  const formatLocale = { locale, timeZone: snapshot.format.timeZone, timeFormat: snapshot.format.timeFormat };
  const date = (value: string) => formatDocDate(value, formatLocale, { dateStyle: "medium" });
  const time = (value: string) => formatDocTime(value, formatLocale);
  const number = (value: number) => formatDocNumber(value, formatLocale);
  const scope = snapshot.data.kind === "patient-list" ? copy.patientsCount(snapshot.data.rows.length)
    : snapshot.data.kind === "system-members" ? copy.membersCount(snapshot.data.rows.length) : undefined;
  const verification = lifecycle !== "preview" && snapshot.settings.qrEnabled && qrDataUrl ? (
    <VerificationBlock qrDataUrl={qrDataUrl} title={copy.verificationTitle}
      caption={copy.verificationCaption} verificationKey={documentNumber} />
  ) : null;

  return (
    <DocumentPage locale={locale} lifecycle={lifecycle} branding={snapshot.branding}
      identity={{ title: copy.title, documentNumber: lifecycle !== "preview" ? documentNumber : null,
        issueDate: date(snapshot.generatedAt), issueTime: time(snapshot.generatedAt), period: scope, labels: copy.labels }}
      watermark={{ enabled: lifecycle !== "preview" && snapshot.settings.watermark !== null,
        text: snapshot.settings.watermark }}
      footer={{ attribution: snapshot.branding.footerText || copy.footerAttribution, copyright: copy.copyright }}
      pageLabels={{ page: copy.page, of: copy.of }}
      renderContextBoundary={renderContextBoundary}>
      {snapshot.data.kind === "patient-list" && (
        <PatientListBody snapshot={snapshot as SnapshotOf<"patient-list">} copy={copy} verification={verification} />
      )}
      {snapshot.data.kind === "patient-file" && (
        <PatientFileBody snapshot={snapshot as SnapshotOf<"patient-file">} copy={copy} date={date} number={number} verification={verification} />
      )}
      {snapshot.data.kind === "system-members" && (
        <SystemMembersBody snapshot={snapshot as SnapshotOf<"system-members">} copy={copy} date={date} verification={verification} />
      )}
      {snapshot.data.kind === "staff-file" && (
        <StaffFileBody snapshot={snapshot as SnapshotOf<"staff-file">} copy={copy} date={date} number={number} verification={verification} />
      )}
    </DocumentPage>
  );
}

type SnapshotOf<K extends RosterProfileDocumentSnapshot["data"]["kind"]> =
  RosterProfileDocumentSnapshot & { data: Extract<RosterProfileDocumentSnapshot["data"], { kind: K }> };

function PatientListBody({ snapshot, copy, verification }: {
  snapshot: SnapshotOf<"patient-list">; copy: RosterProfileCopy; verification: React.ReactNode;
}) {
  const columns: readonly DocumentTableColumn[] = [
    { key: "patient", label: copy.patient, width: "20%" },
    { key: "file", label: copy.fileNumber, width: "13%", direction: "ltr" },
    { key: "nationalId", label: copy.nationalId, width: "17%", direction: "ltr" },
    { key: "doctor", label: copy.doctor, width: "20%" },
    { key: "phone", label: copy.phone, width: "18%", direction: "ltr" },
    { key: "blood", label: copy.bloodType, width: "12%", direction: "ltr", align: "center" },
  ];
  const grouped = new Map<string, typeof snapshot.data.rows>();
  for (const row of snapshot.data.rows) {
    const list = grouped.get(row.departmentName) ?? [];
    list.push(row); grouped.set(row.departmentName, list);
  }
  const groups: DocumentTableGroup[] = Array.from(grouped, ([title, rows]) => ({
    id: rows[0]?.departmentId ?? title, title, countLabel: copy.patientsCount(rows.length),
    rows: rows.map((row) => ({ id: row.id, cells: {
      patient: <AvatarName name={row.fullName} imageSrc={row.imageSrc} />, file: row.fileNumber,
      nationalId: row.nationalId, doctor: row.doctorName, phone: row.phone,
      blood: <StatusBadge label={row.bloodType} tone="neutral" /> } })),
  }));
  if (groups.length === 0) groups.push({ id: "empty", title: copy.allDepartments, rows: [] });
  return <>
    <GroupedTables columns={columns} groups={groups} emptyLabel={copy.noRows} />
    {verification}
    <SignatureBlock signatures={[
      { id: "authorized", label: copy.authorizedSignature },
      { id: "medical-director", label: copy.medicalDirector },
    ]} />
  </>;
}

function PatientFileBody({ snapshot, copy, date, number, verification }: {
  snapshot: SnapshotOf<"patient-file">; copy: RosterProfileCopy;
  date: (value: string) => string; number: (value: number) => string; verification: React.ReactNode;
}) {
  const patient = snapshot.data;
  const today = new Date(snapshot.generatedAt);
  const birth = new Date(`${patient.dateOfBirth}T00:00:00Z`);
  let age = today.getUTCFullYear() - birth.getUTCFullYear();
  if (today.getUTCMonth() < birth.getUTCMonth()
    || (today.getUTCMonth() === birth.getUTCMonth() && today.getUTCDate() < birth.getUTCDate())) age--;
  return <>
    <IdentityHero name={patient.fullName} identifier={patient.fileNumber}
      detail={`${copy.registeredSince}: ${date(patient.createdAt)}`} initials={patient.initials}
      imageSrc={patient.imageSrc} imageBackgroundSrc={patient.imageBackgroundSrc}
      imagePresentation="background-fill"
      status={<StatusBadge label={patient.isActive ? copy.active : copy.inactive}
        tone={patient.isActive ? "success" : "neutral"} />} />
    <SectionHeader title={copy.personalDetails} />
    <FieldGrid columns={2} items={[
      { label: copy.fileNumber, value: patient.fileNumber, direction: "ltr" },
      { label: copy.nationalId, value: patient.nationalId, direction: "ltr" },
      { label: copy.dateOfBirth, value: date(patient.dateOfBirth), direction: "ltr" },
      { label: copy.age, value: number(Math.max(0, age)), direction: "ltr" },
      { label: copy.phone, value: patient.phone, direction: "ltr" },
      { label: copy.email, value: patient.email, direction: "ltr" },
      { label: copy.department, value: patient.departmentName },
      { label: copy.doctor, value: patient.doctorName },
      { label: copy.insurance, value: patient.insuranceName },
      { label: copy.bloodType, value: <StatusBadge label={patient.bloodType} tone="neutral" /> },
      { label: copy.status, value: <StatusBadge label={patient.isActive ? copy.active : copy.inactive}
        tone={patient.isActive ? "success" : "neutral"} /> },
    ]} />
    {verification}
    <SignatureBlock signatures={[
      { id: "authorized", label: copy.authorizedSignature },
      { id: "medical-director", label: copy.medicalDirector },
    ]} stampLabel={copy.stamp} />
  </>;
}

function SystemMembersBody({ snapshot, copy, date, verification }: {
  snapshot: SnapshotOf<"system-members">; copy: RosterProfileCopy;
  date: (value: string) => string; verification: React.ReactNode;
}) {
  const columns: readonly DocumentTableColumn[] = [
    { key: "member", label: copy.member, width: "33%" },
    { key: "department", label: copy.department, width: "24%" },
    { key: "role", label: copy.role, width: "18%" },
    { key: "joined", label: copy.joined, width: "15%", direction: "ltr" },
    { key: "status", label: copy.status, width: "10%", align: "center" },
  ];
  const grouped = new Map<string, typeof snapshot.data.rows>();
  for (const row of snapshot.data.rows) {
    const list = grouped.get(row.departmentName) ?? [];
    list.push(row); grouped.set(row.departmentName, list);
  }
  const groups: DocumentTableGroup[] = Array.from(grouped, ([title, rows]) => ({
    id: rows[0]?.departmentId ?? title, title, countLabel: copy.membersCount(rows.length),
    rows: rows.map((row) => ({ id: row.id, cells: {
      member: <AvatarName name={row.fullName} imageSrc={row.imageSrc} detail={row.initials} />,
      department: row.departmentName, role: copy.roleLabel(row.role), joined: date(row.joinedAt),
      status: <StatusBadge label={row.isActive ? copy.active : copy.inactive}
        tone={row.isActive ? "success" : "neutral"} />,
    } })),
  }));
  if (groups.length === 0) groups.push({ id: "empty", title: copy.allDepartments, rows: [] });
  return <>
    <FieldGrid columns={3} items={[
      { label: copy.member, value: copy.membersCount(snapshot.data.rows.length) },
      { label: copy.department, value: snapshot.filters.departmentId && groups.length === 1
        ? groups[0].title : copy.allDepartments },
      { label: copy.status, value: <StatusBadge label={copy.active} tone="success" /> },
    ]} />
    <GroupedTables columns={columns} groups={groups} emptyLabel={copy.noRows} />
    <NotesCallout label={copy.administrativeNotes} tone="neutral">
      <p>{copy.staffNote}</p>
    </NotesCallout>
    {verification}
  </>;
}

function StaffFileBody({ snapshot, copy, date, number, verification }: {
  snapshot: SnapshotOf<"staff-file">; copy: RosterProfileCopy;
  date: (value: string) => string; number: (value: number) => string; verification: React.ReactNode;
}) {
  const staff = snapshot.data;
  const scheduleByDay = new Map(staff.schedule.map((row) => [row.dayOfWeek, row]));
  const scheduleRows = Array.from({ length: 7 }, (_, day) => {
    const schedule = scheduleByDay.get(day);
    let minutes = 0;
    if (schedule?.enabled) {
      const [startHour, startMinute] = schedule.startTime.split(":").map(Number);
      const [endHour, endMinute] = schedule.endTime.split(":").map(Number);
      minutes = Math.max(0, endHour * 60 + endMinute - startHour * 60 - startMinute);
    }
    return { minutes, row: { id: String(day), cells: {
      day: copy.dayName(day),
      status: <StatusBadge label={schedule?.enabled ? copy.scheduled : copy.unavailable}
        tone={schedule?.enabled ? "success" : "neutral"} />,
      start: schedule?.enabled ? schedule.startTime.slice(0, 5) : "—",
      end: schedule?.enabled ? schedule.endTime.slice(0, 5) : "—",
      duration: schedule?.enabled ? copy.hours(number(minutes / 60)) : "—",
    } } };
  });
  const totalMinutes = scheduleRows.reduce((sum, item) => sum + item.minutes, 0);
  const rows = scheduleRows.map((item) => item.row);
  return <>
    <SectionHeader title={copy.employmentDetails} />
    <IdentityHero name={staff.fullName} identifier={staff.id}
      detail={`${copy.role}: ${copy.roleLabel(staff.role)} · ${copy.department}: ${staff.departmentName}`}
      initials={staff.initials} imageSrc={staff.imageSrc}
      status={<StatusBadge label={staff.isActive ? copy.active : copy.inactive}
        tone={staff.isActive ? "success" : "neutral"} />} />
    <FieldGrid columns={2} items={[
      { label: copy.member, value: staff.fullName }, { label: copy.role, value: copy.roleLabel(staff.role) },
      { label: copy.department, value: staff.departmentName },
      { label: copy.phone, value: staff.phone, direction: "ltr" },
      { label: copy.joined, value: date(staff.joinedAt), direction: "ltr" },
      { label: copy.status, value: <StatusBadge label={staff.isActive ? copy.active : copy.inactive}
        tone={staff.isActive ? "success" : "neutral"} /> },
      { label: copy.verificationCode, value: staff.id, direction: "ltr" },
    ]} />
    <DataTable columns={[
      { key: "day", label: copy.day }, { key: "status", label: copy.status, align: "center" },
      { key: "start", label: copy.start, direction: "ltr", align: "center" },
      { key: "end", label: copy.end, direction: "ltr", align: "center" },
      { key: "duration", label: copy.duration, direction: "ltr", align: "end" },
    ]} rows={rows} emptyLabel={copy.noRows} />
    <TotalsSummary items={[{ label: copy.totalWeeklyHours, value: copy.hours(number(totalMinutes / 60)), emphasis: "strong" }]} />
    <NotesCallout label={copy.administrativeNotes}><p>{copy.staffNote}</p></NotesCallout>
    <SignatureBlock signatures={[
      { id: "employee", label: copy.employeeSignature },
      { id: "authorized", label: copy.authorizedSignature },
    ]} stampLabel={copy.stamp} />
    {verification}
  </>;
}
