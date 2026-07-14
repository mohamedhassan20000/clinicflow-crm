import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function sourceFiles(dirs = ["app", "components", "contexts", "lib"]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(tsx?|css)$/.test(entry)) out.push(full);
    }
  };
  dirs.forEach(walk);
  return out;
}

/**
 * P2B — the RTL retrofit's standing invariants.
 *
 * The retrofit is only worth anything if it cannot silently rot. Physical-direction styles are
 * invisible in English — `pr-4` and `pe-4` render identically under `dir="ltr"` — so nothing in a
 * normal English review or an English snapshot will ever catch a regression. The CI gate is the
 * thing that catches it, and these tests are what keep the gate honest.
 */

const GATE = "scripts/check-logical-properties.mjs";

function runGate(): { code: number; output: string } {
  try {
    const output = execFileSync("node", [GATE], { encoding: "utf8", stdio: "pipe" });
    return { code: 0, output };
  } catch (error) {
    const failure = error as { status: number; stdout: string; stderr: string };
    return { code: failure.status, output: `${failure.stdout}${failure.stderr}` };
  }
}

describe("P2B RTL gate", () => {
  it("passes on the current tree — no undocumented physical-direction styles remain", () => {
    const { code, output } = runGate();
    expect(output).toContain("no undocumented physical-direction styles");
    expect(code).toBe(0);
  });

  /**
   * A gate that only ever returns green is indistinguishable from a gate that does nothing. Plant a
   * real violation and require it to fail — otherwise the CI step above is decoration.
   */
  it("actually fails when a physical-direction class is introduced", () => {
    const scratch = mkdtempSync(join(tmpdir(), "rtl-gate-"));
    const planted = join("components", `__rtl_gate_probe_${Date.now()}.tsx`);

    try {
      writeFileSync(planted, 'export const Probe = () => <div className="ml-4 text-right" />;\n');
      const { code, output } = runGate();

      expect(code).toBe(1);
      expect(output).toContain("ml-*");
      expect(output).toContain("text-right");
      // The failure has to tell the author what to write instead, not just that they are wrong.
      expect(output).toContain("ms-*");
      expect(output).toContain("text-end");
    } finally {
      rmSync(planted, { force: true });
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("fails when a directional icon ships without an RTL mirror", () => {
    const planted = join("components", `__rtl_icon_probe_${Date.now()}.tsx`);

    try {
      writeFileSync(planted, 'export const Probe = () => <ChevronRight className="size-4" />;\n');
      const { code, output } = runGate();

      expect(code).toBe(1);
      expect(output).toContain("<ChevronRight>");
    } finally {
      rmSync(planted, { force: true });
    }
  });

  it("accepts a directional icon once it carries a mirror", () => {
    const planted = join("components", `__rtl_icon_ok_${Date.now()}.tsx`);

    try {
      writeFileSync(planted, 'export const Probe = () => <ChevronRight className="size-4 rtl:rotate-180" />;\n');
      expect(runGate().code).toBe(0);
    } finally {
      rmSync(planted, { force: true });
    }
  });

  /**
   * P2B-R1 — the toggle glyphs are a *depiction of a switch*, and the real `Switch` primitive moves
   * its thumb under `dir="rtl"`. An unmirrored toggle icon therefore contradicts the widget it
   * stands for. They were live in the settings row menus and the gate could not see them at all.
   */
  it("fails on an unmirrored ToggleLeft/ToggleRight (P2B-R1)", () => {
    const planted = join("components", `__rtl_toggle_probe_${Date.now()}.tsx`);

    try {
      writeFileSync(planted, 'export const Probe = () => <><ToggleRight className="size-4" /><ToggleLeft className="size-4" /></>;\n');
      const { code, output } = runGate();

      expect(code).toBe(1);
      expect(output).toContain("<ToggleRight>");
      expect(output).toContain("<ToggleLeft>");
    } finally {
      rmSync(planted, { force: true });
    }
  });

  it("accepts the toggle glyphs once they carry a horizontal flip (P2B-R1)", () => {
    const planted = join("components", `__rtl_toggle_ok_${Date.now()}.tsx`);

    try {
      // A half-turn is wrong here: the knob is off-centre, so rotate-180 would move it vertically too.
      writeFileSync(planted, 'export const Probe = () => <ToggleRight className="size-4 rtl:-scale-x-100" />;\n');
      expect(runGate().code).toBe(0);
    } finally {
      rmSync(planted, { force: true });
    }
  });

  /**
   * P2B-R2 — the gate's header comment promised to catch physical CSS longhands including bare
   * `left:` / `right:`, and did not. That is the form hand-written CSS and JSX style objects reach
   * for, and the one form the Tailwind class rules structurally cannot see.
   */
  it("fails on a bare `left:` / `right:` CSS longhand (P2B-R2)", () => {
    const planted = join("components", `__rtl_css_probe_${Date.now()}.tsx`);

    try {
      writeFileSync(planted, 'export const Probe = () => <div style={{ position: "absolute", left: "24px" }} />;\n');
      const { code, output } = runGate();

      expect(code).toBe(1);
      expect(output).toContain("left:");
      expect(output).toContain("inset-inline-start");
    } finally {
      rmSync(planted, { force: true });
    }
  });

  it("accepts the logical inset once the longhand is converted (P2B-R2)", () => {
    const planted = join("components", `__rtl_css_ok_${Date.now()}.tsx`);

    try {
      writeFileSync(planted, 'export const Probe = () => <div style={{ position: "absolute", insetInlineStart: "24px" }} />;\n');
      expect(runGate().code).toBe(0);
    } finally {
      rmSync(planted, { force: true });
    }
  });

  it("sees a physical longhand in hand-written CSS, the file type most likely to carry one (P2B-R2)", () => {
    const planted = join("app", `__rtl_css_probe_${Date.now()}.css`);

    try {
      writeFileSync(planted, ".probe { position: fixed; right: 12px; }\n");
      const { code, output } = runGate();

      expect(code).toBe(1);
      expect(output).toContain("right:");
      expect(output).toContain("inset-inline-end");
    } finally {
      rmSync(planted, { force: true });
    }
  });
});

describe("P2B shadcn RTL configuration", () => {
  it("components.json is flipped to rtl, so future `shadcn add` emits logical classes", () => {
    const config = JSON.parse(readFileSync("components.json", "utf8"));
    expect(config.rtl).toBe(true);
  });
});

describe("P2B Sheet — logical sides", () => {
  const sheet = readFileSync("components/ui/sheet.tsx", "utf8");

  /**
   * Every caller means a *logical* side: the mobile nav drawer belongs at the inline start (left in
   * English, right in Arabic) and the detail panels at the inline end. shadcn's upstream sheet keys
   * off physical `left`/`right`, and its own RTL codemod does not convert those insets — while it
   * *does* convert their borders, which would pin the panel to one edge and draw its divider on the
   * other. Naming the sides logically is what removes the ambiguity.
   */
  it("positions, borders and animates off logical sides only", () => {
    expect(sheet).toContain("data-[side=inline-start]:start-0");
    expect(sheet).toContain("data-[side=inline-end]:end-0");
    expect(sheet).toContain("data-[side=inline-start]:data-open:slide-in-from-start-10");
    expect(sheet).toContain("data-[side=inline-end]:data-open:slide-in-from-end-10");

    expect(sheet).not.toContain("data-[side=left]");
    expect(sheet).not.toContain("data-[side=right]");
  });

  it("defaults to the inline end and offers no physical side", () => {
    expect(sheet).toContain('side = "inline-end"');
    expect(sheet).toContain('side?: "top" | "bottom" | "inline-start" | "inline-end"');
  });

  it("every call site asks for a logical side", () => {
    const callers = [
      "components/layout/dashboard-shell.tsx",
      "components/settings/staff-profile-sheet.tsx",
      "components/settings/add-staff-dialog.tsx",
    ];

    for (const caller of callers) {
      const source = readFileSync(caller, "utf8");
      expect(source, caller).not.toMatch(/side="(left|right)"/);
    }

    // The nav drawer specifically: it must open from the sidebar's side in both directions.
    expect(readFileSync("components/layout/dashboard-shell.tsx", "utf8")).toContain('side="inline-start"');
  });
});

describe("P2B codemod — the Tailwind v4 double-flip is stripped", () => {
  /**
   * shadcn's RTL transformer appends `rtl:space-x-reverse` / `rtl:divide-x-reverse` to any
   * `space-x-*` / `divide-x-*`. That was right for Tailwind v3, where `space-x-*` compiled to a
   * physical `margin-left`. Tailwind v4 compiles it to `margin-inline-start/end`, which already
   * flips with `dir` — so the extra `*-reverse` sets `--tw-space-x-reverse: 1` on top of an
   * already-flipped property and moves the gap to the wrong side of every child.
   *
   * The codemod strips those tokens. If a future shadcn regeneration reintroduces one, RTL spacing
   * silently breaks and English stays perfect, so nobody would notice. Hence this test.
   */
  it("no rtl:space-x-reverse or rtl:divide-x-reverse anywhere in app-owned source", () => {
    const offenders = sourceFiles().filter((file) =>
      /rtl:(space|divide)-x-reverse/.test(readFileSync(file, "utf8")),
    );

    expect(offenders).toEqual([]);
  });

  it("still leaves the underlying space-x utility in place — v4 flips it on its own", () => {
    // The avatar group's overlap is the one space-x in the product; the fix was to *not* add a
    // reverse, not to remove the utility.
    expect(readFileSync("components/ui/avatar.tsx", "utf8")).toContain("-space-x-2");
  });
});
