#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";

for (const file of process.argv.slice(2)) {
  let source = readFileSync(file, "utf8");
  if (!source.includes(".error.flatten().fieldErrors")) continue;
  source = source.replace(/([A-Za-z_$][\w$]*)\.error\.flatten\(\)\.fieldErrors/g, "await localizeZodFieldErrors($1.error)");
  if (!source.includes('from "@/lib/validations/server"')) {
    const directive = source.match(/^"use server";\n/);
    const position = directive?.[0].length ?? 0;
    source = `${source.slice(0, position)}\nimport { localizeZodFieldErrors } from "@/lib/validations/server";${source.slice(position)}`;
  }
  writeFileSync(file, source);
  console.log(file);
}
