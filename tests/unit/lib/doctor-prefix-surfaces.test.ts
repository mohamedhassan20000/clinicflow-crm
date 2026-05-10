import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

const doctorDisplaySurfaces = [
  "components/revenue/revenue-report.tsx",
  "components/followups/followups-view.tsx",
  "components/patients/patient-form.tsx",
  "components/patients/appointment-payment-row.tsx",
  "app/(protected)/patients/[id]/page.tsx",
  "components/appointments/day-calendar.tsx",
  "components/dashboard/doctor-dashboard.tsx",
  "components/dashboard/receptionist-dashboard.tsx",
  "components/dashboard/admin-dashboard.tsx",
  "app/(protected)/appointments/export/route.ts",
];

describe("doctor display surfaces", () => {
  it("do not hardcode a Dr. prefix before interpolated names", () => {
    const offenders = doctorDisplaySurfaces.flatMap((relativePath) => {
      const source = readFileSync(join(root, relativePath), "utf8");
      return source.match(/Dr\.\s*(?:\{|\$\{)/g)?.map((match) => ({
        relativePath,
        match,
      })) ?? [];
    });

    expect(offenders).toEqual([]);
  });
});
