/**
 * Phase 7 — superset coverage for the strangler cutover (plan §14.2–3, §15 P7).
 *
 * §14 permits a narrow tool to be unmounted only once an equivalent generic call
 * is proven to return at least the same fields for the same role. This suite is
 * that proof, and it is deliberately written against the *live* registries
 * rather than against a snapshot: every claim in `lib/ai/tools/superseded.ts` is
 * re-derived here, so the day someone drops `medical_notes.note` or narrows the
 * appointments resource's roles, the failure names the capability that was taken
 * away instead of surfacing as a user asking why the assistant got worse.
 *
 * Four claims:
 *   1. The removed tools are gone from the registry *and* from the tree — no
 *      orphan module, no orphan import.
 *   2. Each replacement resource genuinely carries the removed tool's fields,
 *      filters and relations, and is authorized for the roles it must cover.
 *   3. The generic tools that serve them are mounted for every one of those
 *      roles, so the capability is reachable and not merely declared.
 *   4. The registry is exactly generic ∪ retained, with the superseded set
 *      disjoint from it — the final capability surface, classified exhaustively.
 */

import { describe, it, expect, vi } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("server-only", () => ({}));

import { AI_TOOL_REGISTRY } from "@/lib/ai/tools/registry";
import {
  SUPERSEDED_AI_TOOLS,
  RETAINED_PURPOSE_BUILT_TOOLS,
  GENERIC_CAPABILITY_TOOLS,
} from "@/lib/ai/tools/superseded";
import { RESOURCE_REGISTRY_BY_ID } from "@/lib/ai/resources/registry";
import { MEDICAL_NOTE_READ_ROLES } from "@/lib/patients/read-permissions";
import { isKnownAiFeature } from "@/lib/ai/commercial-policy";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const registryNames = new Set(AI_TOOL_REGISTRY.map((entry) => entry.name));

describe("Phase 7 · superseded tools are unmounted and their modules deleted", () => {
  it.each(SUPERSEDED_AI_TOOLS.map((record) => [record.name, record] as const))(
    "%s is absent from AI_TOOL_REGISTRY",
    (_name, record) => {
      expect(registryNames.has(record.name)).toBe(false);
    },
  );

  it.each(SUPERSEDED_AI_TOOLS.map((record) => [record.name, record] as const))(
    "%s: the tool module no longer exists",
    (_name, record) => {
      expect(existsSync(path.join(REPO_ROOT, record.modulePath))).toBe(false);
    },
  );

  it("no live AI module still imports a superseded tool builder", () => {
    // A deleted module that something still imports would fail the build, but a
    // *stale reference in a comment or a string* would not — and the mount, the
    // capability panel and the presentation map all key on these names.
    const liveSources = [
      "lib/ai/tools/registry.ts",
      "lib/ai/tools/index.ts",
      "lib/ai/capabilities.ts",
    ];
    // Comments are stripped first: a note explaining *why* a tool was removed is
    // documentation, not a live reference, and forbidding it would push the
    // history out of the file that needs it most.
    const stripComments = (source: string) =>
      source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const relative of liveSources) {
      const source = stripComments(
        readFileSync(path.join(REPO_ROOT, relative), "utf8"),
      );
      for (const record of SUPERSEDED_AI_TOOLS) {
        expect(source, `${relative} still references ${record.name}`).not.toContain(
          record.name,
        );
      }
    }
  });
});

describe("Phase 7 · each replacement is a field/filter superset for the roles it covers", () => {
  const cases = SUPERSEDED_AI_TOOLS.flatMap((record) =>
    record.replacements.map(
      (replacement) =>
        [`${record.name} → ${replacement.resource}`, record, replacement] as const,
    ),
  );

  it.each(cases)("%s: the resource is registered", (_label, _record, replacement) => {
    expect(RESOURCE_REGISTRY_BY_ID.get(replacement.resource)).toBeDefined();
  });

  it.each(cases)(
    "%s: every claimed field is a declared, readable field",
    (_label, _record, replacement) => {
      const definition = RESOURCE_REGISTRY_BY_ID.get(replacement.resource)!;
      for (const fieldName of replacement.fields) {
        expect(
          Object.keys(definition.fields),
          `${replacement.resource}.${fieldName}`,
        ).toContain(fieldName);
      }
      // Field policy must actually expose them to every role covered.
      for (const role of replacement.rolesCovered) {
        const readable = new Set(
          definition.fieldPolicy({
            id: "00000000-0000-4000-8000-000000000001",
            clinicId: "00000000-0000-4000-8000-0000000000c1",
            role,
          } as never),
        );
        for (const fieldName of replacement.fields) {
          expect(
            readable.has(fieldName),
            `${role} cannot read ${replacement.resource}.${fieldName}`,
          ).toBe(true);
        }
      }
    },
  );

  it.each(cases)(
    "%s: every claimed filter key is registered with a server-owned column",
    (_label, _record, replacement) => {
      const definition = RESOURCE_REGISTRY_BY_ID.get(replacement.resource)!;
      for (const filterKey of replacement.filters) {
        const spec = definition.filters[filterKey];
        expect(spec, `${replacement.resource} filter "${filterKey}"`).toBeDefined();
        expect(spec!.column.length).toBeGreaterThan(0);
        expect(spec!.operators.length).toBeGreaterThan(0);
      }
    },
  );

  const relationCases = cases.filter(
    ([, , replacement]) => Object.keys(replacement.relations ?? {}).length > 0,
  );

  it.each(relationCases)(
    "%s: every claimed relation is registered",
    (_label, _record, replacement) => {
      const definition = RESOURCE_REGISTRY_BY_ID.get(replacement.resource)!;
      for (const relation of Object.keys(replacement.relations ?? {})) {
        expect(Object.keys(definition.relations)).toContain(relation);
      }
    },
  );

  // P7-03. Relation *names* were too weak: `list_appointments` returned
  // `patient_file_number`, `doctor_name` and `department_name` through these
  // embeds, and deleting `file_number` from the appointments `patient` relation
  // — or dropping it from that relation's defaultFields — took a column away
  // while a name-only assertion stayed green. The manifest now carries the
  // projected fields, and this asserts all three properties the removed tool
  // depended on: declared, readable for every covered role, and returned
  // unasked.
  it.each(relationCases)(
    "%s: every relation field the removed tool projected is declared, readable, and returned by default",
    (_label, record, replacement) => {
      const definition = RESOURCE_REGISTRY_BY_ID.get(replacement.resource)!;
      for (const [relationName, relationFields] of Object.entries(
        replacement.relations ?? {},
      )) {
        const relation = definition.relations[relationName]!;
        for (const fieldName of relationFields) {
          const where = `${record.name} → ${replacement.resource}.${relationName}.${fieldName}`;
          expect(Object.keys(relation.fields), where).toContain(fieldName);
          for (const role of replacement.rolesCovered) {
            const readable = new Set(
              relation.fieldPolicy({
                id: "00000000-0000-4000-8000-000000000001",
                clinicId: "00000000-0000-4000-8000-0000000000c1",
                role,
              } as never),
            );
            expect(readable.has(fieldName), `${role} cannot read ${where}`).toBe(
              true,
            );
          }
          // The removed tool returned these without the caller asking for them,
          // so a generic read that names only the relation must still get them.
          expect(relation.defaultFields, where).toContain(fieldName);
        }
      }
    },
  );

  // P7-02. Filter-key parity is not semantic parity: a `scheduled_at` key that
  // accepts only offset-bearing instants reproduces the key and loses the
  // capability, because the model has neither the clinic timezone nor today's
  // date. Each recorded clinic-local form is checked against the live filter
  // schema, so narrowing the filter back to instants fails naming the tool.
  const dateCases = cases.filter(([, , replacement]) => replacement.dateSemantics);

  it("at least one replacement records date semantics", () => {
    // Guards the it.each above against silently emptying if the field is dropped
    // from every record.
    expect(dateCases.length).toBeGreaterThan(0);
  });

  it.each(dateCases)(
    "%s: the replacement filter still accepts every clinic-local form the removed tool did",
    (_label, record, replacement) => {
      const semantics = replacement.dateSemantics!;
      const definition = RESOURCE_REGISTRY_BY_ID.get(replacement.resource)!;
      const spec = definition.filters[semantics.filter];
      expect(
        spec,
        `${record.name} → ${replacement.resource}.${semantics.filter}`,
      ).toBeDefined();
      // Resolution must be server-side. A filter without a resolver would hand
      // the raw value to PostgREST, which is exactly the regression.
      expect(spec!.resolver, semantics.filter).toBeDefined();
      expect(semantics.resolvedBy.length).toBeGreaterThan(20);

      const samples: Record<string, string> = {
        "YYYY-MM-DD": "2026-03-01",
        today: "today",
        this_week: "this_week",
        this_month: "this_month",
      };
      for (const form of semantics.clinicLocalForms) {
        const sample = samples[form] ?? form;
        expect(
          spec!.schema.safeParse(sample).success,
          `${record.name}: ${semantics.filter} rejects clinic-local form "${form}"`,
        ).toBe(true);
      }
      // And the absolute-instant form the resource layer introduced still works,
      // so this is additive rather than a swap.
      expect(
        spec!.schema.safeParse("2026-03-01T09:00:00.000Z").success,
      ).toBe(true);
      // A bare timezone name is still refused — the model never supplies one.
      expect(spec!.schema.safeParse("Africa/Cairo").success).toBe(false);
    },
  );

  it.each(dateCases)(
    "%s: every deviation from the removed tool's range behaviour is stated",
    (_label, _record, replacement) => {
      for (const deviation of replacement.dateSemantics!.deviations ?? []) {
        expect(deviation.length).toBeGreaterThan(40);
      }
      // The clamp is the one deviation this phase made; it must stay recorded
      // rather than becoming an unwritten difference.
      expect(
        (replacement.dateSemantics!.deviations ?? []).some((entry) =>
          /MAX_RANGE_DAYS/.test(entry),
        ),
      ).toBe(true);
    },
  );

  it.each(cases)(
    "%s: the resource authorizes every role it must cover",
    (_label, record, replacement) => {
      const definition = RESOURCE_REGISTRY_BY_ID.get(replacement.resource)!;
      for (const role of replacement.rolesCovered) {
        expect(definition.roles, `${replacement.resource} · ${role}`).toContain(role);
        // A covered role must also be one the removed tool actually mounted for.
        expect(record.roles).toContain(role);
      }
    },
  );

  it.each(cases)(
    "%s: declares only known AI feature keys",
    (_label, _record, replacement) => {
      const definition = RESOURCE_REGISTRY_BY_ID.get(replacement.resource)!;
      expect(definition.requiredFeatures.length).toBeGreaterThan(0);
      for (const feature of definition.requiredFeatures) {
        expect(isKnownAiFeature(feature)).toBe(true);
      }
    },
  );
});

describe("Phase 7 · role narrowings are backed by the application role constant", () => {
  it("the medical_notes narrowing equals MEDICAL_NOTE_READ_ROLES exactly", () => {
    // The manifest claims manager and assistant lost nothing, because RLS never
    // gave them a note in the first place. That claim is only as good as the
    // constant it mirrors, so assert them equal rather than merely compatible.
    const narrowed = SUPERSEDED_AI_TOOLS.flatMap((record) =>
      record.replacements.filter(
        (replacement) => replacement.resource === "medical_notes",
      ),
    );
    expect(narrowed.length).toBeGreaterThan(0);
    for (const replacement of narrowed) {
      expect([...replacement.rolesCovered].sort()).toEqual(
        [...MEDICAL_NOTE_READ_ROLES].sort(),
      );
      expect(replacement.narrowing).toBeTruthy();
    }
  });

  it("every narrowed replacement states why", () => {
    for (const record of SUPERSEDED_AI_TOOLS) {
      for (const replacement of record.replacements) {
        if (replacement.rolesCovered.length < record.roles.length) {
          expect(
            replacement.narrowing,
            `${record.name} → ${replacement.resource}`,
          ).toBeTruthy();
        }
      }
    }
  });
});

describe("Phase 7 · the serving generic tools are mounted for every covered role", () => {
  const cases = SUPERSEDED_AI_TOOLS.flatMap((record) =>
    record.servedBy.map((toolName) => [record.name, toolName, record] as const),
  );

  it.each(cases)(
    "%s is served by %s, which is registered for the same roles",
    (_name, toolName, record) => {
      const definition = AI_TOOL_REGISTRY.find((entry) => entry.name === toolName);
      expect(definition, toolName).toBeDefined();
      for (const role of record.roles) {
        expect(definition!.roles, `${toolName} · ${role}`).toContain(role);
      }
    },
  );
});

describe("Phase 7 · no test fixture still names a removed tool", () => {
  /**
   * P7-06. Fixtures kept naming `list_appointments` and `get_patient_summary`
   * long after both were deleted. None was load-bearing, which is why the suite
   * stayed green — and is exactly the problem: a capability item named after a
   * tool that no longer exists exercised `presentationFor`'s *fallback* branch
   * instead of a real mapping, so it stopped testing what its name implied.
   *
   * Comments are stripped first. Explaining why a tool was removed is
   * documentation and belongs in the suite that replaced it; the Phase 7 suites
   * additionally carry the names as data, because asserting on the migration is
   * their subject.
   */
  const PHASE_7_SUITES = [
    "phase7-superset-coverage.test.ts",
    "phase7-context-parity.test.ts",
    "phase7-capability-surface.test.ts",
    "phase7-clinic-date-semantics.test.ts",
  ];

  function collectTests(dir: string, into: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) collectTests(full, into);
      else if (/\.tsx?$/.test(entry.name)) into.push(full);
    }
    return into;
  }

  const stripComments = (source: string) =>
    source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  const testFiles = collectTests(path.join(REPO_ROOT, "tests")).filter(
    (file) => !PHASE_7_SUITES.includes(path.basename(file)),
  );

  it.each(SUPERSEDED_AI_TOOLS.map((record) => [record.name] as const))(
    "%s appears in no fixture, mock, or rubric outside the Phase 7 suites",
    (name) => {
      const offenders = testFiles.filter((file) =>
        stripComments(readFileSync(file, "utf8")).includes(name),
      );
      expect(
        offenders.map((file) => path.relative(REPO_ROOT, file)),
        `${name} is still live test data`,
      ).toEqual([]);
    },
  );

  it("scanned a plausible number of test files", () => {
    // Guards the assertion above against passing because the walk found nothing.
    expect(testFiles.length).toBeGreaterThan(100);
  });
});

describe("Phase 7 · no authorization assert survives without a production caller", () => {
  /**
   * P7-05. `assertClinicalToolAccess` outlived the four clinical tools that
   * called it and sat in `lib/ai/authorization.ts` looking like a live gate,
   * with two suites pinned to it. A live-looking assert with no caller is worse
   * than no assert: it suggests a check is in the path when it is not. This
   * derives the exported asserts from the module itself and requires each to be
   * reachable from production code, so the next one to be orphaned fails here
   * by name rather than being noticed in a review.
   */
  const PRODUCTION_ROOTS = ["lib", "app", "components", "actions"];

  function collectSources(dir: string, into: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) collectSources(full, into);
      else if (/\.tsx?$/.test(entry.name)) into.push(full);
    }
    return into;
  }

  const authorizationPath = path.join(REPO_ROOT, "lib/ai/authorization.ts");
  const authorizationSource = readFileSync(authorizationPath, "utf8");
  const exportedAsserts = [
    ...authorizationSource.matchAll(
      /export\s+(?:async\s+)?function\s+(assert\w+)|export\s+const\s+(assert\w+)\s*=/g,
    ),
  ].map((match) => match[1] ?? match[2]!);

  const productionSources = PRODUCTION_ROOTS.flatMap((root) =>
    collectSources(path.join(REPO_ROOT, root)),
  ).filter((file) => file !== authorizationPath);
  const productionText = productionSources
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");

  it("finds the exported asserts it is meant to check", () => {
    expect(exportedAsserts.length).toBeGreaterThan(2);
  });

  it.each(exportedAsserts.map((name) => [name] as const))(
    "%s is reachable from production code",
    (name) => {
      // An in-module call counts — `assertStaffRole` is composed into
      // `assertStaffToolAccess` rather than called directly by a tool — but only
      // if the name appears somewhere other than its own declaration.
      const inModuleUses =
        authorizationSource.split(name).length - 1;
      expect(
        productionText.includes(name) || inModuleUses > 1,
        `${name} is exported from lib/ai/authorization.ts but nothing calls it`,
      ).toBe(true);
    },
  );

  it("no longer exports the superseded clinical assert", () => {
    for (const removed of [
      "assertClinicalToolAccess",
      "assertDoctorToolAccess",
      "assertClinicalRole",
    ]) {
      expect(
        new RegExp(`export\\s+(?:async\\s+function|const)\\s+${removed}\\b`).test(
          authorizationSource,
        ),
        removed,
      ).toBe(false);
    }
  });
});

describe("Phase 7 · the final capability surface is classified exhaustively", () => {
  const generic = new Set(GENERIC_CAPABILITY_TOOLS);
  const retained = new Set(RETAINED_PURPOSE_BUILT_TOOLS.map((entry) => entry.name));
  const superseded = new Set(SUPERSEDED_AI_TOOLS.map((entry) => entry.name));

  it("every registered tool is either generic or deliberately retained", () => {
    const unclassified = [...registryNames].filter(
      (name) => !generic.has(name) && !retained.has(name),
    );
    expect(unclassified).toEqual([]);
  });

  it("every generic and retained tool is actually registered", () => {
    for (const name of [...generic, ...retained]) {
      expect(registryNames, name).toContain(name);
    }
  });

  it("the three classifications are mutually disjoint", () => {
    for (const name of superseded) {
      expect(generic.has(name)).toBe(false);
      expect(retained.has(name)).toBe(false);
    }
  });

  it("every retained tool records why it is not a resource read", () => {
    for (const entry of RETAINED_PURPOSE_BUILT_TOOLS) {
      expect(entry.reason.length, entry.name).toBeGreaterThan(20);
    }
  });
});
