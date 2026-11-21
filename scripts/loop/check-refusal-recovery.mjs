#!/usr/bin/env node
/**
 * check-refusal-recovery
 *
 * RECOVERY-COMMAND-REQUIRED: every `ok: false` refusal object in scripts/github,
 * scripts/loop, cli, lib and packages/core/src must carry a `recovery` field.
 * Existing sites without one are tolerated through the per-file baseline in
 * docs/refusal-recovery-baseline.json; any count that differs from the baseline fails.
 *
 * Usage: check-refusal-recovery.mjs [--audit | --write-baseline | --write-audit]
 * shortcut: literals are blanked with a small scanner (regex literals and nested template expressions are not parsed); upgrade to a parser if a false hit appears.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..", "..");
const DIRS = ["scripts/github", "scripts/loop", "cli", "lib", "packages/core/src"];
const BASELINE = "docs/refusal-recovery-baseline.json";
const AUDIT = "docs/refusal-recovery-audit.md";
const AUDIT_TABLE_HEADER = "| Refusal site | recovery |";

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "vendor") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith(".mjs") && !e.name.includes(".test.")) yield p;
  }
}

/** Blank string, template and comment literals (same length, newlines kept) so scanning sees code only. */
export function stripLiterals(src) {
  let out = "";
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    let end = -1;
    if (c === "/" && src[i + 1] === "/") {
      end = src.indexOf("\n", i);
      if (end < 0) end = src.length;
    } else if (c === "/" && src[i + 1] === "*") {
      end = src.indexOf("*/", i + 2);
      end = end < 0 ? src.length : end + 2;
    } else if (c === '"' || c === "'" || c === "`") {
      end = i + 1;
      while (end < src.length && src[end] !== c) end += src[end] === "\\" ? 2 : 1;
      end = Math.min(end + 1, src.length);
    }
    if (end < 0) {
      out += c;
      i++;
    } else {
      out += src.slice(i, end).replace(/[^\n]/g, " ");
      i = end;
    }
  }
  return out;
}

/** True when the object text carries a `recovery` key at depth 1 (`recovery:` or shorthand). */
function hasRecoveryKey(obj) {
  let depth = 0;
  let top = "";
  for (const ch of obj) {
    if (ch === "{") depth++;
    top += depth === 1 ? ch : " ";
    if (ch === "}") depth--;
  }
  return /(?<![\w.$])recovery\s*[:,}]/.test(top);
}

/** Return the enclosing `{...}` object text of the match at `idx`, or "" when unbalanced. */
function enclosingObject(src, idx) {
  let depth = 0;
  let start = -1;
  for (let i = idx; i >= 0; i--) {
    if (src[i] === "}") depth++;
    else if (src[i] === "{" && depth-- === 0) { start = i; break; }
  }
  if (start < 0) return "";
  depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  return "";
}

export function scanRefusals(rootDir = root) {
  const sites = [];
  for (const d of DIRS) {
    let files;
    try {
      files = [...walk(join(rootDir, d))];
    } catch (err) {
      if (err.code === "ENOENT") continue;
      throw err;
    }
    for (const file of files) {
      const src = stripLiterals(readFileSync(file, "utf8"));
      for (const m of src.matchAll(/\bok:\s*false\b/g)) {
        sites.push({
          file: relative(rootDir, file),
          line: src.slice(0, m.index).split("\n").length,
          recovery: hasRecoveryKey(enclosingObject(src, m.index)),
        });
      }
    }
  }
  return sites;
}

export function checkAgainstBaseline(sites, baseline) {
  const counts = {};
  for (const s of sites) if (!s.recovery) counts[s.file] = (counts[s.file] ?? 0) + 1;
  const errors = [];
  for (const f of new Set([...Object.keys(counts), ...Object.keys(baseline)])) {
    const n = counts[f] ?? 0;
    const b = baseline[f];
    if (b === undefined) errors.push(`${f}: ${n} refusal site(s) without \`recovery\` and no baseline entry`);
    else if (n !== b) errors.push(`${f}: ${n} refusal site(s) without \`recovery\`, baseline says ${b}; update the baseline`);
  }
  return errors;
}

function auditTable(sites) {
  const rows = sites.map((s) => `| \`${s.file}:${s.line}\` | ${s.recovery ? "present" : "MISSING"} |`);
  return [AUDIT_TABLE_HEADER, "|---|---|", ...rows].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const sites = scanRefusals();
  if (process.argv.includes("--audit")) {
    console.log(auditTable(sites));
  } else if (process.argv.includes("--write-baseline")) {
    const counts = {};
    for (const s of sites) if (!s.recovery) counts[s.file] = (counts[s.file] ?? 0) + 1;
    writeFileSync(join(root, BASELINE), `${JSON.stringify(counts, null, 2)}\n`);
  } else if (process.argv.includes("--write-audit")) {
    const doc = readFileSync(join(root, AUDIT), "utf8");
    writeFileSync(join(root, AUDIT), `${doc.slice(0, doc.indexOf(AUDIT_TABLE_HEADER))}${auditTable(sites)}\n`);
  } else {
    const baseline = JSON.parse(readFileSync(join(root, BASELINE), "utf8"));
    const errors = checkAgainstBaseline(sites, baseline);
    if (errors.length) {
      console.error(`RECOVERY-COMMAND-REQUIRED violations:\n${errors.join("\n")}`);
      process.exit(1);
    }
    console.log(`refusal recovery check passed (${sites.length} sites)`);
  }
}
