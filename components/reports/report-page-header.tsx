import { PageHeader } from "@/components/shared/page-header";

export function ReportPageHeader({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <PageHeader
      back={{ href: "/reports", label: "reports" }}
      breadcrumbs={[{ label: "Reports", href: "/reports" }, { label: title }]}
      title={title}
      description={description}
      className="print:hidden"
    />
  );
}
