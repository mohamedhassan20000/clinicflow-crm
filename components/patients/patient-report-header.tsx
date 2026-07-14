import { FileText } from "lucide-react";
import { PageHeader } from "@/components/shared/page-header";
import { PrintButton } from "@/components/patients/print-button";
import { useTranslations } from "next-intl";

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
  const t = useTranslations("patients");
  return (
    <PageHeader
      back={{ href: patientHref, label: "patient" }}
      breadcrumbs={[
        { label: t("patients"), href: "/patients" },
        { label: patientName, href: patientHref },
        { label: title },
      ]}
      leading={<FileText className="mt-1 size-6 text-muted-foreground print:hidden" aria-hidden="true" />}
      title={title}
      description={
        <div className="space-y-0.5">
          <p className="text-base font-medium text-foreground">{patientName}</p>
          {fileNumber ? <p>{t("file")}<span className="font-mono">{fileNumber}</span></p> : null}
          {phone ? <p>{t("phone")}{phone}</p> : null}
          <p>{countLabel}</p>
        </div>
      }
      actions={<PrintButton />}
    />
  );
}
