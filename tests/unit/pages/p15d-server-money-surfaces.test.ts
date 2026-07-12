import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe.each([
  "app/(protected)/patients/[id]/page.tsx",
  "app/(protected)/settings/services/page.tsx",
  "app/(protected)/settings/packages/page.tsx",
])("P1.5D server money surface %s", (path) => {
  it("uses the shared display-currency formatter instead of canonical-only formatting", () => {
    const source = readFileSync(path, "utf8");
    expect(source).toContain("getServerMoneyFormatter");
    expect(source).not.toContain("formatClinicCurrency");
  });
});

