#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";

const source = execFileSync("git", ["show", "HEAD:lib/marketing-copy.ts"], { encoding: "utf8" });
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const commonJsModule = { exports: {} };
new Function("exports", "module", compiled)(commonJsModule.exports, commonJsModule);
const recovered = commonJsModule.exports.marketingCopy;

recovered.proof.progress = "{accepted} of {limit} clinic spots taken this week";
recovered.footer.copyright = "© {year} ClinicFlow";

const path = "messages/en.json";
const catalog = JSON.parse(readFileSync(path, "utf8"));
catalog.marketing = { ...recovered, ...(catalog.marketing ?? {}) };
writeFileSync(path, `${JSON.stringify(catalog, null, 2)}\n`);
console.log("Recovered the reviewed English marketing source from HEAD.");
