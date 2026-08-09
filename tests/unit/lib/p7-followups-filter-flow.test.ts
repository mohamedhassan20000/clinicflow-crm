import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildFollowupsDocumentHref,
  resolveFollowupsDateRange,
} from "@/lib/followups/filters";
import { analyticalDocumentParamsSchema } from "@/lib/documents/resolvers/analytical-report";

const NOW = new Date("2026-08-09T10:00:00.000Z");

describe("P7 Follow-ups filter and document flow", () => {
  it("filters a specific day from clinic-local start through inclusive end", () => {
    const range = resolveFollowupsDateRange({
      scope: "day",
      date: "2026-08-05",
    }, NOW);

    expect(range).toMatchObject({
      scope: "day",
      from: "2026-08-05",
      to: "2026-08-05",
    });
    expect(range.start.toISOString()).toBe("2026-08-04T21:00:00.000Z");
    expect(range.end.toISOString()).toBe("2026-08-05T20:59:59.999Z");
  });

  it("filters a custom From/To range inclusively", () => {
    const range = resolveFollowupsDateRange({
      scope: "custom",
      from: "2026-08-02",
      to: "2026-08-07",
    }, NOW);

    expect(range).toMatchObject({
      scope: "custom",
      from: "2026-08-02",
      to: "2026-08-07",
    });
    expect(range.start.toISOString()).toBe("2026-08-01T21:00:00.000Z");
    expect(range.end.toISOString()).toBe("2026-08-07T20:59:59.999Z");
  });

  it("removes direct Print and exposes Preview Document on the Follow-ups page", () => {
    const source = readFileSync(
      join(process.cwd(), "components/followups/followups-view.tsx"),
      "utf8",
    );

    expect(source).not.toContain("FollowupsPrintButton");
    expect(source).not.toContain("window.print()");
    expect(source).toContain("FollowupsPreviewDocumentButton");
    expect(source).toContain('t("previewDocument")');
  });

  it("propagates the exact date and every active filter to Preview", () => {
    const href = buildFollowupsDocumentHref({
      range: { from: "2026-08-02", to: "2026-08-07" },
      locale: "ar",
      filters: {
        doctorId: "11111111-1111-4111-8111-111111111111",
        departmentId: "22222222-2222-4222-8222-222222222222",
        outcome: "has_problem",
        patientQuery: "Ada",
        patientName: "Lovelace",
        patientFileNumber: "CF-0013",
        patientNationalId: "12345678901",
        patientPhone: "+90 555",
      },
    });
    const query = new URL(href, "https://clinicflow.test").searchParams;

    expect(Object.fromEntries(query)).toEqual({
      preset: "custom",
      from: "2026-08-02",
      to: "2026-08-07",
      locale: "ar",
      origin: "followups",
      doctor: "11111111-1111-4111-8111-111111111111",
      department: "22222222-2222-4222-8222-222222222222",
      outcome: "has_problem",
      q: "Ada",
      name: "Lovelace",
      file: "CF-0013",
      nat: "12345678901",
      phone: "+90 555",
    });
  });

  it("keeps those filters in the snapshot resolved for Preview, PDF, and Issue", () => {
    const parsed = analyticalDocumentParamsSchema.parse({
      documentType: "FOLLOW_UP_PAGE_REPORT",
      from: "2026-08-02",
      to: "2026-08-07",
      doctorId: "11111111-1111-4111-8111-111111111111",
      departmentId: "22222222-2222-4222-8222-222222222222",
      outcome: "has_problem",
      patientQuery: "Ada",
      patientName: "Lovelace",
      patientFileNumber: "CF-0013",
      patientNationalId: "12345678901",
      patientPhone: "+90 555",
    });
    expect(parsed).toMatchObject({
      from: "2026-08-02",
      to: "2026-08-07",
      outcome: "has_problem",
      patientQuery: "Ada",
      patientName: "Lovelace",
      patientFileNumber: "CF-0013",
      patientNationalId: "12345678901",
      patientPhone: "+90 555",
    });

    const actions = readFileSync(join(process.cwd(), "actions/documents.ts"), "utf8");
    const renderer = readFileSync(
      join(process.cwd(), "lib/documents/renderers/analytical-report.tsx"),
      "utf8",
    );
    expect(actions).toContain("resolveAnalyticalDocumentSnapshot(user, parsed.data");
    expect(actions).toContain("snapshot: snapshot as unknown as Json");
    expect(renderer).toContain("parseAnalyticalDocumentSnapshot(reservation.snapshot)");
    expect(renderer).toContain("snapshot={snapshot}");
  });

  it("preserves both English and Arabic locale links with the same Preview params", () => {
    const source = readFileSync(
      join(process.cwd(), "app/(protected)/reports/[report]/document/page.tsx"),
      "utf8",
    );
    expect(source).toContain('previewHref(report, previewParams, "en", previewOrigin');
    expect(source).toContain('previewHref(report, previewParams, "ar", previewOrigin');
    expect(source).toContain("patientQuery: cleanFilter(sp.q)");
    expect(source).toContain("patientPhone: cleanFilter(sp.phone)");
  });
});
