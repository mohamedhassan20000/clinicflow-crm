import { PageHeader } from "@/components/shared/page-header";
import { useTranslations } from "next-intl";

export function ReportPageHeader({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  const t = useTranslations("reports");
  return (
    <PageHeader
      back={{ href: "/reports", label: "reports" }}
      breadcrumbs={[{ label: t("reports"), href: "/reports" }, { label: title }]}
      title={title}
      description={description}
      className="print:hidden"
    />
  );
}
