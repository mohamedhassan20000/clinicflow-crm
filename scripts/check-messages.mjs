#!/usr/bin/env node

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const mode = process.argv[2] ?? "all";
const catalogs = Object.fromEntries(
  ["en", "ar"].map((locale) => [locale, {
    ...JSON.parse(readFileSync(`messages/${locale}.json`, "utf8")),
    actionErrors: JSON.parse(readFileSync(`messages/action-errors/${locale}.json`, "utf8")),
  }]),
);

function flatten(value, prefix = "", output = new Map()) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => flatten(item, `${prefix}.${index}`, output));
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) flatten(child, prefix ? `${prefix}.${key}` : key, output);
  } else {
    output.set(prefix, value);
  }
  return output;
}

const flattened = Object.fromEntries(Object.entries(catalogs).map(([locale, value]) => [locale, flatten(value)]));
const missing = [];

// Structured raw() lists can legitimately differ by locale when the locale owns its editorial set.
// The existing Arabic marketing FAQ intentionally omits one English-only item; entries still keep
// their renderer-required shape even though the list lengths differ.
const localeVariantArrayPrefixes = [
  "marketing.faq.items",
];
function isLocaleVariantLeaf(key) {
  return localeVariantArrayPrefixes.some((prefix) => key.startsWith(`${prefix}.`));
}

for (const locale of Object.keys(flattened)) {
  for (const key of flattened.en.keys()) {
    if (!flattened[locale].has(key) && !isLocaleVariantLeaf(key)) {
      missing.push(`${locale}: ${key}`);
    }
  }
  for (const key of flattened[locale].keys()) {
    if (!flattened.en.has(key) && !isLocaleVariantLeaf(key)) {
      missing.push(`en: ${key} (present only in ${locale})`);
    }
  }
}

function placeholders(value) {
  if (typeof value !== "string") return "";
  const names = [];

  function matchingBrace(text, start) {
    let depth = 0;
    for (let index = start; index < text.length; index += 1) {
      if (text[index] === "{") depth += 1;
      else if (text[index] === "}" && --depth === 0) return index;
    }
    return -1;
  }

  function topLevelCommas(text) {
    const positions = [];
    let depth = 0;
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] === "{") depth += 1;
      else if (text[index] === "}") depth -= 1;
      else if (text[index] === "," && depth === 0) positions.push(index);
    }
    return positions;
  }

  function collect(text, optionBodies = false) {
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] !== "{") continue;
      const end = matchingBrace(text, index);
      if (end === -1) break;
      const content = text.slice(index + 1, end);
      if (optionBodies) {
        // This brace wraps the copy for one plural/select option. Its contents may still contain
        // real nested placeholders, so recurse at normal message depth.
        collect(content, false);
      } else {
        const commas = topLevelCommas(content);
        const candidate = (commas.length ? content.slice(0, commas[0]) : content).trim();
        if (/^[A-Za-z_]\w*$/.test(candidate)) names.push(candidate);
        if (commas.length >= 2 && /^(?:plural|select|selectordinal)$/.test(
          content.slice(commas[0] + 1, commas[1]).trim(),
        )) {
          collect(content.slice(commas[1] + 1), true);
        }
      }
      index = end;
    }
  }

  collect(value);
  return names.sort().join(",");
}

function invalidPluralSelectors(value) {
  if (typeof value !== "string") return [];
  const issues = [];

  function matchingBrace(text, start) {
    let depth = 0;
    for (let index = start; index < text.length; index += 1) {
      if (text[index] === "{") depth += 1;
      else if (text[index] === "}" && --depth === 0) return index;
    }
    return -1;
  }

  function topLevelCommas(text) {
    const positions = [];
    let depth = 0;
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] === "{") depth += 1;
      else if (text[index] === "}") depth -= 1;
      else if (text[index] === "," && depth === 0) positions.push(index);
    }
    return positions;
  }

  function scan(text) {
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] !== "{") continue;
      const end = matchingBrace(text, index);
      if (end === -1) {
        issues.push("unbalanced braces");
        return;
      }
      const content = text.slice(index + 1, end);
      const commas = topLevelCommas(content);
      if (commas.length >= 2) {
        const type = content.slice(commas[0] + 1, commas[1]).trim();
        if (type === "plural" || type === "selectordinal") {
          const options = content.slice(commas[1] + 1);
          const selectors = [];
          let optionIndex = 0;
          while (optionIndex < options.length) {
            while (/\s/.test(options[optionIndex] ?? "")) optionIndex += 1;
            if (optionIndex >= options.length) break;
            const selectorStart = optionIndex;
            while (optionIndex < options.length && !/[\s{]/.test(options[optionIndex])) optionIndex += 1;
            const selector = options.slice(selectorStart, optionIndex);
            while (/\s/.test(options[optionIndex] ?? "")) optionIndex += 1;
            if (options[optionIndex] !== "{") {
              issues.push(`malformed ${type} option ${selector || "<empty>"}`);
              break;
            }
            const optionEnd = matchingBrace(options, optionIndex);
            if (optionEnd === -1) {
              issues.push(`unbalanced ${type} option ${selector}`);
              break;
            }
            selectors.push(selector);
            if (!/^(?:zero|one|two|few|many|other|=\d+)$/.test(selector)) {
              issues.push(`invalid ${type} selector ${selector}`);
            }
            scan(options.slice(optionIndex + 1, optionEnd));
            optionIndex = optionEnd + 1;
          }
          if (!selectors.includes("other")) issues.push(`${type} is missing other`);
        }
      }
      index = end;
    }
  }

  scan(value);
  return issues;
}

for (const [key, english] of flattened.en) {
  const arabic = flattened.ar.get(key);
  if (placeholders(english) !== placeholders(arabic)) {
    missing.push(`ar: ${key} (ICU placeholders differ from en)`);
  }
  for (const issue of invalidPluralSelectors(english)) missing.push(`en: ${key} (${issue})`);
  for (const issue of invalidPluralSelectors(arabic)) missing.push(`ar: ${key} (${issue})`);
}

function sourceFiles(directory, output = []) {
  for (const entry of readdirSync(directory)) {
    if (["node_modules", ".next", ".git"].includes(entry)) continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, output);
    else if (/\.(?:ts|tsx)$/.test(entry)) output.push(path);
  }
  return output;
}

/** Split a comma-separated list on top-level commas only (ignore nested (), [], {}). */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "(" || character === "[" || character === "{") depth += 1;
    else if (character === ")" || character === "]" || character === "}") depth -= 1;
    else if (character === "," && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

const used = new Set();
// These namespaces are consumed through typed copy builders, structured `raw()` arrays, dynamic
// navigation keys, or the Zod error map. Their individual leaf keys cannot be proven by a lexical
// call scan without incorrectly reporting array members and callback-selected keys as unused.
const dynamicNamespaces = new Set(["language", "validation", "marketing", "legal", "actionErrors"]);
for (const path of ["app", "components", "actions", "lib"].flatMap((directory) => sourceFiles(directory))) {
  const source = readFileSync(path, "utf8");
  const translators = new Map();
  for (const match of source.matchAll(/\bconst\s+(\w+)\s*=\s*(?:await\s+)?(?:useTranslations|getTranslations)\("([^"]+)"\)/g)) {
    translators.set(match[1], match[2]);
  }
  for (const match of source.matchAll(/\bconst\s+(\w+)\s*=\s*(?:await\s+)?getTranslations\(\{[^}]*\bnamespace:\s*"([^"]+)"[^}]*\}\)/g)) {
    translators.set(match[1], match[2]);
  }
  const translationPromises = new Map();
  for (const match of source.matchAll(/\bconst\s+(\w+)\s*=\s*getTranslations\("([^"]+)"\)/g)) {
    translationPromises.set(match[1], match[2]);
  }
  for (const match of source.matchAll(/\bconst\s+(\w+)\s*=\s*await\s+(\w+)\b/g)) {
    const namespace = translationPromises.get(match[2]);
    if (namespace) translators.set(match[1], namespace);
  }
  // Positional destructuring of a `Promise.all([...])` binds each name to the
  // translator returned by the element at the same index, e.g.
  //   const [t, tDocuments] = await Promise.all([
  //     getTranslations("protected"),
  //     getTranslations("documentPlatform.ui"),
  //   ]);
  // Align names to elements by top-level comma so those translators are seen.
  for (const match of source.matchAll(/\bconst\s+\[([^\]]+)\]\s*=\s*await\s+Promise\.all\(\[([\s\S]*?)\]\)/g)) {
    const names = match[1].split(",").map((name) => name.trim());
    const elements = splitTopLevel(match[2]);
    names.forEach((name, index) => {
      const element = elements[index];
      if (!name || !element || translators.has(name)) return;
      const literal = element.match(/(?:useTranslations|getTranslations)\("([^"]+)"\)/)
        ?? element.match(/getTranslations\(\{[^}]*\bnamespace:\s*"([^"]+)"[^}]*\}\)/);
      if (literal) translators.set(name, literal[1]);
    });
  }
  for (const [name, namespace] of translators) {
    const calls = new RegExp(`\\b${name}(?:\\.(?:raw|rich))?\\(([^)]+)\\)`, "g");
    for (const call of source.matchAll(calls)) {
      const literal = call[1].match(/^\s*["'`]([^"'`]+)["'`]/);
      if (!literal) dynamicNamespaces.add(namespace);
      else used.add(`${namespace}.${literal[1]}`);
    }
  }
}

const unused = [...flattened.en.keys()].filter((key) => {
  // A namespace enters `dynamicNamespaces` either from the manual seed (top-level)
  // or from auto-detection when a bound translator is called with a non-literal key
  // (which can be a *nested* namespace, e.g. `documentPlatform.verification`). Honor
  // both by prefix, so a dynamically-keyed nested namespace exempts its own subtree
  // without having to exempt an entire top-level namespace.
  if ([...dynamicNamespaces].some((namespace) => key === namespace || key.startsWith(`${namespace}.`))) {
    return false;
  }
  return ![...used].some((reference) => key === reference || key.startsWith(`${reference}.`));
});
const referencedMissing = [...used].filter((key) => !flattened.en.has(key));
for (const key of referencedMissing) missing.push(`en/ar: ${key} (referenced in source, absent from catalogs)`);

if ((mode === "all" || mode === "missing") && missing.length) {
  console.error(`Missing catalog keys (${missing.length}):\n${missing.join("\n")}`);
  process.exitCode = 1;
} else if (mode === "missing") {
  console.log(
    `✓ message parity: ${flattened.en.size} base leaf messages; declared locale variants are valid.`,
  );
}

if ((mode === "all" || mode === "unused") && unused.length) {
  console.error(`Unused catalog keys (${unused.length}):\n${unused.join("\n")}`);
  process.exitCode = 1;
} else if (mode === "unused") {
  console.log("✓ unused messages: no unreferenced keys.");
}

if (mode === "all" && !process.exitCode) {
  console.log(`✓ message catalogs: ${flattened.en.size} matching leaf messages; no unused keys.`);
}
