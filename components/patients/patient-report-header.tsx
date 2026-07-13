import { FileText } from "lucide-react";
import { PageHeader } from "@/components/shared/page-header";
import { PrintButton } from "@/components/patients/print-button";

export function PatientReportHeader({
  patientHref,
  patientName,
  fileNumber,
  phone,
  title,
  countLabel,
}: {
  patientHref: string;
  patientName: string;
  fileNumber: string | null;
  phone: string | null;
  title: string;
  countLabel: string;
}) {
  return (
    <PageHeader
      back={{ href: patientHref, label: "patient" }}
      breadcrumbs={[
        { label: "Patients", href: "/patients" },
        { label: patientName, href: patientHref },
        { label: title },
      ]}
      leading={<FileText className="mt-1 size-6 text-muted-foreground print:hidden" aria-hidden="true" />}
      title={title}
      description={
        <div className="space-y-0.5">
          <p className="text-base font-medium text-foreground">{patientName}</p>
          {fileNumber ? <p>File: <span className="font-mono">{fileNumber}</span></p> : null}
          {phone ? <p>Phone: {phone}</p> : null}
          <p>{countLabel}</p>
        </div>
      }
      actions={<PrintButton />}
    />
  );
}
