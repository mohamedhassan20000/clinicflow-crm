import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readSource = (path: string) => readFileSync(path, "utf8");

const headerSource = readSource("components/patients/patient-report-header.tsx");
const depositsSource = readSource(
  "app/(protected)/patients/[id]/deposits/page.tsx",
);
const packagesSource = readSource(
  "app/(protected)/patients/[id]/packages/page.tsx",
);
const historySource = readSource(
  "app/(protected)/patients/[id]/history/page.tsx",
);

describe("patient report document actions", () => {
  it.each([
    ["deposits", depositsSource, "deposit-statement"],
    ["packages", packagesSource, "package-history"],
  ])("keeps Generate Document and hides standalone Print for %s", (_, source, documentSlug) => {
    expect(source).toContain(
      `documentHref={\`/documents/patient-history/${documentSlug}?\${buildDocumentQuery(id, range)}\`}`,
    );
    expect(source).toContain("showPrint={false}");
  });

  it("keeps the shared header print behavior unchanged for other patient reports", () => {
    expect(headerSource).toContain("showPrint = true");
    expect(headerSource).toContain("{showPrint ? <PrintButton /> : null}");
    expect(historySource).not.toContain("showPrint={false}");
  });
});
