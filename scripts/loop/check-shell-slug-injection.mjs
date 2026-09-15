#!/usr/bin/env node
/**
 * check-shell-slug-injection (shell-slug-injection guard)
 *
 * Deterministic (grep/AST-shaped) guard for the shell-injection-via-untrusted-
 * repo-metadata class: a remote-derived or repo-slug value interpolated into a
 * shell-command string (a `bash -lc` / shell-string sink) without first passing
 * a charset validator (`isCleanRepoSlug` / `normalizeGitHubRepoSlug`) or being
 * passed via an argument-vector API. Soft reviewer judgment missed this class
 * repeatedly; per "conformance needs deterministic checks, not soft retro
 * judgment" this is the mechanical complement to the reviewer-calibration lens.
 *
 * A finding is raised when ALL hold for one template literal:
 *  1. it interpolates a slug/remote-derived expression — any identifier-path in the
 *     interpolation has a segment matching SLUG_TOKEN_RE (so a transform like
 *     `slug.trim()` or `remoteUrl.split(':')[1]` still counts, keyed on the dotted
 *     path through that segment, e.g. `slug`, `remoteUrl`), and
 *  2. it is shell-command-shaped (contains a `bash -lc` marker, or is assigned
 *     to / passed as a `*command`/`*cmd` value, or is a direct argument to an
 *     exec/spawn/runCommand sink), and
 *  3. that full dotted path is NOT proven clean in the same file — no
 *     `isCleanRepoSlug(<that same full path>)` guard and no
 *     `normalizeGitHubRepoSlug(...)` assignment target with that full path.
 *
 * An arg-vector value (`spawn(cmd, ['--repo', slug])`) is never interpolated
 * into a shell string, so it never trips condition 2 — the safe alternative.
 *
 * Pure computation (no fs) lives in `computeShellSlugInjection`; the fs-side
 * wrapper is `evaluateShellSlugInjection`, mirroring the check-* family.
 */
import fs from "node:fs";
import path from "node:path";

// An identifier segment naming a remote-derived / repo-slug value. `repoSlug`,
// `managedSlug`, `slug`, `remoteUrl`, `originUrl` all match; `prNumber`,
// `SCRIPT`, `verb` do not. `slugValuePathsOf` tests EVERY segment of every
// identifier-path in an interpolation against this, so an inline transform
// (`${slug.trim()}`, `${remoteUrl.split(':')[1]}`) is still caught. Candidacy
// only — a value proven clean is exempted below.
const SLUG_TOKEN_RE = /(?:slug|remoteurl|remoteoriginurl|originurl)$/iu;

// A shell-exec marker inside the literal itself: `bash -lc`, `sh -c`, or a bare
// `-lc` flag anywhere in the command string.
const SHELL_LITERAL_RE = /\b(?:bash|sh)\b[^`]*?-l?c\b|(?:^|\s)-lc\b/u;

// The literal is assigned to / is the value of a `*command`/`*cmd` binding.
const COMMAND_NAME_CTX_RE = /[A-Za-z_$][\w$]*(?:[Cc]ommand|[Cc]md)\s*[:=]\s*(?:await\s+)?$/u;

// The literal is a direct argument to a shell-exec sink: `exec`/`execSync` (child_process
// runs the string through a shell) or the object-form `runCommand({ command: ... })` used by
// extension/post-merge-update.ts. `spawn`/`spawnSync`/`execFile`/`execFileSync` and the
// positional `runCommand(cmd, args)` (packages/core/src/cli/primitives.mjs) are argv APIs —
// the safe alternative this guard steers toward — and are deliberately NOT sinks here.
// ponytail: `spawn(cmd, args, {shell:true})` opts back into a shell and is unflagged; a
// fail-safe ceiling, not a taint tracker for an options bag.
const SINK_CTX_RE = /\b(?:exec|execSync)\s*\(\s*$|\brunCommand\s*\(\s*\{\s*command\s*:\s*$/u;

// A value proven clean in the file: passed to the charset validator, or bound
// from the normalizer (which returns a clean `owner/name` or null).
const GUARD_CALL_RE = /isCleanRepoSlug\(\s*([A-Za-z_$][\w$.]*)/gu;
const NORMALIZE_ASSIGN_RE = /([A-Za-z_$][\w$]*)\s*[:=]\s*(?:await\s+)?normalizeGitHubRepoSlug\(/gu;

export const SAFE_ALTERNATIVE =
  "guard the value with isCleanRepoSlug(...) (fail closed on a non-clean slug) before interpolating, " +
  "or pass it as an argument-vector element (e.g. spawn(cmd, ['--repo', slug])) instead of a shell string";

// Every identifier-path (dotted chain) in an interpolation expression, e.g.
// `slug.trim()` -> "slug.trim", `remoteUrl.split(':')[1]` -> "remoteUrl.split".
const IDENTIFIER_PATH_RE = /[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/gu;

/**
 * Every "slug value path" in an interpolation expression: for each dotted
 * identifier-path with a segment matching SLUG_TOKEN_RE, the prefix from the
 * start through the first matching segment (so a trailing transform call like
 * `.trim()` or `.toLowerCase()` does not change the value identity used for
 * the guard-set lookup).
 */
function slugValuePathsOf(expr) {
  const out = [];
  for (const m of expr.matchAll(IDENTIFIER_PATH_RE)) {
    const segs = m[0].split(".");
    const idx = segs.findIndex((seg) => SLUG_TOKEN_RE.test(seg));
    if (idx !== -1) out.push(segs.slice(0, idx + 1).join("."));
  }
  return out;
}

/**
 * Extract every top-level template literal with its raw text and start index.
 * Tracks `${…}` interpolation brace depth so an inner `}` does not close the
 * literal early. ponytail: nested template literals inside an interpolation are
 * out of scope (command builders do not nest); a lone backtick in a `${}` would
 * end the scan span, which only ever loses a finding, never invents one.
 */
export function extractTemplateLiterals(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "`") continue;
    const start = i;
    let depth = 0;
    let j = i + 1;
    for (; j < text.length; j++) {
      const c = text[j];
      if (c === "\\") { j++; continue; }
      if (depth === 0 && c === "`") break;
      if (c === "$" && text[j + 1] === "{") { depth++; j++; continue; }
      if (depth > 0 && c === "}") depth--;
    }
    out.push({ raw: text.slice(start, j + 1), start });
    i = j;
  }
  return out;
}

// Full dotted paths proven clean in the file (isCleanRepoSlug(<path>) argument, or a
// normalizeGitHubRepoSlug(...) assignment target) — keyed on the whole path, not just
// its last segment, so an unrelated value sharing a last segment (e.g. `evil.repoSlug`
// next to a guarded `safe.repoSlug`) is never wrongly exempted.
// ponytail: file-scoped, not flow/scope-scoped — a `slug` guarded in one function
// exempts a same-named `slug` in another function of the same file. Closing that needs
// scope analysis (the no-taint-framework non-goal); it only ever under-detects.
function guardedTokens(text) {
  const tokens = new Set();
  for (const m of text.matchAll(GUARD_CALL_RE)) tokens.add(m[1]);
  for (const m of text.matchAll(NORMALIZE_ASSIGN_RE)) tokens.add(m[1]);
  return tokens;
}

// Line-preserving comment stripper: blanks `//` and `/* */` comment bytes to spaces
// (every newline kept in place, string/template literals left untouched) so a guard or
// sink mention living only in a comment can never populate the guard set or fake a
// sink match — the fail-open class. Ports the non-line-preserving stripSourceComments in
// scripts/docs/validate-rule-ownership.mjs. Quote-aware (unlike that port) because this
// module's own scan roots have live template literals containing `https://...` — a naive
// scanner would read that `//` as a comment and blank the rest of the line, including the
// literal's own closing backtick, corrupting extractTemplateLiterals' balance scan.
// ponytail: a guard/sink mention inside a STRING literal (not a comment) is still a
// residual, contrived ceiling — closing it needs a string-aware taint lexer (the
// no-taint-framework non-goal rules that out).
function stripComments(text) {
  let out = "";
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") {
        out += c;
        i++;
        if (i < text.length) out += text[i];
        continue;
      }
      out += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      quote = c;
      out += c;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      let j = i;
      while (j < text.length && text[j] !== "\n") { out += " "; j++; }
      i = j - 1;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      let j = i;
      for (; j < stop; j++) out += text[j] === "\n" ? "\n" : " ";
      i = j - 1;
      continue;
    }
    out += c;
  }
  return out;
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

/**
 * Compute findings for a set of `{ path, text }` source files. Pure — fixtures
 * drive every branch directly.
 * @param {{path: string, text: string}[]} files
 */
export function computeShellSlugInjection(files) {
  const findings = [];
  for (const { path: filePath, text: rawText } of files) {
    // Scan comment-stripped text throughout (guard extraction, sink/shell-shape context,
    // template extraction, line numbers) — see stripComments. Length and newlines are
    // preserved 1:1 with rawText, so every index/line computed below stays accurate.
    const text = stripComments(rawText);
    const guards = guardedTokens(text);
    for (const { raw, start } of extractTemplateLiterals(text)) {
      const before = text.slice(Math.max(0, start - 100), start);
      const shellShaped =
        SHELL_LITERAL_RE.test(raw) || COMMAND_NAME_CTX_RE.test(before) || SINK_CTX_RE.test(before);
      if (!shellShaped) continue;
      // ponytail: `[^}]*` stops at the first `}`, so a slug after an inner `}` within one
      // interpolation is missed (a contrived command shape); it only ever under-detects.
      for (const interp of raw.matchAll(/\$\{([^}]*)\}/gu)) {
        const slugPaths = slugValuePathsOf(interp[1]);
        if (slugPaths.length === 0) continue;
        const unguarded = slugPaths.find((p) => !guards.has(p));
        if (!unguarded) continue; // every slug value path in this interpolation is proven clean
        findings.push({
          path: filePath,
          line: lineOf(text, start),
          expr: interp[1].trim().slice(0, 80),
          token: unguarded,
        });
        break; // one finding per literal is enough to fail it
      }
    }
  }
  if (findings.length === 0) return { ok: true, outcome: "pass", findings, reasons: [] };
  const reasons = findings.map(
    (f) =>
      `${f.path}:${f.line}: slug/remote value \`${f.expr}\` interpolated into a shell-command string ` +
      `without a charset validator (shell-slug-injection guard). Safe alternative: ${SAFE_ALTERNATIVE}.`,
  );
  reasons.push(
    "Shell-slug-injection guard blocked: an untrusted repo-metadata value reaches a shell-string sink " +
      "unsanitized. This is the recurring shell-injection class — fail closed.",
  );
  return { ok: false, outcome: "block", findings, reasons };
}

// Runtime-source roots scanned by the CI contract. Tests and generated mirrors
// are excluded so a fixture or a mirror never trips the repo-wide gate.
const RUNTIME_ROOTS = ["extension", "scripts", "packages"];
const SOURCE_EXT_RE = /\.(?:mjs|cjs|js|ts|mts|cts)$/u;
const EXCLUDED_DIR_RE = /(?:^|\/)(?:node_modules|\.git|\.claude|tmp|dist|coverage)(?:\/|$)/u;
const TEST_FILE_RE = /(?:^|\/)(?:test|__tests__|__fixtures__|fixtures)\/|\.test\.[mc]?[jt]s$/u;

function isRuntimeSourceFile(rel) {
  if (!SOURCE_EXT_RE.test(rel) || EXCLUDED_DIR_RE.test(rel) || TEST_FILE_RE.test(rel)) return false;
  // packages/* ships both src and generated mirrors; only scan src.
  if (rel.startsWith("packages/") && !/(?:^|\/)src\//u.test(rel)) return false;
  return true;
}

function walk(absDir, repoRoot, out) {
  if (!fs.existsSync(absDir)) return out;
  const entries = fs
    .readdirSync(absDir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const abs = path.join(absDir, entry.name);
    const rel = path.relative(repoRoot, abs);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIR_RE.test(`${rel}/`)) walk(abs, repoRoot, out);
    } else if (isRuntimeSourceFile(rel)) {
      out.push({ path: rel, text: fs.readFileSync(abs, "utf8") });
    }
  }
  return out;
}

/** Scan the repository's runtime source and compute findings. */
export function evaluateShellSlugInjection({ repoRoot = process.cwd() } = {}) {
  const files = [];
  for (const root of RUNTIME_ROOTS) walk(path.join(repoRoot, root), repoRoot, files);
  return computeShellSlugInjection(files);
}
