import { NextResponse } from "next/server";
import { operatorReportRegistry } from "@/lib/operator-reports/registry";
import { parseReportParams, REPORT_EXPORT_LIMIT } from "@/lib/operator-reports/types";

export async function GET(request: Request, { params }: { params: Promise<{ reportId: string }> }) {
  const report = operatorReportRegistry.get((await params).reportId);
  if (!report) return new NextResponse("Not found", { status: 404 });
  const url = new URL(request.url);
  const raw = Object.fromEntries(url.searchParams.entries());
  const parsed = parseReportParams(report, raw);
  const result = await report.query(parsed, "export");
  const csv = report.export(result.rows);
  const encoder = new TextEncoder();
  const chunkSize = 64 * 1024;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < csv.length; offset += chunkSize) {
        controller.enqueue(encoder.encode(csv.slice(offset, offset + chunkSize)));
      }
      controller.close();
    },
  });
  return new NextResponse(stream, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${report.id}.csv"`,
      "cache-control": "private, no-store",
      "x-report-export-limit": String(REPORT_EXPORT_LIMIT),
      "x-report-export-truncated": result.sourceTruncated ? "true" : "false",
    },
  });
}
