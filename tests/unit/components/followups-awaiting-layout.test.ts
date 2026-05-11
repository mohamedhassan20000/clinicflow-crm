import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(process.cwd(), "components/followups/followups-view.tsx"),
  "utf8",
);

describe("awaiting follow-up layout", () => {
  it("keeps file number and national ID in separate non-wrapping columns", () => {
    expect(source).toContain("<col className=\"w-32\" />");
    expect(source).toContain("<col className=\"w-44\" />");
    expect(source).toContain("File #");
    expect(source).toContain("National ID");
    expect(source).toContain("font-mono text-xs text-muted-foreground whitespace-nowrap");
    expect(source).toContain("a.patients?.national_id ?? \"—\"");
  });
});
