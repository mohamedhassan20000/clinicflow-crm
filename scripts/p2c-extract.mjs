#!/usr/bin/env node
/**
 * Conservative P2C extraction helper.
 *
 * This tool intentionally uses the TypeScript AST. Regex cannot distinguish JSX text from a generic
 * such as `Promise<ActionResult>`, or display strings from identifiers, object keys, and data values.
 * Only three syntax positions are eligible:
 *   1. JSX text nodes;
 *   2. string initializers of explicitly user-facing JSX attributes;
 *   3. the first string argument to a `toast.*(...)` call.
 *
 * The tool never inserts a translator. Every eligible node must be inside a function that already
 * declares `const t = useTranslations("<namespace>")` or
 * `const t = await getTranslations("<namespace>")`. If not, the whole file is refused unchanged so
 * a human can choose the correct client hook or server translator. This all-or-nothing rule prevents
 * partially translated files and out-of-scope `t(...)` calls.
 *
 * Usage: node scripts/p2c-extract.mjs <file> <namespace> [--write]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";

const [, , target, namespace, ...flags] = process.argv;
const write = flags.includes("--write");
const bootstrap = flags.includes("--bootstrap");

if (!target || !namespace) {
  console.error("usage: node scripts/p2c-extract.mjs <file> <namespace> [--write]");
  process.exit(2);
}

const TEXT_PROPS = new Set([
  "title", "label", "placeholder", "alt", "description", "aria-label",
  "aria-description", "emptyMessage", "heading", "subtitle", "tooltip",
]);
const TOAST_METHODS = new Set(["success", "error", "info", "warning", "message"]);
const source = readFileSync(target, "utf8");
const sourceFile = ts.createSourceFile(
  target,
  source,
  ts.ScriptTarget.Latest,
  true,
  target.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
);

if (sourceFile.parseDiagnostics.length > 0) {
  console.error(`REFUSE ${target} — TypeScript parser reported errors`);
  process.exit(1);
}

const fragmentPath = `.p2c-messages/${namespace}.${target.replace(/[\/.]/g, "_")}.json`;
const messages = existsSync(fragmentPath) ? JSON.parse(readFileSync(fragmentPath, "utf8")) : {};
const used = new Map();
const edits = [];
const missingTranslator = new Set();

function toKey(text) {
  const words = text.replace(/[^A-Za-z0-9\s]/g, " ").split(/\s+/).filter(Boolean).slice(0, 6);
  if (words.length === 0) return "text";
  return words.map((word, index) => index === 0
    ? word.toLowerCase()
    : word[0].toUpperCase() + word.slice(1).toLowerCase()).join("");
}

function keyFor(text) {
  if (used.has(text)) return used.get(text);
  const base = toKey(text);
  let key = base;
  let suffix = 2;
  while (Object.hasOwn(messages, key)) key = `${base}${suffix++}`;
  messages[key] = text;
  used.set(text, key);
  return key;
}

function isUserFacingText(text) {
  const normalized = text.replace(/\s+/g, " ").trim();
  return /[A-Za-z]{2}/.test(normalized) && !/^[a-z0-9_-]+$/.test(normalized);
}

function decodeEntities(text) {
  return text
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&")
    .replaceAll("&ldquo;", "“")
    .replaceAll("&rdquo;", "”")
    .replaceAll("&quot;", '"')
    .replaceAll("&nbsp;", " ");
}

function enclosingFunction(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current)) return current;
  }
  return null;
}

function outerComponentFunction(node) {
  let candidate = null;
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current)) candidate = current;
  }
  return candidate;
}

function hasTranslator(fn) {
  if (!fn?.body) return false;
  let found = false;
  function visit(node) {
    if (found || (node !== fn && ts.isFunctionLike(node))) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "t") {
      let initializer = node.initializer;
      if (initializer && ts.isAwaitExpression(initializer)) initializer = initializer.expression;
      if (initializer && ts.isCallExpression(initializer) && ts.isIdentifier(initializer.expression)) {
        const callee = initializer.expression.text;
        const arg = initializer.arguments[0];
        found = (callee === "useTranslations" || callee === "getTranslations")
          && Boolean(arg && ts.isStringLiteral(arg) && arg.text === namespace);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(fn.body);
  return found;
}

function componentName(fn) {
  if (fn?.name && ts.isIdentifier(fn.name)) return fn.name.text;
  if (fn?.parent && ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)) {
    return fn.parent.name.text;
  }
  return "anonymous function";
}

function addEdit(node, text, replacement) {
  const fn = outerComponentFunction(node) ?? enclosingFunction(node);
  if (!hasTranslator(fn)) {
    missingTranslator.add(componentName(fn));
    return;
  }
  edits.push({ start: node.getStart(sourceFile), end: node.getEnd(), replacement });
  keyFor(text);
}

function visit(node) {
  if (ts.isJsxText(node)) {
    const rawText = node.getText(sourceFile).replace(/\s+/g, " ").trim();
    const text = decodeEntities(rawText);
    const standalone = ts.isJsxElement(node.parent)
      && node.parent.children.filter((child) => !(ts.isJsxText(child) && !child.getText(sourceFile).trim())).length === 1;
    // Mixed-content nodes need an explicit ICU/rich-text translation. Translating their individual
    // JSXText fragments would split sentences around expressions or entities and corrupt spacing.
    if (standalone && isUserFacingText(text)) {
      const key = keyFor(text);
      addEdit(node, text, `{t("${key}")}`);
    }
  } else if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer)) {
    const prop = node.name.getText(sourceFile);
    const text = node.initializer.text;
    if (TEXT_PROPS.has(prop) && isUserFacingText(text)) {
      const key = keyFor(text);
      addEdit(node.initializer, text, `{t("${key}")}`);
    }
  } else if (ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression)
    && node.expression.expression.text === "toast"
    && TOAST_METHODS.has(node.expression.name.text)
    && node.arguments[0]
    && ts.isStringLiteral(node.arguments[0])) {
    const arg = node.arguments[0];
    const text = arg.text;
    if (isUserFacingText(text)) {
      const key = keyFor(text);
      addEdit(arg, text, `t("${key}")`);
    }
  } else if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    && isUserFacingText(node.text)
    && enclosingFunction(node)) {
    const parent = node.parent;
    const propertyName = ts.isPropertyAssignment(parent) ? parent.name.getText(sourceFile) : "";
    const isConditionalCopy = ts.isConditionalExpression(parent)
      || (ts.isConditionalExpression(parent.parent) && parent.parent !== parent);
    const isFallbackCopy = ts.isBinaryExpression(parent)
      && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(parent.operatorToken.kind);
    const isDisplayProperty = ts.isPropertyAssignment(parent)
      && ["label", "title", "description", "message", "text", "placeholder"].includes(propertyName);
    if (isConditionalCopy || isFallbackCopy || isDisplayProperty) {
      const key = keyFor(node.text);
      addEdit(node, node.text, `t("${key}")`);
    }
  }
  ts.forEachChild(node, visit);
}

visit(sourceFile);

if (missingTranslator.size > 0) {
  if (bootstrap) {
    const isClient = /^\s*["']use client["'];/m.test(source);
    const translatorImport = isClient ? "useTranslations" : "getTranslations";
    const functions = new Set();

    function collect(node) {
      const jsxText = ts.isJsxText(node)
        ? node.getText(sourceFile).replace(/\s+/g, " ").trim()
        : "";
      const eligibleJsxText = ts.isJsxText(node)
        && !jsxText.includes("&")
        && isUserFacingText(jsxText);
      const eligibleAttribute = ts.isJsxAttribute(node)
        && node.initializer
        && ts.isStringLiteral(node.initializer)
        && TEXT_PROPS.has(node.name.getText(sourceFile))
        && isUserFacingText(node.initializer.text);
      const eligibleToast = ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression)
        && node.expression.expression.text === "toast"
        && TOAST_METHODS.has(node.expression.name.text)
        && node.arguments[0]
        && ts.isStringLiteral(node.arguments[0]);
      if (eligibleJsxText || eligibleAttribute || eligibleToast) {
        const fn = outerComponentFunction(node);
        if (fn && !hasTranslator(fn)) functions.add(fn);
      }
      ts.forEachChild(node, collect);
    }
    collect(sourceFile);

    const bootstrapEdits = [];
    for (const fn of functions) {
      if (!fn.body || !ts.isBlock(fn.body)) continue;
      if (!isClient && !fn.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
        bootstrapEdits.push({
          start: fn.getStart(sourceFile),
          end: fn.getStart(sourceFile),
          replacement: "async ",
        });
      }
      bootstrapEdits.push({
        start: fn.body.getStart(sourceFile) + 1,
        end: fn.body.getStart(sourceFile) + 1,
        replacement: isClient
          ? `\n  const t = useTranslations("${namespace}");`
          : `\n  const t = await getTranslations("${namespace}");`,
      });
    }

    const lastImport = sourceFile.statements.filter(ts.isImportDeclaration).at(-1);
    const importPosition = lastImport?.getEnd() ?? 0;
    bootstrapEdits.push({
      start: importPosition,
      end: importPosition,
      replacement: `\nimport { ${translatorImport} } from "next-intl";`,
    });

    let bootstrapped = source;
    for (const edit of bootstrapEdits.sort((a, b) => b.start - a.start)) {
      bootstrapped = bootstrapped.slice(0, edit.start) + edit.replacement + bootstrapped.slice(edit.end);
    }
    if (write) writeFileSync(target, bootstrapped);
    console.log(`BOOT   ${target} — added ${translatorImport} to ${functions.size} outer function(s); rerun extraction`);
    process.exit(3);
  }
  console.error(
    `REFUSE ${target} — add the correct ${namespace} translator manually in: ${[...missingTranslator].join(", ")}`,
  );
  process.exit(1);
}

if (edits.length === 0) {
  console.log(`SKIP  ${target} — nothing safely extractable`);
  process.exit(0);
}

let result = source;
for (const edit of edits.sort((a, b) => b.start - a.start)) {
  result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
}

console.log(`OK     ${target}  ${edits.length} strings → ${namespace}`);
if (write) {
  mkdirSync(".p2c-messages", { recursive: true });
  writeFileSync(target, result);
  writeFileSync(
    fragmentPath,
    JSON.stringify(messages, null, 2) + "\n",
  );
} else {
  console.log(JSON.stringify({ [namespace]: messages }, null, 2));
}
