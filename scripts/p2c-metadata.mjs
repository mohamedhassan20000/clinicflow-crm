#!/usr/bin/env node

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = `${dir}/${entry}`;
    if (statSync(path).isDirectory()) walk(path, out);
    else if (entry.endsWith(".tsx")) out.push(path);
  }
  return out;
}

function keyFor(title) {
  const words = title.replace(/[^A-Za-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  return `metadata${words.map((word) => word[0].toUpperCase() + word.slice(1).toLowerCase()).join("")}`;
}

function namespaceFor(path) {
  if (path.startsWith("app/(auth)")) return "auth";
  if (path.startsWith("app/(operator)")) return "operator";
  if (path.startsWith("app/(public)")) return "public";
  return "protected";
}

for (const path of walk("app")) {
  let source = readFileSync(path, "utf8");
  const match = source.match(/export const metadata: Metadata = \{ title: "([^"]+)" \};/);
  if (!match) continue;
  const namespace = namespaceFor(path);
  const key = keyFor(match[1]);
  source = source.replace(
    match[0],
    `export async function generateMetadata(): Promise<Metadata> {\n  const t = await getTranslations("${namespace}");\n  return { title: t("${key}") };\n}`,
  );
  if (!source.includes('from "next-intl/server"')) {
    const lastImport = [...source.matchAll(/^import .*;$/gm)].at(-1);
    const position = lastImport ? lastImport.index + lastImport[0].length : 0;
    source = `${source.slice(0, position)}\nimport { getTranslations } from "next-intl/server";${source.slice(position)}`;
  } else if (!source.includes("getTranslations")) {
    throw new Error(`Unexpected next-intl/server import in ${path}`);
  }
  writeFileSync(path, source);
  const fragment = `.p2c-messages/${namespace}.metadata.json`;
  const messages = (() => { try { return JSON.parse(readFileSync(fragment, "utf8")); } catch { return {}; } })();
  messages[key] = match[1];
  writeFileSync(fragment, `${JSON.stringify(messages, null, 2)}\n`);
  console.log(`${path}: ${key}`);
}
