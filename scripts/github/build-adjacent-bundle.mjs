#!/usr/bin/env node
/**
 * build-adjacent-bundle.mjs — deterministic, neutral adjacent-code bundle builder.
 *
 * Runs ONCE and emits a NEUTRAL bundle every independent gate reviewer
 * is seeded with verbatim, instead of each reviewer re-deriving the diff +
 * adjacent code from scratch. Deterministic because it's a script, not an
 * agent: identical (head + changed files) input always produces an identical
 * bundle (sorted file list, stable JSON shape) with no editorializing.
 *
 * Bundle contents: for each changed JS/.mjs/.cjs file, the files it imports
 * (1-hop out-edges) and the files that import it (1-hop in-edges, via a
 * repo-wide import scan).
 *
 * Size guards (record, never silently drop): lockfiles/generated trees/binary/
 * minified files are recorded in `stripped` with a reason; over-cap files
 * (default ~48KB) are truncated and recorded in `truncated` with byte counts.
 *
 * Output is purely structural adjacency — no opinion, verdict, or main-agent
 * state — so seeding a reviewer with it is the intended neutral seed (RFC-2),
 * not contamination. Output shape and role/relatedTo semantics are documented
 * on {@link buildAdjacentBundle} below.
 */
import { lstat, open, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

/** Default per-file byte cap before truncation. */
export const DEFAULT_MAX_FILE_BYTES = 48 * 1024;

/**
 * Binary-sniff window: the NUL-byte heuristic inspects this many leading bytes.
 * The guarded read must cover at least this window even when the per-file cap is
 * configured smaller, so a small cap can't cause a binary (whose first NUL is
 * past the cap) to be misclassified as text.
 */
const BINARY_SNIFF_BYTES = 8 * 1024;

/** Source extensions we resolve import edges for (JS family, this repo). */
const SOURCE_EXTENSIONS = [".mjs", ".js", ".cjs"];

/** Directory prefixes treated as generated / vendored and skipped. */
const GENERATED_DIR_PREFIXES = [
  "dist/",
  "node_modules/",
  "coverage/",
  ".git/",
];

/**
 * Classify why a file is skipped from the bundle, or null when it is includable.
 * Deterministic, path-shape based. Exported for tests.
 * @param {string} relPath — repo-relative POSIX path
 * @returns {"lockfile"|"generated"|"binary"|"minified"|null}
 */
export function classifyStripReason(relPath) {
  const posix = String(relPath).replace(/\\/g, "/");
  const base = posix.split("/").pop() ?? posix;

  if (base === "bun.lock" || base === "package-lock.json" || base === "npm-shrinkwrap.json" || /-lock\.ya?ml$/.test(base) || base === "yarn.lock" || base === "pnpm-lock.yaml") {
    return "lockfile";
  }
  for (const prefix of GENERATED_DIR_PREFIXES) {
    if (posix === prefix.slice(0, -1) || posix.startsWith(prefix) || posix.includes(`/${prefix}`)) {
      return "generated";
    }
  }
  if (/\.min\.[a-z0-9]+$/i.test(base)) return "minified";
  if (isBinaryPath(base)) return "binary";
  return null;
}

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".pdf",
  ".zip", ".gz", ".tgz", ".tar", ".bz2", ".7z", ".rar",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".mp3", ".mp4", ".mov", ".avi", ".wav", ".ogg", ".webm",
  ".so", ".dylib", ".dll", ".exe", ".bin", ".wasm", ".class", ".o", ".a",
  ".node", ".lockb",
]);

function isBinaryPath(base) {
  const dot = base.lastIndexOf(".");
  if (dot < 0) return false;
  return BINARY_EXTENSIONS.has(base.slice(dot).toLowerCase());
}

/**
 * Heuristic binary-content sniff: a NUL byte within the first 8KB marks the
 * file as binary regardless of extension (covers extension-less binaries).
 * @param {Buffer} buf
 * @returns {boolean}
 */
function looksBinaryContent(buf) {
  const limit = Math.min(buf.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/**
 * Extract the static import/require specifiers from JS source text.
 * Deterministic regex scan (no execution). Captures:
 *   - import ... from "x"        / export ... from "x"
 *   - import("x")                (dynamic import)
 *   - require("x")
 * Returns specifiers in a deterministic, grouped-by-kind order — each kind is
 * scanned in its own pass (export/import-from → bare side-effect import →
 * dynamic import() → require()), so the output is grouped by form rather than
 * by position in the source. De-duplicated (first occurrence wins).
 * @param {string} source
 * @returns {string[]}
 */
export function extractImportSpecifiers(source) {
  if (typeof source !== "string" || source.length === 0) return [];
  const specs = [];
  const seen = new Set();
  const push = (s) => {
    if (typeof s === "string" && s.length > 0 && !seen.has(s)) {
      seen.add(s);
      specs.push(s);
    }
  };
  // import ... from "x" | export ... from "x"
  const fromRe = /\b(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/g;
  // bare side-effect import "x"
  const bareRe = /\bimport\s+['"]([^'"]+)['"]/g;
  // dynamic import("x")
  const dynRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  // require("x")
  const reqRe = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const re of [fromRe, bareRe, dynRe, reqRe]) {
    let m;
    while ((m = re.exec(source)) !== null) push(m[1]);
  }
  return specs;
}

/**
 * Resolve a RELATIVE import specifier (./ or ../) from a source file to a
 * repo-relative POSIX path, trying common extensions and index files.
 * Bare/package specifiers (no leading dot) are NOT resolved (out of repo).
 * Pure path math against the provided existing-files set — deterministic.
 * @param {string} fromRelPath — repo-relative path of the importing file
 * @param {string} specifier
 * @param {Set<string>} existing — set of repo-relative POSIX paths that exist
 * @returns {string|null}
 */
export function resolveRelativeImport(fromRelPath, specifier, existing) {
  if (typeof specifier !== "string" || !specifier.startsWith(".")) return null;
  const fromDir = path.posix.dirname(String(fromRelPath).replace(/\\/g, "/"));
  const base = path.posix.normalize(path.posix.join(fromDir, specifier));
  if (base.startsWith("..")) return null; // escaped the repo root
  const candidates = [base];
  for (const ext of SOURCE_EXTENSIONS) candidates.push(base + ext);
  for (const ext of SOURCE_EXTENSIONS) candidates.push(path.posix.join(base, "index" + ext));
  for (const c of candidates) {
    if (existing.has(c)) return c;
  }
  return null;
}

function isSourceFile(relPath) {
  const ext = path.posix.extname(String(relPath).replace(/\\/g, "/")).toLowerCase();
  return SOURCE_EXTENSIONS.includes(ext);
}

/**
 * Recursively list repo-relative POSIX paths under repoRoot, skipping
 * build/vendored dirs and the tmp/ scratch tree for determinism+speed.
 * Hand-written `lib/` and `.claude/` source stays indexed. Skips `.venv`
 * by name and the nested Claude Code checkouts under `.claude/worktrees`
 * by path.
 * @param {string} repoRoot
 * @returns {Promise<string[]>} sorted repo-relative POSIX paths
 */
export async function listRepoFiles(repoRoot) {
  const out = [];
  const skipDir = new Set([".git", "node_modules", "dist", "coverage", "tmp", ".venv"]);
  const skipPath = new Set([".claude/worktrees"]);
  async function walk(absDir, relDir) {
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue;
      const relPath = relDir ? `${relDir}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (skipDir.has(ent.name) || skipPath.has(relPath)) continue;
        await walk(path.join(absDir, ent.name), relPath);
      } else if (ent.isFile()) {
        out.push(relPath);
      }
    }
  }
  await walk(repoRoot, "");
  out.sort();
  return out;
}

/**
 * Build the reverse-import (importers) index: for each source file, which other
 * source files import it (1-hop in-edges). Deterministic given the repo files.
 * @param {string[]} repoFiles — repo-relative POSIX paths
 * @param {string} repoRoot
 * @returns {Promise<Map<string, string[]>>} target → sorted importers
 */
export async function buildImporterIndex(repoFiles, repoRoot) {
  const existing = new Set(repoFiles);
  const importers = new Map();
  for (const file of repoFiles) {
    if (!isSourceFile(file)) continue;
    // Skip minified artifacts: they are stripped from the final bundle anyway and
    // are not meaningful import sources, so reading them here is wasted I/O/memory
    // on repos with large minified files.
    if (/\.min\.[a-z0-9]+$/i.test(file)) continue;
    let source;
    try {
      source = await readFile(path.resolve(repoRoot, file), "utf8");
    } catch {
      continue;
    }
    for (const spec of extractImportSpecifiers(source)) {
      const target = resolveRelativeImport(file, spec, existing);
      if (!target) continue;
      if (!importers.has(target)) importers.set(target, []);
      const list = importers.get(target);
      if (!list.includes(file)) list.push(file);
    }
  }
  for (const list of importers.values()) list.sort();
  return importers;
}

/**
 * Decide whether a repo-relative path is safe to resolve+read under repoRoot.
 * Fails closed: rejects absolute paths, any `..` segment, and any resolved
 * absolute path that escapes repoRoot. Deterministic, pure path math.
 * @param {string} repoRoot
 * @param {string} relPath — repo-relative POSIX path
 * @returns {{ ok: true, abs: string } | { ok: false }}
 */
export function resolveSafeRepoPath(repoRoot, relPath) {
  const posix = String(relPath).replace(/\\/g, "/");
  if (posix.length === 0) return { ok: false };
  if (path.posix.isAbsolute(posix) || path.win32.isAbsolute(posix)) return { ok: false };
  if (posix.split("/").includes("..")) return { ok: false };
  const root = path.resolve(repoRoot);
  const abs = path.resolve(root, posix);
  if (abs !== root && !abs.startsWith(root + path.sep)) return { ok: false };
  return { ok: true, abs };
}

/**
 * Read a file with the size guards applied. Returns the (possibly truncated)
 * content plus guard metadata. Never throws on a missing/unreadable file.
 *
 * Path safety: unsafe relPaths (absolute, `..` segments, or escaping repoRoot)
 * are NOT read — they are recorded with strip reason "unsafe-path".
 *
 * Bounded read: when the file is over the cap it is truncated, so we read at
 * most maxFileBytes+1 bytes (the +1 lets us also sniff binary content past the
 * cap without loading the whole file). The full original size is read from
 * stat() for the manifest.
 * @param {string} repoRoot
 * @param {string} relPath
 * @param {number} maxFileBytes
 * @returns {Promise<{ relPath: string, content: string|null, bytes: number, includedBytes: number, truncated: boolean, missing: boolean, strip: string|null }>}
 */
async function readGuardedFile(repoRoot, relPath, maxFileBytes) {
  const strip = classifyStripReason(relPath);
  if (strip) {
    return { relPath, content: null, bytes: 0, includedBytes: 0, truncated: false, missing: false, strip };
  }
  const safe = resolveSafeRepoPath(repoRoot, relPath);
  if (!safe.ok) {
    return { relPath, content: null, bytes: 0, includedBytes: 0, truncated: false, missing: false, strip: "unsafe-path" };
  }
  const abs = safe.abs;
  let handle;
  try {
    const info = await stat(abs);
    if (!info.isFile()) {
      return { relPath, content: null, bytes: 0, includedBytes: 0, truncated: false, missing: true, strip: null };
    }
    const bytes = info.size;
    // Read enough to (a) detect over-cap and truncate, and (b) always cover the
    // binary-sniff window — so a cap configured below BINARY_SNIFF_BYTES can't let
    // a binary slip through as text. Still bounded (never the whole large file).
    const readCap = Math.min(bytes, Math.max(maxFileBytes + 1, BINARY_SNIFF_BYTES));
    const buf = Buffer.allocUnsafe(readCap);
    handle = await open(abs, "r");
    const { bytesRead } = await handle.read(buf, 0, readCap, 0);
    const data = buf.subarray(0, bytesRead);
    if (looksBinaryContent(data)) {
      return { relPath, content: null, bytes, includedBytes: 0, truncated: false, missing: false, strip: "binary" };
    }
    let truncated = false;
    let slice = data;
    if (bytes > maxFileBytes) {
      slice = data.subarray(0, maxFileBytes);
      truncated = true;
    }
    return {
      relPath,
      content: slice.toString("utf8"),
      bytes,
      includedBytes: slice.length,
      truncated,
      missing: false,
      strip: null,
    };
  } catch {
    return { relPath, content: null, bytes: 0, includedBytes: 0, truncated: false, missing: true, strip: null };
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

/**
 * Decode a path token straight out of a unified diff header line. Git quotes a
 * path (wraps it in `"..."`) whenever it carries a `"`, a `\`, a control
 * character, or (under the default `core.quotePath`) a non-ASCII byte, and
 * C-escapes the quoted content: `\"`, `\\`, `\t`, `\n`, and `\ooo` octal
 * per raw byte. A raw string-slice of a quoted token (e.g. `"b/a b.txt"`
 * sliced at a fixed offset) still carries the quotes and escapes verbatim,
 * so a downstream consumer that classifies or displays that string sees the
 * wrong path. Unquoted tokens (the common case) pass through unchanged.
 * @param {string} raw
 * @returns {string}
 */
export function decodeGitDiffPathToken(raw) {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (trimmed.length < 2 || !trimmed.startsWith('"') || !trimmed.endsWith('"')) return trimmed;
  const inner = trimmed.slice(1, -1);
  const bytes = [];
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch !== "\\") {
      const code = ch.codePointAt(0);
      if (code > 255) bytes.push(...Buffer.from(ch, "utf8"));
      else bytes.push(code);
      continue;
    }
    const next = inner[i + 1];
    if (next === "n") { bytes.push(10); i++; continue; }
    if (next === "t") { bytes.push(9); i++; continue; }
    if (next === '"') { bytes.push(34); i++; continue; }
    if (next === "\\") { bytes.push(92); i++; continue; }
    const octal = inner.slice(i + 1, i + 4);
    if (/^[0-7]{3}$/.test(octal)) { bytes.push(parseInt(octal, 8)); i += 3; continue; }
    bytes.push(ch.charCodeAt(0)); // unrecognized escape — keep the backslash's own byte, fail open
  }
  return Buffer.from(bytes).toString("utf8");
}

/** Default per-round caps for the adaptive context expansion (gates.contextExpansion). */
export const DEFAULT_EXPANSION_CAPS = { maxFiles: 6, maxBytes: 98304 };

// ponytail: line-regex scan, not a parser. Ceiling: top-level function and
// arrow-const declarations only; a function ends at the next column-0 line that
// is not a closing `}`/`)`/`]` (class methods, nested exports and column-0 lines
// inside template literals are not understood). `export { a, b }` lists and
// `export default function name` are covered. Upgrade path: a real JS parser.
const DECL_RE = /^(export\s+(?:default\s+)?)?(?:async\s+function\s*\*?\s*|function\s*\*?\s*|const\s+)([A-Za-z_$][\w$]*)(?=\s*(?:\(|=\s*(?:async\s*)?(?:\(|function\b|[A-Za-z_$][\w$]*\s*=>)))/;
const EXPORT_LIST_RE = /^export\s*\{([^}]*)\}/;
// ponytail: name heuristic for state writers and guards, anchored to the start
// of the name at a camelCase/underscore boundary; add a marker comment
// convention if it misfires.
const WRITER_OR_GUARD_RE = /^(write|save|persist|set|delete|remove|guard|assert|ensure|require|refuse|validate)(?![a-z])/;

/**
 * New-side line numbers touched per file. A removal is credited to the
 * preceding new-side line (a removal at a function tail stays in that function).
 * Ceiling: a deleted file (`+++ /dev/null`) is skipped; its source is gone.
 */
function changedLinesByFile(diffText) {
  const out = new Map();
  let file = null;
  let inHunk = false;
  let n = 0;
  const mark = (line) => out.get(file)?.add(line);
  for (const line of String(diffText ?? "").split("\n")) {
    if (line.startsWith("diff --git ")) { inHunk = false; file = null; continue; }
    if (!inHunk && line.startsWith("+++ ")) {
      file = line.includes("/dev/null") ? null : decodeGitDiffPathToken(line.slice(4)).replace(/^.\//, "");
      if (file) out.set(file, new Set());
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line);
    if (hunk) { inHunk = true; n = Number(hunk[1]); continue; }
    if (!inHunk || !file) continue;
    if (line.startsWith("+")) { mark(n); n += 1; }
    else if (line.startsWith("-")) mark(n - 1);
    else if (line.startsWith(" ")) n += 1;
  }
  return out;
}

/** Top-level declarations of a source text: [{ name, exported, start, end, bytes }] (1-based lines). */
function topLevelFunctions(source) {
  const lines = source.split("\n");
  const listed = new Set();
  for (const text of lines) {
    const list = EXPORT_LIST_RE.exec(text);
    if (list) for (const item of list[1].split(",")) listed.add(item.trim().split(/\s+/)[0]);
  }
  const found = [];
  lines.forEach((text, i) => {
    const m = DECL_RE.exec(text);
    if (!m) return;
    let end = i + 1;
    while (end < lines.length && (lines[end] === "" || /^[\s})\]]/.test(lines[end]))) end += 1;
    // `end` is a 0-based index of the first non-member line, i.e. the 1-based last member line.
    found.push({ name: m[2], exported: Boolean(m[1]) || listed.has(m[2]), start: i + 1, end });
  });
  return found.map((f) => ({ ...f, bytes: Buffer.byteLength(lines.slice(f.start - 1, f.end).join("\n"), "utf8") }));
}

/**
 * Adaptive context expansion: for each changed file whose diff touches an
 * exported function, a state writer or a guard, select its importers and its
 * sibling functions, then apply the per-round file and byte caps. Candidates
 * are sorted by (kind with siblings first, path), so selection and the dropped
 * list are deterministic. A diff confined to private, non-writer, non-guard
 * functions selects nothing. Files absent from the repo or stripped by
 * classifyStripReason (and symlink importers) are never selected. Ceiling:
 * gates.reviewDiff.excludeGlobs is not applied here.
 */
async function selectExpansion({ changed, diffText, repoRoot, importerIndex, caps, existing }) {
  if (caps.maxFiles <= 0 || caps.maxBytes <= 0) return { maxFiles: caps.maxFiles, maxBytes: caps.maxBytes, files: [], dropped: [] };
  const touched = changedLinesByFile(diffText);
  const candidates = new Map();
  const add = (key, entry) => {
    const prior = candidates.get(key);
    if (prior) prior.relatedTo = Array.from(new Set([...prior.relatedTo, ...entry.relatedTo])).sort();
    else candidates.set(key, entry);
  };
  for (const file of changed) {
    const lines = touched.get(file);
    if (!lines || !isSourceFile(file) || !existing.has(file) || classifyStripReason(file)) continue;
    let source;
    try {
      source = await readFile(path.resolve(repoRoot, file), "utf8");
    } catch {
      continue;
    }
    const fns = topLevelFunctions(source);
    const hit = fns.filter((f) => (f.exported || WRITER_OR_GUARD_RE.test(f.name)) && [...lines].some((l) => l >= f.start && l <= f.end));
    if (hit.length === 0) continue;
    const siblings = fns.filter((f) => !hit.includes(f));
    if (siblings.length > 0) {
      add(`${file}\0siblings`, { path: file, kind: "siblings", relatedTo: [file], names: siblings.map((f) => f.name).sort(), bytes: siblings.reduce((n, f) => n + f.bytes, 0) });
    }
    for (const imp of importerIndex.get(file) ?? []) {
      if (changed.includes(imp) || !existing.has(imp) || classifyStripReason(imp)) continue;
      let bytes = 0;
      try {
        const info = await lstat(path.resolve(repoRoot, imp));
        if (info.isSymbolicLink()) continue;
        bytes = info.size;
      } catch {
        continue;
      }
      add(`${imp}\0importer`, { path: imp, kind: "importer", relatedTo: [file], bytes });
    }
  }
  const files = [];
  const dropped = [];
  let total = 0;
  const ordered = Array.from(candidates.values()).sort((a, b) => (a.kind === b.kind ? (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) : a.kind === "siblings" ? -1 : 1));
  for (const c of ordered) {
    if (files.length < caps.maxFiles && total + c.bytes <= caps.maxBytes) {
      files.push(c);
      total += c.bytes;
    } else {
      dropped.push({ path: c.path, kind: c.kind, bytes: c.bytes });
    }
  }
  return { maxFiles: caps.maxFiles, maxBytes: caps.maxBytes, files, dropped };
}

/**
 * Build the deterministic, neutral adjacent-code bundle for a set of changed
 * files. For each changed source file, collect its 1-hop import out-edges
 * (resolved relative imports) and in-edges (files that import it) and include
 * each adjacent file's (guarded) content.
 *
 * Output shape (added to the gate-context artifact under `adjacentCode`):
 *   {
 *     maxFileBytes,
 *     files: [{ path, role: "changed"|"imports"|"importedBy", relatedTo: [..],
 *               bytes, includedBytes, truncated, content }],  // sorted by path
 *     stripped: [{ path, reason, role: "changed"|"imports"|"importedBy",
 *                 relatedTo: [..] }],                          // sorted by path
 *     truncated: [{ path, bytes, includedBytes }],            // sorted by path
 *     missing: [string],                                      // sorted
 *   }
 *
 * Deterministic: same (repoRoot contents + changedFiles) → identical bundle.
 *
 * @param {object} input
 * @param {string[]} input.changedFiles — repo-relative paths from the diff
 * @param {string} [input.repoRoot]
 * @param {number} [input.maxFileBytes]
 * @param {string} [input.diffText] — unified diff; drives the adaptive `expansion`
 * @param {{ maxFiles?: number, maxBytes?: number }} [input.expansion] — per-round caps (gates.contextExpansion)
 * @returns {Promise<object>}
 */
export async function buildAdjacentBundle({ changedFiles, repoRoot = process.cwd(), maxFileBytes = DEFAULT_MAX_FILE_BYTES, diffText = "", expansion = {} }) {
  const caps = { maxFiles: expansion?.maxFiles ?? DEFAULT_EXPANSION_CAPS.maxFiles, maxBytes: expansion?.maxBytes ?? DEFAULT_EXPANSION_CAPS.maxBytes };
  const changed = Array.from(
    new Set((Array.isArray(changedFiles) ? changedFiles : []).map((f) => String(f).replace(/\\/g, "/")).filter((f) => f.length > 0)),
  ).sort();

  // No changed files → empty bundle. Return early so the empty case is O(1) and
  // skips the whole-repo scan + importer-index build entirely.
  if (changed.length === 0) {
    return { maxFileBytes, files: [], stripped: [], truncated: [], missing: [], expansion: { ...caps, files: [], dropped: [] } };
  }

  const repoFiles = await listRepoFiles(repoRoot);
  const existing = new Set(repoFiles);
  const importerIndex = await buildImporterIndex(repoFiles, repoRoot);

  // role per path: changed > imports/importedBy. relatedTo accumulates the
  // changed files an adjacent file is adjacent to (sorted, deduped).
  /** @type {Map<string, { role: string, relatedTo: Set<string> }>} */
  const selected = new Map();
  const note = (relPath, role, relatedTo) => {
    if (!relPath) return;
    let entry = selected.get(relPath);
    if (!entry) {
      entry = { role, relatedTo: new Set() };
      selected.set(relPath, entry);
    } else if (entry.role !== "changed" && role === "changed") {
      entry.role = "changed";
    }
    if (relatedTo) entry.relatedTo.add(relatedTo);
  };

  for (const file of changed) {
    note(file, "changed", null);
  }

  for (const file of changed) {
    // Out-edges: imports declared by the changed file (source files only).
    if (isSourceFile(file) && existing.has(file)) {
      try {
        const source = await readFile(path.resolve(repoRoot, file), "utf8");
        for (const spec of extractImportSpecifiers(source)) {
          const target = resolveRelativeImport(file, spec, existing);
          if (target && !changed.includes(target)) note(target, "imports", file);
        }
      } catch {
        // unreadable changed file — diff still carries it; skip out-edges
      }
    }
    // In-edges: files that import the changed file.
    const importers = importerIndex.get(file) ?? [];
    for (const imp of importers) {
      if (!changed.includes(imp)) note(imp, "importedBy", file);
    }
  }

  const files = [];
  const stripped = [];
  const truncatedList = [];
  const missing = [];

  for (const relPath of Array.from(selected.keys()).sort()) {
    const entry = selected.get(relPath);
    const relatedTo = Array.from(entry.relatedTo).sort();
    const guarded = await readGuardedFile(repoRoot, relPath, maxFileBytes);
    if (guarded.strip) {
      stripped.push({ path: relPath, reason: guarded.strip, role: entry.role, relatedTo });
      continue;
    }
    if (guarded.missing) {
      // A changed file deleted by the diff legitimately won't exist on disk.
      missing.push(relPath);
      continue;
    }
    if (guarded.truncated) {
      truncatedList.push({ path: relPath, bytes: guarded.bytes, includedBytes: guarded.includedBytes });
    }
    files.push({
      path: relPath,
      role: entry.role,
      relatedTo,
      bytes: guarded.bytes,
      includedBytes: guarded.includedBytes,
      truncated: guarded.truncated,
      content: guarded.content,
    });
  }

  return {
    maxFileBytes,
    files,
    stripped,
    truncated: truncatedList,
    missing: missing.sort(),
    expansion: await selectExpansion({ changed, diffText, repoRoot, importerIndex, caps, existing }),
  };
}
