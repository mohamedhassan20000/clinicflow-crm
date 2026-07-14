#!/usr/bin/env node
// P2B logical-properties codemod (AI_AGENT_PLAN §4.2 step 2).
//
// Rewrites physical-direction Tailwind utilities to their logical equivalents
// (ml- → ms-, pr- → pe-, left- → start-, text-right → text-end, border-l → border-s,
// rounded-tl → rounded-ss, …) so every layout flips correctly under `dir="rtl"`.
//
// It runs shadcn's *own* RTL transformer — the identical AST pass the CLI applies when
// `components.json` has `"rtl": true` and a component is (re-)added. Reusing it, rather than
// re-implementing the mapping, is what lets `components/ui/*` be converted **in place**:
// `shadcn add --overwrite` would apply this same transform but would also discard the local
// customizations those primitives carry (table.tsx's shared treatment, sheet.tsx's icon swap,
// button.tsx's variants). Transforming in place is the same rewrite with the customizations kept.
//
// One deliberate departure from the CLI, applied as a post-pass — see stripDoubleFlips().
//
// Usage:
//   node scripts/rtl-codemod.mjs [--dry] [path ...]

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_DIRS = ["app", "components", "contexts", "hooks", "lib"];
const SKIP_DIRS = new Set(["node_modules", ".next", "fonts"]);

/**
 * shadcn does not export its RTL transformer publicly, and the chunk it lives in is named by
 * content hash — so locate it by a marker from its mapping table rather than by filename. If a
 * shadcn upgrade moves or renames it, this throws instead of silently converting nothing.
 */
async function loadShadcnTransformRtl() {
  const dist = join(ROOT, "node_modules/shadcn/dist");
  const marker = '["ml-","ms-"]';
  const chunk = readdirSync(dist)
    .filter((f) => f.startsWith("chunk-") && f.endsWith(".js"))
    .find((f) => readFileSync(join(dist, f), "utf8").includes(marker));

  if (!chunk) {
    throw new Error(
      "Could not locate shadcn's RTL transformer (no dist chunk contains the class-mapping table).\n" +
        "shadcn was probably upgraded. Re-check the transformer's export before trusting this codemod.",
    );
  }

  const mod = await import(pathToFileURL(join(dist, chunk)).href);
  const transform = mod.e;
  if (typeof transform !== "function") {
    throw new Error(`shadcn's RTL transformer is not exported as \`e\` from ${chunk} any more.`);
  }
  return transform;
}

const shadcnTransformRtl = await loadShadcnTransformRtl();

/**
 * Tailwind v4 already implements `space-x-*` and `divide-x-*` with `margin-inline-*` /
 * `border-inline-*`, so they flip with `dir` on their own. shadcn's transformer still appends
 * `rtl:space-x-reverse` / `rtl:divide-x-reverse`, which was correct for Tailwind v3 (physical
 * `margin-left`) but in v4 sets `--tw-*-reverse: 1` on top of an already-flipped property — a
 * double flip that moves the gap to the wrong side of every child. Verified against compiled
 * v4.2.2 output. We drop those tokens.
 */
function stripDoubleFlips(source) {
  return source.replace(/\s+rtl:(space|divide)-x-reverse\b/g, "");
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const targets = args.filter((arg) => !arg.startsWith("--"));

const files = (targets.length > 0 ? targets.map((t) => join(ROOT, t)) : DEFAULT_DIRS.map((d) => join(ROOT, d)))
  .filter((target) => existsSync(target))
  .flatMap((target) => (statSync(target).isDirectory() ? walk(target) : [target]));

let changed = 0;

for (const file of files) {
  const before = readFileSync(file, "utf8");
  const after = stripDoubleFlips(await shadcnTransformRtl(before, true));
  if (after === before) continue;

  changed++;
  console.log(`${dry ? "would rewrite" : "rewrote"}  ${relative(ROOT, file).split(sep).join("/")}`);
  if (!dry) writeFileSync(file, after);
}

console.log(`\n${dry ? "Would rewrite" : "Rewrote"} ${changed} of ${files.length} file(s).`);
