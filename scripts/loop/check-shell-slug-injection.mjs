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
 *  1. it interpolates a slug/remote-derived expression (last identifier segment
 *     matches SLUG_TOKEN_RE), and
 *  2. it is shell-command-shaped (contains a `bash -lc` marker, or is assigned
 *     to / passed as a `*command`/`*cmd` value, or is a direct argument to an
 *     exec/spawn/runCommand sink), and
 *  3. the interpolated value is NOT proven clean in the same file — no
 *     `isCleanRepoSlug(<that value>)` guard and not assigned from
 *     `normalizeGitHubRepoSlug(...)`.
 *
 * An arg-vector value (`spawn(cmd, ['--repo', slug])`) is never interpolated
 * into a shell string, so it never trips condition 2 — the safe alternative.
 *
 * Pure computation (no fs) lives in `computeShellSlugInjection`; the fs-side
 * wrapper is `evaluateShellSlugInjection`, mirroring the check-* family.
 */
import fs from "node:fs";
import path from "node:path";

// Last identifier segment naming a remote-derived / repo-slug value. `repoSlug`,
// `managedSlug`, `slug`, `remoteUrl`, `originUrl` all match; `prNumber`,
// `SCRIPT`, `verb` do not. Candidacy only — a value proven clean is exempted below.
const SLUG_TOKEN_RE = /(?:slug|remoteurl|remoteoriginurl|originurl)$/iu;

// A shell-exec marker inside the literal itself: `bash -lc`, `sh -c`, or a bare
// `-lc` flag anywhere in the command string.
const SHELL_LITERAL_RE = /\b(?:bash|sh)\b[^`]*?-l?c\b|(?:^|\s)-lc\b/u;

// The literal is assigned to / is the value of a `*command`/`*cmd` binding.
const COMMAND_NAME_CTX_RE = /[A-Za-z_$][\w$]*(?:[Cc]ommand|[Cc]md)\s*[:=]\s*(?:await\s+)?$/u;

// The literal is a direct argument to a shell-exec sink.
const SINK_CTX_RE =
  /\b(?:exec|execSync|execFile|execFileSync|spawn|spawnSync|runCommand)\s*\(\s*(?:\{\s*command\s*:\s*)?$/u;

// A value proven clean in the file: passed to the charset validator, or bound
// from the normalizer (which returns a clean `owner/name` or null).
const GUARD_CALL_RE = /isCleanRepoSlug\(\s*([A-Za-z_$][\w$.]*)/gu;
const NORMALIZE_ASSIGN_RE = /([A-Za-z_$][\w$]*)\s*[:=]\s*(?:await\s+)?normalizeGitHubRepoSlug\(/gu;

export const SAFE_ALTERNATIVE =
  "guard the value with isCleanRepoSlug(...) (fail closed on a non-clean slug) before interpolating, " +
  "or pass it as an argument-vector element (e.g. spawn(cmd, ['--repo', slug])) instead of a shell string";

/** Last dotted segment of the first identifier in an interpolation expression. */
function slugTokenOf(expr) {
  const first = expr.trim().match(/[A-Za-z_$][\w$.]*/u)?.[0];
  if (!first) return null;
  const seg = first.split(".").pop();
  return SLUG_TOKEN_RE.test(seg) ? seg : null;
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

function guardedTokens(text) {
  const tokens = new Set();
  for (const m of text.matchAll(GUARD_CALL_RE)) tokens.add(m[1].split(".").pop());
  for (const m of text.matchAll(NORMALIZE_ASSIGN_RE)) tokens.add(m[1].split(".").pop());
  return tokens;
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
  for (const { path: filePath, text } of files) {
    const guards = guardedTokens(text);
    for (const { raw, start } of extractTemplateLiterals(text)) {
      const before = text.slice(Math.max(0, start - 100), start);
      const shellShaped =
        SHELL_LITERAL_RE.test(raw) || COMMAND_NAME_CTX_RE.test(before) || SINK_CTX_RE.test(before);
      if (!shellShaped) continue;
      for (const interp of raw.matchAll(/\$\{([^}]*)\}/gu)) {
        const token = slugTokenOf(interp[1]);
        if (!token || guards.has(token)) continue;
        findings.push({
          path: filePath,
          line: lineOf(text, start),
          expr: interp[1].trim().slice(0, 80),
          token,
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
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
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
