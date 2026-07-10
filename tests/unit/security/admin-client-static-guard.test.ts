import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

describe("service-role static guard", () => {
  it("keeps raw createAdminClient usage out of app code", () => {
    const roots = ["actions", "app", "components", "hooks", "lib"]
      .map((dir) => join(process.cwd(), dir))
      .filter((dir) => statSync(dir, { throwIfNoEntry: false })?.isDirectory());
    const allowList = new Set(["lib/supabase/admin.ts"]);
    const appFiles = roots
      .flatMap((root) => walk(root))
      .filter((file) => file.endsWith(".ts") || file.endsWith(".tsx"));
    const offenders = appFiles
      .filter((file) => !allowList.has(relative(process.cwd(), file)))
      .filter((file) => readFileSync(file, "utf8").includes("createAdminClient"))
      .map((file) => relative(process.cwd(), file));

    expect(offenders).toEqual([]);
  });
});
