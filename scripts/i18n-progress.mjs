#!/usr/bin/env node
// P2C working tool: groups the i18n gate's findings by area, so the extraction can be worked down
// surface by surface instead of file by file. Not a CI gate — `check-i18n-strings.mjs` is the gate.
import { execFileSync } from "node:child_process";

let raw = "";
try {
  raw = execFileSync("node", ["scripts/check-i18n-strings.mjs", "--json"], { encoding: "utf8" });
} catch (error) {
  raw = error.stdout ?? "";
}

const { violations } = JSON.parse(raw);
const byFile = new Map();
for (const v of violations) byFile.set(v.path, (byFile.get(v.path) ?? 0) + 1);

const byArea = new Map();
for (const [path, count] of byFile) {
  const area = path.split("/").slice(0, 2).join("/");
  byArea.set(area, (byArea.get(area) ?? 0) + count);
}

console.log(`TOTAL ${violations.length} strings in ${byFile.size} files\n`);
for (const [area, count] of [...byArea].sort((a, b) => b[1] - a[1])) {
  console.log(String(count).padStart(5), area);
}
console.log("\n--- files ---");
for (const [path, count] of [...byFile].sort((a, b) => b[1] - a[1])) {
  console.log(String(count).padStart(5), path);
}
