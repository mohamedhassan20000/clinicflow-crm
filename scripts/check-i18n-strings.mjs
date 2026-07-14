#!/usr/bin/env node
// P2C i18n gate: fails when app-owned UI source carries a hardcoded, user-facing English string.
//
// The RTL gate (scripts/check-logical-properties.mjs) is the model here, and the reason is the same:
// a translation is invisible in the locale you develop in. English stays perfect whether the string
// is in the catalog or baked into the JSX, so nothing in an English review, an English snapshot, or
// an English screenshot will ever notice the one label somebody forgot. Arabic notices immediately —
// but only after it has already shipped.
//
// What it flags:
//   • JSX text nodes that read as prose  — <p>Save changes</p>
//   • user-facing string props           — title/label/placeholder/alt/aria-label/description/…
//   • Server Action error / fieldErrors  — return { error: "Failed…" }
//
// What it does not flag (and must not, or the signal drowns):
//   • className / href / src / id / key / role / type / name / testid / variant / size / …
//   • single words that are unambiguously identifiers (kebab-case, camelCase, snake_case, URLs)
//   • anything already inside t(), t.raw(), or a `messages/*.json` import
//
// Exceptions are documented, never silent — an inline `i18n-allow: <reason>` comment on the line or
// the line above, or a file entry in scripts/i18n-allowlist.json. Brand names, technical identifiers
// surfaced verbatim, and untranslated-by-design values (an email address, a currency code) are the
// legitimate cases.
//
// Usage: node scripts/check-i18n-strings.mjs [--json]

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const SCAN_DIRS = ["app", "components", "actions"];
const SKIP_DIRS = new Set(["node_modules", ".next", "fonts"]);
const ALLOW_COMMENT = /i18n-allow\s*:\s*(.+)/;

/**
 * Props whose value a user reads or hears. `alt` and `aria-label` are in here for the same reason as
 * `title`: a screen-reader user on Arabic must not be read an English label.
 */
const TEXT_PROPS = [
  "title",
  "label",
  "placeholder",
  "alt",
  "description",
  "aria-label",
  "aria-description",
  "aria-valuetext",
  "emptyMessage",
  "heading",
  "subtitle",
  "confirmLabel",
  "cancelLabel",
  "successMessage",
  "errorMessage",
  "tooltip",
  "documentName",
  "message",
  "name",
  "submitLabel",
  "caption",
];

const PROP_RULE = new RegExp(`(?:^|\\s)(${TEXT_PROPS.join("|")})=("|{")([^"}]{2,})`, "g");

/**
 * A JSX text node that reads as prose: at least two letters, and either more than one word or a
 * capitalized word. `{value}`, `·`, `—`, `%`, and lone punctuation are structure, not copy.
 */
const JSX_TEXT_RULE = />\s*([A-Za-z][A-Za-z'’,.!?:%()\-\s]{2,})\s*</g;

/**
 * A JSX text node that a formatter has already put on its own line:
 *
 *     <p className="text-xs text-muted-foreground">
 *       Dashboard is always visible.        ← this line
 *     </p>
 *
 * These are the ones that hide. `JSX_TEXT_RULE` needs the angle brackets on the same line to see a
 * text node, so every string Prettier wrapped — which is every string long enough to matter — was
 * invisible to the first version of this gate. Twenty-odd of them were sitting in the settings
 * surface alone.
 *
 * Kept deliberately strict to stay quiet: the whole line must be prose, starting with a capital and
 * ending in a letter or sentence punctuation. No braces, no angle brackets, no `=`, no quotes — any
 * of those mean it is code, not copy.
 */
const JSX_LINE_RULE = /^[A-Z][A-Za-z0-9'’,.!?:;%()\-\s]{3,}[.!?A-Za-z)]$/;

/** Lines that look like a bare prose node but are something else entirely. */
const CODE_LINE = /[<>{}="`|&/\\[\]]|^\s*(\/\/|\*|import|export|const|let|return|case|type)\b/;

/**
 * Toast copy. A toast is not a lesser string — "Patient created successfully" is the only feedback a
 * receptionist gets that the thing they just did worked, and it appears in every mutation path in the
 * product. Left out of the first pass of this gate, and it hid ~90 strings.
 */
const TOAST_RULE = /\btoast\.(?:success|error|info|warning|message)\(\s*"([^"]{3,})"/g;

/** Things that look like prose to a regex but are not: identifiers, paths, and code. */
function isIdentifierish(value) {
  const text = value.trim();
  if (!text) return true;
  if (text === "ClinicFlow") return true; // Product name is intentionally invariant.
  if (text === "Promise") return true; // TypeScript generic, e.g. Promise<ActionResult>
  if (text === "noopener noreferrer") return true; // rel security tokens, not rendered copy
  if (/^[a-z0-9-]+$/.test(text) && !text.includes(" ")) return true; // kebab / single lowercase word
  if (/^[a-z]+[A-Z]/.test(text) && !text.includes(" ")) return true; // camelCase
  if (/^[a-z_]+$/.test(text) && text.includes("_")) return true; // snake_case
  if (/^(https?:|\/|#|mailto:|tel:)/.test(text)) return true; // urls and hrefs
  if (/^(?:blob:|data:|\(function\(\))/.test(text)) return true; // browser protocol / inline bootstrap code
  if (/(?:^|,)(?:image|application)\/[a-z0-9.+-]+(?:,|$)/i.test(text)) return true; // file accept contract
  if (/^(?:\.[a-z0-9]+,?)+$/i.test(text)) return true; // file-extension accept contract
  if (/^[A-Z]{2,5}$/.test(text)) return true; // currency / country codes
  if (!/[a-zA-Z]{2}/.test(text)) return true; // no real word in it
  return false;
}

/** Already sourced from the catalog — the whole point of the gate is that these are fine. */
function isTranslated(line) {
  return /\bt\(|\bt\.raw\(|useTranslations|getTranslations|\bcopy\.|messages\//.test(line);
}

function loadAllowlist() {
  const path = join(ROOT, "scripts/i18n-allowlist.json");
  if (!existsSync(path)) return new Map();
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return new Map(raw.files.map((entry) => [entry.path, entry]));
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

function scanFile(absolute, allowlist) {
  const path = relative(ROOT, absolute).split(sep).join("/");
  const fileAllow = allowlist.get(path);
  if (fileAllow) return { path, violations: [], allowed: [{ path, reason: fileAllow.reason }] };

  const source = readFileSync(absolute, "utf8");
  const lines = source.split("\n");

  const violations = [];
  const allowed = [];

  lines.forEach((line, index) => {
    if (!path.endsWith(".tsx")) return;
    const suppressed =
      ALLOW_COMMENT.test(line) || (index > 0 && ALLOW_COMMENT.test(lines[index - 1]));

    const hits = [];

    PROP_RULE.lastIndex = 0;
    for (const match of line.matchAll(PROP_RULE)) {
      const [, prop, opener, value] = match;
      if (opener === '{"' || isIdentifierish(value)) continue;
      if (isTranslated(line)) continue;
      hits.push({ kind: `${prop}="…"`, text: value.trim() });
    }

    JSX_TEXT_RULE.lastIndex = 0;
    for (const match of line.matchAll(JSX_TEXT_RULE)) {
      const value = match[1];
      if (isIdentifierish(value)) continue;
      if (isTranslated(line)) continue;
      hits.push({ kind: "JSX text", text: value.trim() });
    }

    const bare = line.trim();
    if (!isTranslated(line) && !CODE_LINE.test(bare) && JSX_LINE_RULE.test(bare)) {
      hits.push({ kind: "JSX text (own line)", text: bare });
    }

    TOAST_RULE.lastIndex = 0;
    for (const match of line.matchAll(TOAST_RULE)) {
      hits.push({ kind: "toast", text: match[1] });
    }

    for (const hit of hits) {
      const record = { path, line: index + 1, ...hit, source: line.trim().slice(0, 110) };
      if (suppressed) allowed.push(record);
      else violations.push(record);
    }
  });

  // AST supplement: catches copy hidden in option registries, ternaries/fallbacks, metadata objects,
  // and template literals inside JSX expressions. The original regex gate intentionally remains as
  // a fast, readable first layer; this closes the P2C blind spot discovered during full extraction.
  const ast = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const displayProperties = new Set([
    "label", "title", "description", "message", "text", "placeholder", "emptyMessage",
    "successMessage", "errorMessage", "confirmLabel", "cancelLabel",
    "documentName", "ariaLabel", "name", "submitLabel", "caption",
  ]);
  const seen = new Set(violations.map((item) => `${item.line}:${item.text}`));

  function translatedAncestor(node) {
    for (let current = node.parent; current; current = current.parent) {
      if (ts.isCallExpression(current)) {
        const expression = current.expression.getText(ast);
        if (/^(?:t|\w*T)(?:\.raw)?$/.test(expression)
          || /actionError$/.test(expression)
          || /(?:console\.(?:error|warn|info)|log\w*Error)$/.test(expression)
          || /(?:useTranslations|getTranslations)$/.test(expression)) return true;
      }
      if (ts.isSourceFile(current)) break;
    }
    return false;
  }

  function jsxAncestor(node) {
    for (let current = node.parent; current; current = current.parent) {
      if (ts.isJsxExpression(current) || ts.isJsxElement(current) || ts.isJsxSelfClosingElement(current)) return true;
      if (ts.isFunctionLike(current) || ts.isSourceFile(current)) return false;
    }
    return false;
  }

  function classLike(text) {
    return text.includes("[")
      || /(?:^|\s)(?:(?:sm|md|lg|xl|2xl|hover|focus|dark|print|rtl|ltr|data-[^:]+):|bg-|text-|border-|flex|grid|block|hidden|visible|invisible|sticky|absolute|relative|opacity-|cursor-|pointer-|top-|bottom-|start-|end-|inset-|max-|min-|h-|w-|p[trblxyse]?-|m[trblxyse]?-|rounded|shadow|ring-|items-|justify-|gap-|space-|divide-|font-|size-|truncate|break-|capitalize|animate-|group|aurora-|marketing-)/.test(text)
      || /(?:rgba?\(|color-mix\(|\dpx\b|repeat\(|minmax\(|var\(--|url\(|(?:radial|linear)-gradient\()/.test(text);
  }

  function messageKeyLike(text) {
    return /^(?:validation|error|actionErrors)\.[A-Za-z0-9_.-]+$/.test(text);
  }

  function isActionResultProperty(node) {
    if (!path.startsWith("actions/") || !ts.isPropertyAssignment(node)) return false;
    const name = node.name.getText(ast).replace(/["']/g, "");
    if (name === "error" || name === "fieldErrors") return true;
    for (let current = node.parent; current && !ts.isSourceFile(current); current = current.parent) {
      if (ts.isPropertyAssignment(current)) {
        const ancestorName = current.name.getText(ast).replace(/["']/g, "");
        if (ancestorName === "fieldErrors") return true;
      }
    }
    return false;
  }

  function insideActionResult(node) {
    for (let current = node.parent; current && !ts.isSourceFile(current); current = current.parent) {
      if (isActionResultProperty(current)) return true;
    }
    return false;
  }

  function insideUserCopyCall(node) {
    for (let current = node.parent; current && !ts.isSourceFile(current); current = current.parent) {
      if (ts.isCallExpression(current)) {
        return /^toast\.(?:success|error|info|warning|message)$/.test(current.expression.getText(ast));
      }
    }
    return false;
  }

  function containsRawDiagnostic(node) {
    if (!path.startsWith("actions/") || !ts.isPropertyAssignment(node)) return false;
    const name = node.name.getText(ast).replace(/["']/g, "");
    if (name !== "error") return false;
    const text = node.initializer.getText(ast);
    return /(?:\?\.|\.)message\b/.test(text) && !/actionError\s*\(/.test(text);
  }

  function registryCopy(node) {
    if (ts.isPropertyAssignment(node.parent)
      && node.parent.name.getText(ast) === "value"
      && ts.isObjectLiteralExpression(node.parent.parent)
      && node.parent.parent.properties.some((property) => ts.isPropertyAssignment(property) && property.name.getText(ast) === "key")) {
      return false;
    }
    for (let current = node.parent; current && !ts.isSourceFile(current); current = current.parent) {
      if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) {
        return /(?:OPTIONS|REASONS|LABELS|FEATURES|ITEMS|CARDS|META|COPY)$/i.test(current.name.text);
      }
    }
    return false;
  }

  function addAstViolation(node, text, kind) {
    const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
    if (seen.has(`${line}:${text}`)) return;
    const sourceLine = lines[line - 1] ?? "";
    const suppressed = ALLOW_COMMENT.test(sourceLine)
      || (line > 1 && ALLOW_COMMENT.test(lines[line - 2] ?? ""));
    const record = { path, line, kind, text, source: sourceLine.trim().slice(0, 110) };
    if (suppressed) allowed.push(record);
    else violations.push(record);
    seen.add(`${line}:${text}`);
  }

  function visit(node) {
    if (containsRawDiagnostic(node)) {
      addAstViolation(node.initializer, node.initializer.getText(ast), "raw action diagnostic");
    }
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      && !translatedAncestor(node)
      && !classLike(node.text)
      && !messageKeyLike(node.text)
      && !isIdentifierish(node.text)) {
      const parent = node.parent;
      const property = ts.isPropertyAssignment(parent) ? parent.name.getText(ast) : "";
      const displayProperty = ts.isPropertyAssignment(parent) && displayProperties.has(property);
      const expressionCopy = jsxAncestor(node);
      const actionResultCopy = insideActionResult(node) || isActionResultProperty(parent);
      if (displayProperty || expressionCopy || registryCopy(node) || actionResultCopy) {
        addAstViolation(node, node.text, actionResultCopy ? "action result copy" : "expression copy");
      }
    } else if (ts.isTemplateExpression(node) && !translatedAncestor(node)
      && (jsxAncestor(node) || insideActionResult(node) || insideUserCopyCall(node))) {
      const literalText = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(" ").trim();
      const text = node.getText(ast);
      if (/[A-Za-z]{2}/.test(literalText) && !classLike(literalText) && !isIdentifierish(literalText)) {
        addAstViolation(node, text, "template copy");
      }
    } else if (ts.isJsxText(node)) {
      const text = node.getText(ast).replace(/\s+/g, " ").trim();
      const semanticText = text.replace(/&(?:apos|amp|ldquo|rdquo|quot|nbsp);/g, "").trim();
      if (/[A-Za-z]{2}/.test(semanticText)) addAstViolation(node, text, "mixed JSX text");
    } else if (ts.isCallExpression(node)) {
      const expression = node.expression.getText(ast);
      const first = node.arguments[0];
      const hardcodedLocale = first && ts.isStringLiteral(first) && /^en(?:-|$)/i.test(first.text)
        && (/(?:toLocaleString|toLocaleDateString|toLocaleTimeString)$/.test(expression)
          || /Intl\.(?:DateTimeFormat|NumberFormat)$/.test(expression));
      if (hardcodedLocale && jsxAncestor(node)) addAstViolation(node, first.text, "hardcoded display locale");
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);

  return { path, violations, allowed };
}

const allowlist = loadAllowlist();
const files = SCAN_DIRS.map((dir) => join(ROOT, dir))
  .filter((dir) => existsSync(dir))
  .flatMap((dir) => walk(dir));
const results = files.map((file) => scanFile(file, allowlist));

const violations = results.flatMap((result) => result.violations);
const allowed = results.flatMap((result) => result.allowed);

// `process.exit()` can truncate a large asynchronous stdout write, so the exit code is set and Node
// is left to drain its own buffers. The JSON form is what the P2C progress tooling reads.
process.exitCode = violations.length === 0 ? 0 : 1;

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify({ violations, allowed }, null, 2)}\n`);
} else {
  const scanned = `${files.length} files scanned · ${allowed.length} documented exception${allowed.length === 1 ? "" : "s"}`;

  if (violations.length === 0) {
    console.log(`✓ i18n gate: no hardcoded user-facing strings (${scanned}).`);
  } else {
    console.error(`✗ i18n gate: ${violations.length} hardcoded user-facing string(s) found (${scanned}).\n`);

    const byFile = new Map();
    for (const violation of violations) {
      if (!byFile.has(violation.path)) byFile.set(violation.path, []);
      byFile.get(violation.path).push(violation);
    }

    for (const [path, hits] of [...byFile].sort((a, b) => b[1].length - a[1].length)) {
      console.error(`  ${path}  (${hits.length})`);
      for (const hit of hits.slice(0, 6)) {
        console.error(`    :${hit.line}  ${hit.kind}  “${hit.text}”`);
      }
      if (hits.length > 6) console.error(`    … and ${hits.length - 6} more`);
    }

    console.error(
      "\nMove the copy into messages/en.json + messages/ar.json and read it with useTranslations()/\n" +
        "getTranslations(). If the string is genuinely not translatable (a brand name, an email address,\n" +
        "a technical identifier the user is meant to see verbatim), document it with an\n" +
        "`i18n-allow: <reason>` comment or an entry in scripts/i18n-allowlist.json.",
    );
  }
}
