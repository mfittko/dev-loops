#!/usr/bin/env node
/**
 * check-refusal-recovery
 *
 * RECOVERY-COMMAND-REQUIRED: every `ok: false` refusal object in scripts/github,
 * scripts/loop, cli, lib and packages/core/src must carry a `recovery` field.
 * Existing sites without one are tolerated through the per-file baseline in
 * docs/refusal-recovery-baseline.json. The baseline is a ratchet: a file whose count of
 * sites without `recovery` rises fails the check; a count that falls rewrites the baseline.
 *
 * Usage: check-refusal-recovery.mjs [--audit | --write-baseline | --write-audit]
 * shortcut: a `/` starts a regex when the previous token is an operator, open bracket or keyword; upgrade to a parser if a false hit appears.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..", "..");
const DIRS = ["scripts/github", "scripts/loop", "cli", "lib", "packages/core/src"];
const BASELINE = "docs/refusal-recovery-baseline.json";
const AUDIT = "docs/refusal-recovery-audit.md";
export const AUDIT_TABLE_HEADER = "| Refusal site | recovery |";

function* walk(dir) {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === "vendor") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith(".mjs") && !e.name.includes(".test.")) yield p;
  }
}

const REGEX_PREV = new Set([..."(,=:[!&|?{;+-*%<>~^"]);
const REGEX_KEYWORDS = new Set(["return", "typeof", "case", "in", "of", "delete", "void", "throw", "new", "else", "do", "yield", "await"]);

/** Length of the quote literal at `i` (string quote `q`), escapes honored. */
function quoteEnd(src, i, q) {
  let end = i + 1;
  while (end < src.length && src[end] !== q) end += src[end] === "\\" ? 2 : 1;
  return Math.min(end + 1, src.length);
}

/** End of the regex literal at `i`, or -1 when the line ends first (then `/` is a division). */
function regexEnd(src, i) {
  let inClass = false;
  for (let j = i + 1; j < src.length && src[j] !== "\n"; j++) {
    if (src[j] === "\\") j++;
    else if (src[j] === "[") inClass = true;
    else if (src[j] === "]") inClass = false;
    else if (src[j] === "/" && !inClass) {
      j++;
      while (/[a-z]/.test(src[j] ?? "")) j++;
      return j;
    }
  }
  return -1;
}

/**
 * Blank string, regex, comment and template text (same length, newlines kept) so scanning sees code only.
 * `${...}` template expressions stay code; their `${` and closing `}` are blanked to keep braces balanced.
 */
export function stripLiterals(src) {
  let out = "";
  const blank = (a, b) => { out += src.slice(a, b).replace(/[^\n]/g, " "); };
  const stack = []; // brace depth of the code context that a template expression interrupted
  let depth = 0;
  let last = ""; // last significant code char; "v" after a literal (value, so `/` divides)
  let word = "";
  const templateText = (from) => {
    let j = from;
    while (j < src.length && src[j] !== "`" && !(src[j] === "$" && src[j + 1] === "{")) j += src[j] === "\\" ? 2 : 1;
    j = Math.min(j, src.length);
    blank(from, j);
    if (src[j] === "$") { blank(j, j + 2); stack.push(depth); depth = 0; return j + 2; }
    blank(j, j + 1);
    last = "v";
    return j + 1;
  };
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      const end = nl < 0 ? src.length : nl;
      blank(i, end);
      i = end;
    } else if (c === "/" && src[i + 1] === "*") {
      const e = src.indexOf("*/", i + 2);
      const end = e < 0 ? src.length : e + 2;
      blank(i, end);
      i = end;
    } else if (c === '"' || c === "'") {
      const end = quoteEnd(src, i, c);
      blank(i, end);
      i = end;
      last = "v";
    } else if (c === "`") {
      blank(i, i + 1);
      i = templateText(i + 1);
    } else if (c === "/" && (REGEX_PREV.has(last) || last === "" || (last === "w" && REGEX_KEYWORDS.has(word))) && regexEnd(src, i) > 0) {
      const end = regexEnd(src, i);
      blank(i, end);
      i = end;
      last = "v";
    } else if (c === "}" && depth === 0 && stack.length) {
      blank(i, i + 1);
      depth = stack.pop();
      i = templateText(i + 1);
    } else {
      if (c === "{") depth++;
      else if (c === "}") depth--;
      out += c;
      i++;
      if (/[\w$]/.test(c)) { word = /[\w$]/.test(src[i - 2] ?? "") ? word + c : c; last = "w"; }
      else if (!/\s/.test(c)) { word = ""; last = c; }
    }
  }
  return out;
}

/** True when the object text carries a `recovery` key at depth 1 (`recovery:` or shorthand) in key position. */
function hasRecoveryKey(obj) {
  let depth = 0;
  let top = "";
  for (const ch of obj) {
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    top += depth === 1 ? ch : " ";
    if (ch === "}" || ch === "]" || ch === ")") depth--;
  }
  return /[{,]\s*recovery\s*(?::|(?=[,}]))/.test(top);
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

/** Per-file count of refusal sites without `recovery`, keys in scan order. */
export function missingCounts(sites) {
  const counts = {};
  for (const s of sites) if (!s.recovery) counts[s.file] = (counts[s.file] ?? 0) + 1;
  return counts;
}

/** Ratchet: errors only for a file whose count rose above its baseline (or has no entry). A fall is not an error. */
export function checkAgainstBaseline(sites, baseline) {
  const errors = [];
  for (const [f, n] of Object.entries(missingCounts(sites))) {
    const b = baseline[f];
    if (b === undefined) errors.push(`${f}: ${n} refusal site(s) without \`recovery\` and no baseline entry`);
    else if (n > b) errors.push(`${f}: ${n} refusal site(s) without \`recovery\`, baseline caps it at ${b}; add \`recovery\` to the new site`);
  }
  return errors;
}

/** Replace the audit table in `doc` with `table`; null when the table header is missing. */
export function spliceAudit(doc, table) {
  const at = doc.indexOf(AUDIT_TABLE_HEADER);
  return at < 0 ? null : `${doc.slice(0, at)}${table}\n`;
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
    writeFileSync(join(root, BASELINE), `${JSON.stringify(missingCounts(sites), null, 2)}\n`);
  } else if (process.argv.includes("--write-audit")) {
    const next = spliceAudit(readFileSync(join(root, AUDIT), "utf8"), auditTable(sites));
    if (next === null) {
      console.error(`${AUDIT}: table header "${AUDIT_TABLE_HEADER}" not found; audit left unchanged`);
      process.exit(1);
    }
    writeFileSync(join(root, AUDIT), next);
  } else {
    const baseline = JSON.parse(readFileSync(join(root, BASELINE), "utf8"));
    const errors = checkAgainstBaseline(sites, baseline);
    if (errors.length) {
      console.error(`RECOVERY-COMMAND-REQUIRED violations:\n${errors.join("\n")}`);
      process.exit(1);
    }
    const counts = missingCounts(sites);
    if (JSON.stringify(counts) !== JSON.stringify(baseline)) {
      writeFileSync(join(root, BASELINE), `${JSON.stringify(counts, null, 2)}\n`);
      console.log(`${BASELINE} lowered to the current counts; commit it`);
    }
    console.log(`refusal recovery check passed (${sites.length} sites)`);
  }
}
