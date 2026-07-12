import Link from "next/link";
import { operatorReports } from "@/lib/operator-reports/registry";

export default function OperatorReportsPage() {
  return <><header><p className="text-sm font-medium text-primary">Platform intelligence</p><h1 className="text-3xl font-bold tracking-tight">Reports</h1><p className="mt-1 text-muted-foreground">A shared, extensible reporting surface over platform metadata only.</p></header><section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{operatorReports.map((report) => <Link key={report.id} href={`/operator/reports/${report.id}`} className="group rounded-2xl border bg-card p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"><h2 className="font-semibold group-hover:text-primary">{report.title}</h2><p className="mt-2 text-sm text-muted-foreground">{report.description}</p></Link>)}</section></>;
}
