import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("RevenueReport settlement print styling", () => {
  it("prints the settlement total row with normalized black table borders", () => {
    const source = readFileSync(
      join(process.cwd(), "components/revenue/revenue-report.tsx"),
      "utf8",
    );

    expect(source).toContain("Total settled");
    expect(source).toContain("print:border-black");
    expect(source).not.toContain("print:[&>td]:border-t-2");
  });
});