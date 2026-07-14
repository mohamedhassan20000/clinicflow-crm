#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const en = JSON.parse(readFileSync("messages/en.json", "utf8"));
const ar = JSON.parse(readFileSync("messages/ar.json", "utf8"));
const jobs = [];

function prune(source, target) {
  if (!target || typeof target !== "object") return;
  for (const key of Object.keys(target)) {
    if (!(key in source)) delete target[key];
    else if (source[key] && typeof source[key] === "object") prune(source[key], target[key]);
  }
}

function walk(value, target, path = []) {
  if (typeof value === "string") {
    if (typeof target !== "string") jobs.push({ path, value });
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    walk(child, target?.[key], [...path, key]);
  }
}

function setAtPath(root, path, value) {
  let cursor = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index];
    cursor = cursor[key] ??= /^\d+$/.test(path[index + 1] ?? "") ? [] : {};
  }
  cursor[path.at(-1)] = value;
}

async function translate(job) {
  if (/\{[^{}]+,\s*(?:plural|selectordinal|select),/.test(job.value)) {
    throw new Error(`Refusing machine translation of ICU control syntax at ${job.path.join(".")}`);
  }
  const placeholders = [];
  const protectedValue = job.value.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (match) => {
    const token = `ZXQPH${placeholders.length}QXZ`;
    placeholders.push({ token, match });
    return token;
  });
  const { stdout } = await execFileAsync("curl", [
    "-fsS", "--get", "https://translate.googleapis.com/translate_a/single",
    "--data-urlencode", "client=gtx",
    "--data-urlencode", "sl=en",
    "--data-urlencode", "tl=ar",
    "--data-urlencode", "dt=t",
    "--data-urlencode", `q=${protectedValue}`,
  ], { maxBuffer: 1024 * 1024 });
  const payload = JSON.parse(stdout);
  let translated = payload[0].map((part) => part[0]).join("");
  for (const { token, match } of placeholders) translated = translated.replace(token, match);
  return translated;
}

prune(en, ar);
walk(en, ar);
console.log(`Translating ${jobs.length} missing Arabic messages.`);

let cursor = 0;
let completed = 0;
const workers = Array.from({ length: 12 }, async () => {
  while (cursor < jobs.length) {
    const job = jobs[cursor++];
    const translated = await translate(job);
    setAtPath(ar, job.path, translated);
    completed += 1;
    if (completed % 25 === 0) {
      writeFileSync("messages/ar.json", `${JSON.stringify(ar, null, 2)}\n`);
      console.log(`${completed}/${jobs.length}`);
    }
  }
});

await Promise.all(workers);
writeFileSync("messages/ar.json", `${JSON.stringify(ar, null, 2)}\n`);
console.log(`Translated ${completed} messages.`);
