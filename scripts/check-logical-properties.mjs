#!/usr/bin/env node
// P2B RTL gate: fails when app-owned source introduces a physical-direction style.
//
// The app must stay direction-safe in both `dir="ltr"` and `dir="rtl"` (AI_AGENT_PLAN §4.2).
// Physical utilities (ml-, pr-, left-, text-right, border-l, rounded-tl, …) and physical CSS
// longhands (margin-left, padding-right, left:, text-align: right, …) do not flip with `dir`,
// so every one of them is a latent RTL bug.
//
// Exceptions are legitimate but must be *documented*, never silent. Two forms:
//   • an inline `rtl-allow: <reason>` comment on the offending line or the line above it;
//   • an entry in scripts/rtl-allowlist.json, for whole files (e.g. vendored chart internals).
//
// Usage: node scripts/check-logical-properties.mjs [--json]

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const SCAN_DIRS = ["app", "components", "contexts", "hooks", "lib"];
const SCAN_EXTENSIONS = [".ts", ".tsx", ".css"];
const SKIP_DIRS = new Set(["node_modules", ".next", "fonts"]);

const ALLOW_COMMENT = /rtl-allow\s*:\s*(.+)/;

/**
 * Tailwind physical-direction utilities. Each entry carries the logical replacement so the
 * failure message tells the author what to write instead of only what not to write.
 *
 * `(?![a-z])` after a short stem is load-bearing: without it `rounded-l` swallows `rounded-lg`
 * and `border-r` swallows `border-red-500`.
 */
const CLASS_RULES = [
  { re: /(?<![\w-])-?ml-(?=[\w[])/g, name: "ml-*", fix: "ms-*" },
  { re: /(?<![\w-])-?mr-(?=[\w[])/g, name: "mr-*", fix: "me-*" },
  { re: /(?<![\w-])-?pl-(?=[\w[])/g, name: "pl-*", fix: "ps-*" },
  { re: /(?<![\w-])-?pr-(?=[\w[])/g, name: "pr-*", fix: "pe-*" },
  { re: /(?<![\w-])-?scroll-ml-(?=[\w[])/g, name: "scroll-ml-*", fix: "scroll-ms-*" },
  { re: /(?<![\w-])-?scroll-mr-(?=[\w[])/g, name: "scroll-mr-*", fix: "scroll-me-*" },
  { re: /(?<![\w-])-?scroll-pl-(?=[\w[])/g, name: "scroll-pl-*", fix: "scroll-ps-*" },
  { re: /(?<![\w-])-?scroll-pr-(?=[\w[])/g, name: "scroll-pr-*", fix: "scroll-pe-*" },
  // Inset: only value-shaped suffixes, so prose like "right-hand" is not a false positive.
  { re: /(?<![\w-])-?left-(?=(\d|px|full|auto|\[))/g, name: "left-*", fix: "start-*" },
  { re: /(?<![\w-])-?right-(?=(\d|px|full|auto|\[))/g, name: "right-*", fix: "end-*" },
  { re: /(?<![\w-])text-left(?![\w-])/g, name: "text-left", fix: "text-start" },
  { re: /(?<![\w-])text-right(?![\w-])/g, name: "text-right", fix: "text-end" },
  { re: /(?<![\w-])border-l(?![a-z])/g, name: "border-l*", fix: "border-s*" },
  { re: /(?<![\w-])border-r(?![a-z])/g, name: "border-r*", fix: "border-e*" },
  { re: /(?<![\w-])rounded-l(?![a-z])/g, name: "rounded-l*", fix: "rounded-s*" },
  { re: /(?<![\w-])rounded-r(?![a-z])/g, name: "rounded-r*", fix: "rounded-e*" },
  { re: /(?<![\w-])rounded-tl(?![a-z])/g, name: "rounded-tl*", fix: "rounded-ss*" },
  { re: /(?<![\w-])rounded-tr(?![a-z])/g, name: "rounded-tr*", fix: "rounded-se*" },
  { re: /(?<![\w-])rounded-bl(?![a-z])/g, name: "rounded-bl*", fix: "rounded-es*" },
  { re: /(?<![\w-])rounded-br(?![a-z])/g, name: "rounded-br*", fix: "rounded-ee*" },
  { re: /(?<![\w-])float-left(?![\w-])/g, name: "float-left", fix: "float-start" },
  { re: /(?<![\w-])float-right(?![\w-])/g, name: "float-right", fix: "float-end" },
  { re: /(?<![\w-])clear-left(?![\w-])/g, name: "clear-left", fix: "clear-start" },
  { re: /(?<![\w-])clear-right(?![\w-])/g, name: "clear-right", fix: "clear-end" },
];

/** Physical CSS longhands, for hand-written CSS (`app/globals.css`) and inline style objects. */
const CSS_RULES = [
  // Bare inset longhands, in CSS (`left: 24px`) and in JSX style objects (`style={{ left: "-5%" }}`).
  // These are the form the class rules above cannot see, and the form hand-written CSS reaches for.
  // The symmetric `left: 0; right: 0` idiom is direction-neutral but still needs an `rtl-allow`, so
  // that "this one is deliberate" is a statement someone made rather than one the gate assumed.
  { re: /(?<![\w-])left\s*:/g, name: "left:", fix: "inset-inline-start (or `inset-inline: 0` when paired with right: 0)" },
  { re: /(?<![\w-])right\s*:/g, name: "right:", fix: "inset-inline-end (or `inset-inline: 0` when paired with left: 0)" },
  { re: /(?<![\w-])margin-left\s*:/g, name: "margin-left", fix: "margin-inline-start" },
  { re: /(?<![\w-])margin-right\s*:/g, name: "margin-right", fix: "margin-inline-end" },
  { re: /(?<![\w-])padding-left\s*:/g, name: "padding-left", fix: "padding-inline-start" },
  { re: /(?<![\w-])padding-right\s*:/g, name: "padding-right", fix: "padding-inline-end" },
  { re: /(?<![\w-])border-left\b/g, name: "border-left", fix: "border-inline-start" },
  { re: /(?<![\w-])border-right\b/g, name: "border-right", fix: "border-inline-end" },
  { re: /(?<![\w-])text-align\s*:\s*(left|right)/g, name: "text-align: left|right", fix: "text-align: start|end" },
  { re: /(?<![\w-])border-(top|bottom)-(left|right)-radius\s*:/g, name: "border-*-*-radius", fix: "border-start-start-radius etc." },
  { re: /(?<![\w-])marginLeft\s*:/g, name: "marginLeft", fix: "marginInlineStart" },
  { re: /(?<![\w-])marginRight\s*:/g, name: "marginRight", fix: "marginInlineEnd" },
  { re: /(?<![\w-])paddingLeft\s*:/g, name: "paddingLeft", fix: "paddingInlineStart" },
  { re: /(?<![\w-])paddingRight\s*:/g, name: "paddingRight", fix: "paddingInlineEnd" },
];

/**
 * Directional icons must be mirrored under `dir="rtl"`, or the arrow points the wrong way.
 *
 * Two mirrors, and the difference is not cosmetic:
 *   • `rtl:rotate-180` — correct only for glyphs symmetric about the horizontal axis
 *     (chevrons, plain left/right arrows, the log-in/log-out door glyphs).
 *   • `rtl:-scale-x-100` — a true horizontal flip, required for diagonal or asymmetric glyphs.
 *     Rotating `ArrowUpRight` by 180° points it *down-left*, which is simply a different icon.
 *
 * `rtl:hidden` + `rtl:block` (rendering the opposite glyph instead) also satisfies the rule.
 *
 * `ToggleLeft` / `ToggleRight` are here for a reason that is easy to miss: they are *depictions of a
 * switch*, and the real `Switch` primitive moves its thumb to the other side under `dir="rtl"`
 * (components/ui/switch.tsx). An unmirrored toggle glyph therefore contradicts the very widget it
 * stands for. They take `rtl:-scale-x-100` — the knob is off-centre, so a half-turn would move it
 * vertically as well.
 *
 * Not every one of these should be mirrored — a trend arrow next to a "+12%" delta belongs to the
 * chart's coordinate space, which stays LTR by design (AI_AGENT_PLAN §4.2 step 4). Those need an
 * `rtl-allow` comment, so the exception is a decision someone made rather than one they forgot.
 */
const DIRECTIONAL_ICONS = [
  "ChevronLeft", "ChevronRight", "ChevronsLeft", "ChevronsRight",
  "ArrowLeft", "ArrowRight", "ArrowUpRight", "ArrowDownRight", "ArrowUpLeft", "ArrowDownLeft",
  "MoveLeft", "MoveRight", "CornerDownLeft", "CornerDownRight", "CornerUpLeft", "CornerUpRight",
  "LogIn", "LogOut", "Send", "ExternalLink", "Reply", "Forward",
  "IndentIncrease", "IndentDecrease",
  "ToggleLeft", "ToggleRight",
  "PanelLeft", "PanelRight", "PanelLeftOpen", "PanelLeftClose",
  "ChevronFirst", "ChevronLast", "SkipBack", "SkipForward", "Undo", "Redo", "Undo2", "Redo2",
];

const ICON_RULES = DIRECTIONAL_ICONS.map((icon) => ({
  re: new RegExp(`<${icon}(Icon)?(\\s|/|>)`),
  name: `<${icon}>`,
  fix: "rtl:rotate-180 (symmetric glyphs) or rtl:-scale-x-100 (diagonal glyphs)",
}));

const MIRRORED = /rtl:rotate-180|rtl:-scale-x-100|rtl:block|rtl:hidden/;

function loadAllowlist() {
  const raw = JSON.parse(readFileSync(join(ROOT, "scripts/rtl-allowlist.json"), "utf8"));
  return new Map(raw.files.map((entry) => [entry.path, entry]));
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SCAN_EXTENSIONS.some((ext) => entry.endsWith(ext))) out.push(full);
  }
  return out;
}

/**
 * Icon tags are checked against the whole element, not the line the tag opens on: a JSX icon may
 * carry its className two lines below `<ChevronRight`.
 */
function scanIcons(source, lines, path, fileAllow) {
  const violations = [];
  const allowed = [];
  if (path.endsWith(".css")) return { violations, allowed };

  for (const rule of ICON_RULES) {
    let cursor = 0;
    for (;;) {
      const rest = source.slice(cursor);
      const offset = rest.search(rule.re);
      if (offset === -1) break;

      const start = cursor + offset;
      cursor = start + 1;

      const close = source.indexOf(">", start);
      const element = source.slice(start, close === -1 ? source.length : close + 1);
      if (MIRRORED.test(element)) continue;

      const line = source.slice(0, start).split("\n").length;
      const suppressed =
        ALLOW_COMMENT.test(lines[line - 1] ?? "") || ALLOW_COMMENT.test(lines[line - 2] ?? "");

      const hit = { path, line, class: rule.name, fix: rule.fix, source: element.split("\n")[0].trim() };
      if (suppressed || fileAllow?.classes?.includes(rule.name)) allowed.push(hit);
      else violations.push(hit);
    }
  }

  return { violations, allowed };
}

function scanFile(absolute, allowlist) {
  const path = relative(ROOT, absolute).split(sep).join("/");
  const fileAllow = allowlist.get(path);
  if (fileAllow && !fileAllow.classes) return { path, violations: [], allowed: [] };

  const source = readFileSync(absolute, "utf8");
  const lines = source.split("\n");
  const rules = absolute.endsWith(".css") ? [...CSS_RULES, ...CLASS_RULES] : [...CLASS_RULES, ...CSS_RULES];

  const violations = [];
  const allowed = [];

  lines.forEach((line, index) => {
    const suppressed =
      ALLOW_COMMENT.test(line) || (index > 0 && ALLOW_COMMENT.test(lines[index - 1]));

    for (const rule of rules) {
      rule.re.lastIndex = 0;
      if (!rule.re.test(line)) continue;

      const hit = { path, line: index + 1, class: rule.name, fix: rule.fix, source: line.trim() };
      const allowedByFile = fileAllow?.classes?.includes(rule.name);
      if (suppressed || allowedByFile) allowed.push(hit);
      else violations.push(hit);
    }
  });

  const icons = scanIcons(source, lines, path, fileAllow);
  violations.push(...icons.violations);
  allowed.push(...icons.allowed);

  return { path, violations, allowed };
}

const allowlist = loadAllowlist();
const files = SCAN_DIRS.map((dir) => join(ROOT, dir))
  .filter((dir) => existsSync(dir))
  .flatMap((dir) => walk(dir));
const results = files.map((file) => scanFile(file, allowlist));

const violations = results.flatMap((result) => result.violations);
const allowed = results.flatMap((result) => result.allowed);

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ violations, allowed }, null, 2));
  process.exit(violations.length === 0 ? 0 : 1);
}

const scanned = `${files.length} files scanned · ${allowed.length} documented exception${allowed.length === 1 ? "" : "s"}`;

if (violations.length === 0) {
  console.log(`✓ RTL gate: no undocumented physical-direction styles (${scanned}).`);
  process.exit(0);
}

console.error(`✗ RTL gate: ${violations.length} physical-direction style(s) found (${scanned}).\n`);
for (const violation of violations) {
  console.error(`  ${violation.path}:${violation.line}`);
  console.error(`    ${violation.class} → use ${violation.fix}`);
  console.error(`    ${violation.source.slice(0, 120)}`);
}
console.error(
  "\nPhysical directions do not flip under dir=\"rtl\". Convert to the logical utility above,\n" +
    "or — if the physical direction is genuinely intentional (chart axes, print layouts, centering\n" +
    "idioms) — document it with an `rtl-allow: <reason>` comment or an entry in\n" +
    "scripts/rtl-allowlist.json.",
);
process.exit(1);
