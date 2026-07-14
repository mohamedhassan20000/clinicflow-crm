#!/usr/bin/env node

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const classLike = /(?:^|\s)(?:(?:sm|md|lg|xl|2xl|hover|focus|dark|print|rtl|ltr|data-[^:]+):|bg-|text-|border-|flex|grid|block|hidden|h-|w-|p[trblxyse]?-|m[trblxyse]?-|rounded|shadow|ring-|items-|justify-|gap-)/;
let restored = 0;

// Earlier provisional extraction could wrap an already translated branch as `t(t("key"))`.
// This is always invalid at runtime: the inner call returns copy, not a message key.
for (const root of ["app", "components"]) {
  let paths = "";
  try {
    paths = execFileSync("rg", ["-l", "t\\(t\\(\\\"", root], { encoding: "utf8" });
  } catch (error) {
    paths = error.stdout ?? "";
  }
  for (const path of paths.trim().split("\n").filter(Boolean)) {
    const source = readFileSync(path, "utf8");
    const next = source
      .replace(/t\(t\("([^"]+)"\)\)/g, 't("$1")')
      .replace(/t\(t\("([^"]+)"\),/g, 't("$1",');
    if (next !== source) writeFileSync(path, next);
  }
}

for (const fragment of readdirSync(".p2c-messages").filter((file) => file.endsWith(".json"))) {
  const messages = JSON.parse(readFileSync(`.p2c-messages/${fragment}`, "utf8"));
  let changed = false;
  for (const [key, value] of Object.entries(messages)) {
    if (typeof value !== "string" || !classLike.test(value)) continue;
    let paths = "";
    try {
      paths = execFileSync("rg", ["-l", `t\\(\"${key}\"\\)`, "app", "components"], { encoding: "utf8" });
    } catch (error) {
      paths = error.stdout ?? "";
    }
    for (const path of paths.trim().split("\n").filter(Boolean)) {
      const source = readFileSync(path, "utf8");
      const next = source.replaceAll(`t("${key}")`, JSON.stringify(value));
      if (next !== source) {
        writeFileSync(path, next);
        restored += 1;
      }
    }
    delete messages[key];
    changed = true;
  }
  if (changed) writeFileSync(`.p2c-messages/${fragment}`, `${JSON.stringify(messages, null, 2)}\n`);
}

console.log(`Restored ${restored} class/style expressions.`);
