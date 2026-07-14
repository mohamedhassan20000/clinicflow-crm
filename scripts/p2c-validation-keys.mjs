#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";

const files = process.argv.slice(2);
if (!files.length) throw new Error("Pass validation source files.");

const keyByMethod = {
  min: "tooSmall",
  max: "tooBig",
  email: "invalidEmail",
  regex: "invalidFormat",
  refine: "invalidFormat",
  uuid: "invalidFormat",
  int: "invalidType",
  positive: "tooSmall",
  nonnegative: "tooSmall",
};

for (const file of files) {
  const source = readFileSync(file, "utf8");
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const edits = [];

  function replace(node, key) {
    edits.push({ start: node.getStart(ast), end: node.getEnd(), text: `"validation.${key}"` });
  }

  function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const key = keyByMethod[method];
      if (key) {
        const candidate = method === "refine" ? node.arguments[1] : node.arguments.at(-1);
        if (candidate && (ts.isStringLiteral(candidate) || ts.isNoSubstitutionTemplateLiteral(candidate) || ts.isTemplateExpression(candidate))) {
          replace(candidate, key);
        } else if (candidate && ts.isObjectLiteralExpression(candidate)) {
          for (const property of candidate.properties) {
            if (ts.isPropertyAssignment(property)
              && property.name.getText(ast) === "message"
              && (ts.isStringLiteral(property.initializer) || ts.isTemplateExpression(property.initializer))) {
              replace(property.initializer, key);
            }
          }
        }
      }
    }
    if (ts.isPropertyAssignment(node)
      && node.name.getText(ast) === "message"
      && (ts.isStringLiteral(node.initializer) || ts.isTemplateExpression(node.initializer))) {
      replace(node.initializer, "invalidFormat");
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);

  let output = source;
  const uniqueEdits = [...new Map(edits.map((edit) => [`${edit.start}:${edit.end}`, edit])).values()];
  for (const edit of uniqueEdits.sort((a, b) => b.start - a.start)) {
    output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  }
  if (!output.includes('import "@/lib/validations/error-map";')) {
    output = `import "@/lib/validations/error-map";\n${output}`;
  }
  writeFileSync(file, output);
  console.log(`${file}: ${uniqueEdits.length} messages migrated`);
}
