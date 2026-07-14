#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";

let raw = "";
try {
  raw = execFileSync("node", ["scripts/check-i18n-strings.mjs", "--json"], { encoding: "utf8" });
} catch (error) {
  raw = error.stdout ?? "";
}

const { violations } = JSON.parse(raw);
const requestedFiles = process.argv.slice(2);
const files = requestedFiles.length ? requestedFiles : [...new Set(violations.map(({ path }) => path))];

function namespaceFor(path) {
  if (path.startsWith("components/")) return path.split("/")[1];
  if (path.startsWith("app/(auth)")) return "auth";
  if (path.startsWith("app/(operator)")) return "operator";
  if (path.startsWith("app/(public)")) return "public";
  return "protected";
}

let completed = 0;
const refused = [];
for (const file of files) {
  const namespace = namespaceFor(file);
  let result = spawnSync(
    "node",
    ["scripts/p2c-extract.mjs", file, namespace, "--write", "--bootstrap"],
    { encoding: "utf8" },
  );
  if (result.status === 3) {
    result = spawnSync("node", ["scripts/p2c-extract.mjs", file, namespace, "--write"], {
      encoding: "utf8",
    });
  }
  if (result.status === 0) completed += 1;
  else refused.push(`${file}: ${(result.stderr || result.stdout).trim()}`);
}

console.log(`Processed ${completed}/${files.length} files.`);
if (refused.length) {
  console.log(`Refused ${refused.length}:`);
  console.log(refused.join("\n"));
  process.exitCode = 1;
}
