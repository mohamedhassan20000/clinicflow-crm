import { DocumentPage, type DocumentLifecycle, type DocumentRenderContextBoundary } from "@/components/documents/engine";
import { CertifyingProse, ChecklistPanel, DataTable, FieldGrid, IdentityHero,
  NotesCallout, SectionHeader, SignatureBlock, VerificationBlock } from "@/components/documents/primitives";
import type { ClinicalDocumentCopy } from "@/lib/documents/clinical-copy";
import { formatDocDate, formatDocNumber, formatDocTime } from "@/lib/documents/format";
import type { ClinicalDocumentSnapshot } from "@/lib/documents/resolvers/clinical-document";
import type { Locale } from "@/lib/i18n/config";

export function ClinicalDocument({ locale, lifecycle, snapshot, copy, documentNumber, qrDataUrl,
  renderContextBoundary }: {
  locale: Locale; lifecycle: DocumentLifecycle; snapshot: ClinicalDocumentSnapshot;
  copy: ClinicalDocumentCopy; documentNumber?: string | null; qrDataUrl?: string | null;
  renderContextBoundary?: DocumentRenderContextBoundary;
}) {
  const format = { locale, timeZone: snapshot.format.timeZone, timeFormat: snapshot.format.timeFormat };
  const date = (value: string) => formatDocDate(value, format, { dateStyle: "medium" });
  const verification = lifecycle !== "preview" && snapshot.settings.qrEnabled && qrDataUrl
    ? <VerificationBlock qrDataUrl={qrDataUrl} title={copy.verificationTitle}
      caption={copy.verificationCaption} verificationKey={documentNumber} />
    : null;
  const signature = <SignatureBlock signatures={[{ id: snapshot.physician.id,
    label: copy.physicianSignature, imageSrc: snapshot.physician.signatureSrc,
    emptyLabel: snapshot.physician.signatureSrc ? undefined : copy.manualSignature }]}
    stampLabel={snapshot.data.kind === "prescription" ? copy.clinicApprovalStamp : copy.stamp} />;
  const validUntil = snapshot.data.kind === "prescription" && snapshot.data.validUntil
    ? date(snapshot.data.validUntil) : undefined;
  return <DocumentPage locale={locale} lifecycle={lifecycle} branding={snapshot.branding}
    identity={{ title: copy.title, documentNumber: lifecycle !== "preview" ? documentNumber : null,
      issueDate: date(snapshot.generatedAt), issueTime: formatDocTime(snapshot.generatedAt, format),
      period: validUntil, labels: copy.labels }}
    watermark={{ enabled: lifecycle !== "preview" && snapshot.settings.watermark !== null,
      text: snapshot.settings.watermark }}
    footer={{ attribution: snapshot.branding.footerText || copy.footerAttribution, copyright: copy.copyright }}
    pageLabels={{ page: copy.page, of: copy.of }}
    renderContextBoundary={renderContextBoundary}>
    {/* Clinical documents are not a patient file: the identity block stays on
        the initials avatar and never carries the patient photo. */}
    <IdentityHero name={snapshot.subject.fullName}
      identifier={snapshot.subject.fileNumber}
      initials={snapshot.subject.fullName.slice(0, 1).toUpperCase() || "—"} />
    <FieldGrid columns={2} items={identityFields(snapshot, copy, date)} />
    {snapshot.data.kind === "prescription" && <PrescriptionBody data={snapshot.data} copy={copy} verification={verification} signature={signature} />}
    {snapshot.data.kind === "lab-request" && <LabBody data={snapshot.data} copy={copy} verification={verification} signature={signature} />}
    {snapshot.data.kind === "sick-leave" && <SickLeaveBody snapshot={snapshot} data={snapshot.data} copy={copy} date={date} verification={verification} signature={signature} />}
  </DocumentPage>;
}

function identityFields(snapshot: ClinicalDocumentSnapshot, copy: ClinicalDocumentCopy, date: (v: string) => string) {
  return [
    { label: copy.patientName, value: snapshot.subject.fullName },
    { label: copy.fileNumber, value: snapshot.subject.fileNumber, direction: "ltr" as const },
    { label: copy.dateOfBirth, value: snapshot.subject.dateOfBirth ? date(snapshot.subject.dateOfBirth) : null, direction: "ltr" as const },
    { label: copy.nationalId, value: snapshot.subject.nationalId, direction: "ltr" as const },
    { label: copy.physicianName, value: snapshot.physician.fullName },
    { label: copy.professionalTitle, value: snapshot.physician.professionalTitle },
    { label: copy.specialty, value: snapshot.physician.specialty },
    { label: copy.department, value: snapshot.physician.departmentName },
    { label: copy.licenseNumber, value: snapshot.physician.professionalLicenseNo, direction: "ltr" as const },
    { label: copy.preparedBy, value: snapshot.data.createdBy.fullName },
    { label: copy.finalizedAt, value: snapshot.data.finalizedAt ? date(snapshot.data.finalizedAt) : null,
      direction: "ltr" as const },
  ];
}

function PrescriptionBody({ data, copy, verification, signature }: { data: Extract<ClinicalDocumentSnapshot["data"], { kind: "prescription" }>; copy: ClinicalDocumentCopy; verification: React.ReactNode; signature: React.ReactNode }) {
  return <><SectionHeader title={copy.medications} /><DataTable columns={[
    { key: "medication", label: copy.medication, width: "30%" }, { key: "dose", label: copy.dose },
    { key: "frequency", label: copy.frequency }, { key: "duration", label: copy.duration },
    { key: "route", label: copy.route }, { key: "quantity", label: copy.quantity },
  ]} rows={data.medications.map((item) => ({ id: item.id, cells: {
    medication: <><strong>{item.drugName}</strong>{item.instructions && <><br /><small>{item.instructions}</small></> } </>,
    dose: item.dose, frequency: item.frequency, duration: item.duration, route: item.route, quantity: item.quantity,
  } }))} emptyLabel={copy.noMedications} />
  <NotesCallout label={copy.prescriptionNotes}>{data.notes && <p>{data.notes}</p>}
    <p>{copy.controlledDisclaimer}</p><p>{copy.prescriptionValidity}</p>
  </NotesCallout>{verification}{signature}</>;
}

function LabBody({ data, copy, verification, signature }: { data: Extract<ClinicalDocumentSnapshot["data"], { kind: "lab-request" }>; copy: ClinicalDocumentCopy; verification: React.ReactNode; signature: React.ReactNode }) {
  const priority = data.priority === "stat" ? copy.stat : data.priority === "urgent" ? copy.urgent : copy.routine;
  return <><SectionHeader title={copy.requestedTests} /><FieldGrid columns={2} items={[
    { label: copy.priority, value: priority }, { label: copy.laboratory, value: data.laboratoryName },
  ]} /><ChecklistPanel groups={[{ title: copy.testGroup, items: data.tests.map((test) => ({
    id: test.id, label: test.notes ? `${test.testName} — ${test.notes}` : test.testName, checked: true })) }]} />
  <NotesCallout label={copy.requestInstructions}><p>{data.instructions || copy.noTests}</p></NotesCallout>
  {data.clinicalContext && <NotesCallout label={copy.clinicalContext}><p>{data.clinicalContext}</p></NotesCallout>}
  {verification}{signature}</>;
}

function SickLeaveBody({ snapshot, data, copy, date, verification, signature }: { snapshot: ClinicalDocumentSnapshot; data: Extract<ClinicalDocumentSnapshot["data"], { kind: "sick-leave" }>; copy: ClinicalDocumentCopy; date: (v: string) => string; verification: React.ReactNode; signature: React.ReactNode }) {
  const start = new Date(`${data.leaveStartDate}T00:00:00Z`);
  const end = new Date(`${data.leaveEndDate}T00:00:00Z`);
  const days = formatDocNumber(Math.max(1, Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1));
  return <><SectionHeader title={copy.certificateDetails} /><FieldGrid columns={2} items={[
    { label: copy.leaveStart, value: date(data.leaveStartDate), direction: "ltr" },
    { label: copy.leaveEnd, value: date(data.leaveEndDate), direction: "ltr" },
    { label: copy.returnDate, value: data.returnDate ? date(data.returnDate) : null, direction: "ltr" },
    { label: copy.recipient, value: data.recipientOrganization },
    { label: copy.recipientReference, value: data.recipientReference, direction: "ltr" },
  ]} /><CertifyingProse><p>{copy.certification(snapshot.subject.fullName, date(data.leaveStartDate), date(data.leaveEndDate), days)}</p></CertifyingProse>
  {data.restrictions && <NotesCallout label={copy.restrictions}><p>{data.restrictions}</p></NotesCallout>}
  {verification}{signature}</>;
}
