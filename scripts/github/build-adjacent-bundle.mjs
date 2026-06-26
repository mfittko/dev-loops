#!/usr/bin/env node
/**
 * build-adjacent-bundle.mjs — deterministic, neutral adjacent-code bundle builder.
 *
 * Part of issue #895 (build-once neutral context bundle for the gate fan-out).
 * The gate context-builder runs ONCE and emits a generous, NEUTRAL bundle that
 * every independent reviewer is seeded with verbatim — instead of every reviewer
 * re-deriving the diff + adjacent code from scratch (the actual N× waste this
 * fixes). The primary win is WORK-DEDUP (build once vs. N× re-derivation);
 * prompt-cache of the shared prefix is an opportunistic bonus.
 *
 * Neutrality + determinism are guaranteed because this is a SCRIPT, not an
 * agent: it cannot editorialize, and identical (head + changed files) input
 * always produces an identical bundle (sorted file list, stable JSON shape).
 *
 * Bundle contents: for each changed JS/.mjs/.cjs file we include
 *   - the files it imports (1-hop out-edges), and
 *   - the files that import it (1-hop in-edges, via a repo-wide import scan)
 * resolved against the repo (deterministic 1-hop import/require graph).
 *
 * Size guards (record, do not silently drop):
 *   - skip lockfiles (package-lock.json / *-lock.yaml), generated trees
 *     (.claude/, dist/, lib/, node_modules/, coverage/), binary, and minified
 *     files (*.min.*) — recorded in `stripped` with a reason.
 *   - cap per-file bytes (default ~48KB) and truncate the long tail —
 *     recorded in `truncated` with original/included byte counts.
 *
 * The output is purely structural adjacency; it does NOT carry any opinion,
 * verdict, or main-agent state, so seeding a reviewer with it is the INTENDED
 * neutral seed (RFC-2), not contamination.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

/** Default per-file byte cap before truncation. */
export const DEFAULT_MAX_FILE_BYTES = 48 * 1024;

/** Source extensions we resolve import edges for (JS family, this repo). */
const SOURCE_EXTENSIONS = [".mjs", ".js", ".cjs"];

/** Directory prefixes treated as generated / vendored and skipped. */
const GENERATED_DIR_PREFIXES = [
  ".claude/",
  "dist/",
  "lib/",
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

  if (base === "package-lock.json" || base === "npm-shrinkwrap.json" || /-lock\.ya?ml$/.test(base) || base === "yarn.lock" || base === "pnpm-lock.yaml") {
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
  const limit = Math.min(buf.length, 8 * 1024);
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
 * Returns specifiers in source order, de-duplicated (first occurrence wins).
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
 * generated/vendored dirs and the tmp/ scratch tree for determinism+speed.
 * @param {string} repoRoot
 * @returns {Promise<string[]>} sorted repo-relative POSIX paths
 */
export async function listRepoFiles(repoRoot) {
  const out = [];
  const skipDir = new Set([".git", "node_modules", "dist", "lib", ".claude", "coverage", "tmp"]);
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
        if (skipDir.has(ent.name)) continue;
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
 * Read a file with the size guards applied. Returns the (possibly truncated)
 * content plus guard metadata. Never throws on a missing/unreadable file.
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
  const abs = path.resolve(repoRoot, relPath);
  let buf;
  try {
    const info = await stat(abs);
    if (!info.isFile()) {
      return { relPath, content: null, bytes: 0, includedBytes: 0, truncated: false, missing: true, strip: null };
    }
    buf = await readFile(abs);
  } catch {
    return { relPath, content: null, bytes: 0, includedBytes: 0, truncated: false, missing: true, strip: null };
  }
  if (looksBinaryContent(buf)) {
    return { relPath, content: null, bytes: buf.length, includedBytes: 0, truncated: false, missing: false, strip: "binary" };
  }
  const bytes = buf.length;
  let truncated = false;
  let slice = buf;
  if (bytes > maxFileBytes) {
    slice = buf.subarray(0, maxFileBytes);
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
 *     stripped: [{ path, reason, relatedTo: [..] }],          // sorted by path
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
 * @returns {Promise<object>}
 */
export async function buildAdjacentBundle({ changedFiles, repoRoot = process.cwd(), maxFileBytes = DEFAULT_MAX_FILE_BYTES }) {
  const changed = Array.from(
    new Set((Array.isArray(changedFiles) ? changedFiles : []).map((f) => String(f).replace(/\\/g, "/")).filter((f) => f.length > 0)),
  ).sort();

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
  };
}
