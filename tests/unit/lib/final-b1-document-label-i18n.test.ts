/**
 * Final comprehensive review — B-1 regression suite.
 *
 * The defect: P6-09 needed a document label in an explicitly chosen locale, so
 * `documentTypeLabels()` bound its translator through a ternary —
 * `const t = locale ? await getTranslations({locale, namespace}) : await
 * getTranslations(namespace)`. `scripts/check-messages.mjs` binds a translator
 * variable to a namespace with regexes anchored on a literal `getTranslations`
 * initializer; a ternary matches neither, so `t` was bound to no namespace,
 * all 21 `t("…")` calls became invisible, and every leaf under
 * `documents.catalog` fell into the unused list. `pnpm i18n:unused` — a
 * required CI job — went red on a purely static-analysis break, while the
 * rendered EN/AR output was correct throughout.
 *
 * The fix resolves the locale *before* binding, so the translator is a single
 * literal `getTranslations({ locale, namespace: "documents.catalog" })`.
 *
 * These tests pin both halves of that: the catalog keys are still real and
 * referenced by literal key, and the gate that proves it still bites when a
 * reference is removed. The gate is driven as the CI job drives it — the real
 * script, on the real tree — rather than by re-implementing its regexes here,
 * because a re-implementation is exactly the kind of second copy that drifted
 * in the first place.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const MODULE_PATH = join(ROOT, "lib/documents/module-labels.ts");

function catalogKeys(): string[] {
  const messages = JSON.parse(
    readFileSync(join(ROOT, "messages/en.json"), "utf8"),
  ) as { documents: { catalog: Record<string, string> } };
  return Object.keys(messages.documents.catalog);
}

function runGate(mode: "unused" | "missing"): { code: number; output: string } {
  try {
    const output = execFileSync(
      process.execPath,
      ["scripts/check-messages.mjs", mode],
      { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return { code: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      code: failure.status ?? 1,
      output: `${failure.stdout ?? ""}${failure.stderr ?? ""}`,
    };
  }
}

describe("B-1 · the document catalog stays provable to the i18n unused-key gate", () => {
  it("binds its translator in the literal form the checker recognises", () => {
    const source = readFileSync(MODULE_PATH, "utf8");
    // The two shapes `scripts/check-messages.mjs` binds (lines 222-227). A
    // ternary, a helper parameter, or a destructured translator would all read
    // as "no namespace" and silently orphan every key below.
    const bindings = [
      ...source.matchAll(
        /\bconst\s+(\w+)\s*=\s*(?:await\s+)?(?:useTranslations|getTranslations)\("([^"]+)"\)/g,
      ),
      ...source.matchAll(
        /\bconst\s+(\w+)\s*=\s*(?:await\s+)?getTranslations\(\{[^}]*\bnamespace:\s*"([^"]+)"[^}]*\}\)/g,
      ),
    ];
    expect(bindings.length).toBeGreaterThan(0);
    expect(bindings.map((match) => match[2])).toContain("documents.catalog");
  });

  it("references every documents.catalog key by string literal", () => {
    const source = readFileSync(MODULE_PATH, "utf8");
    const keys = catalogKeys();
    expect(keys.length).toBeGreaterThanOrEqual(21);
    for (const key of keys) {
      expect(source, key).toContain(`t("${key}")`);
    }
  });

  it("passes the real unused-key gate the CI job runs", () => {
    const { code, output } = runGate("unused");
    expect(output).not.toMatch(/documents\.catalog/);
    expect(code, output).toBe(0);
  });

  it("passes the parity gate too — the checker's call scan is lexical", () => {
    // The `missing` half is the other side of the same scan, and it is easy to
    // break from this file specifically: `check-messages.mjs` does not skip
    // comments, so an illustrative translator call with a placeholder key in
    // the module's own doc block registers as a reference to a key that does
    // not exist. Asserted here so a future explanatory comment cannot turn a
    // green `unused` run into a red `missing` one unnoticed.
    const { code, output } = runGate("missing");
    expect(output).not.toMatch(/documents\.catalog/);
    expect(code, output).toBe(0);
  });

  it("still reports a documents.catalog key when its reference is removed", () => {
    // The gate has to *bite*, not merely pass. Exempting the namespace via
    // `dynamicNamespaces` would also make the suite above green while
    // permanently disabling the check for the subtree it protects, so this
    // drives the checker over a tree with one reference deleted and requires
    // the deleted key — and only it — to be named.
    const original = readFileSync(MODULE_PATH, "utf8");
    const key = catalogKeys()[0]!;
    const patched = original.replace(`t("${key}")`, `"probe"`);
    expect(patched).not.toBe(original);

    try {
      writeFileSync(MODULE_PATH, patched, "utf8");
      const { code, output } = runGate("unused");
      expect(code).toBe(1);
      expect(output).toContain(`documents.catalog.${key}`);
    } finally {
      writeFileSync(MODULE_PATH, original, "utf8");
    }

    // And the tree is left exactly as it was found.
    expect(readFileSync(MODULE_PATH, "utf8")).toBe(original);
  });
});
