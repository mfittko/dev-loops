#!/usr/bin/env node
/**
 * check-refusal-recovery
 *
 * RECOVERY-COMMAND-REQUIRED: every `ok: false` refusal object in scripts/github,
 * scripts/loop and cli must carry a `recovery` field. Existing sites without one
 * are tolerated through the per-file baseline in
 * docs/refusal-recovery-baseline.json; a count above the baseline fails.
 *
 * Usage: check-refusal-recovery.mjs [--audit]   (--audit prints the audit table)
 * shortcut: brace matching ignores braces inside string literals; upgrade to a parser if a false hit appears.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..", "..");
const DIRS = ["scripts/github", "scripts/loop", "cli"];
const BASELINE = "docs/refusal-recovery-baseline.json";

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "vendor") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith(".mjs") && !e.name.includes(".test.")) yield p;
  }
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
    for (const file of walk(join(rootDir, d))) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/\bok:\s*false\b/g)) {
        const obj = enclosingObject(src, m.index);
        sites.push({
          file: relative(rootDir, file),
          line: src.slice(0, m.index).split("\n").length,
          recovery: /\brecovery\w*\b/.test(obj),
        });
      }
    }
  }
  return sites;
}

export function checkAgainstBaseline(sites, baseline) {
  const counts = {};
  for (const s of sites) if (!s.recovery) counts[s.file] = (counts[s.file] ?? 0) + 1;
  return Object.entries(counts)
    .filter(([f, n]) => n > (baseline[f] ?? 0))
    .map(([f, n]) => `${f}: ${n} refusal site(s) without \`recovery\`, baseline allows ${baseline[f] ?? 0}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const sites = scanRefusals();
  if (process.argv.includes("--audit")) {
    const rows = sites.map((s) => `| \`${s.file}:${s.line}\` | ${s.recovery ? "present" : "MISSING"} |`);
    console.log(["| Refusal site | recovery |", "|---|---|", ...rows].join("\n"));
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
