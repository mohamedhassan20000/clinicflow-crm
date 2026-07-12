import { NextResponse } from "next/server";
import { operatorReportRegistry } from "@/lib/operator-reports/registry";

export async function GET(_request: Request, { params }: { params: Promise<{ reportId: string }> }) {
  const report = operatorReportRegistry.get((await params).reportId);
  if (!report) return new NextResponse("Not found", { status: 404 });
  const rows = await report.query();
  return new NextResponse(report.export(rows), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${report.id}.csv"`, "cache-control": "private, no-store" } });
}
