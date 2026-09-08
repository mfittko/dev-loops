/**
 * Diff analysis for dynamic gate angle resolution.
 *
 * T0 file-level classifies files by extension/directory; T1 hunk-level
 * classifies hunks by change type. This module is intentionally pure and
 * side-effect free.
 */

// ---------------------------------------------------------------------------
// T0: File-level analysis
// ---------------------------------------------------------------------------

// Extensionless dotfile configs: static allowlist matched on basename only.
// Runtime-version files like .nvmrc are REJECTED as config: classifying them
// config would carry stale clean verdicts across a runtime bump. Unknown fails
// closed to a full re-review.
const DOTFILE_CONFIG_BASENAMES = new Set([".devloops"]);

// Prose surface that arms the required `deslop` gate angle (#1442).
// skills/docs/** is excluded via SKILLS_DOCS_EXEMPT_RE: those are normative
// contracts, not prose.
const PROSE_PATH_RE = /^docs\/(articles|presentations)\//;
const NARRATIVE_DOC_RE = /^docs\/[^/]+\.(md|markdown)$/;
// The README basename rule below is the only path by which a skills/docs file
// could be classified prose, so carve the normative-contract subtree out here
// so a README-named contract never arms deslop.
const SKILLS_DOCS_EXEMPT_RE = /^(skills\/docs|\x2eclaude\/skills\/docs)\//;

/**
 * Whether a file path is on the prose surface. skills/docs/** (and
 * .claude/skills/docs/**) is exempt across all rules, including the README
 * basename rule.
 * @param {string} filePath
 * @returns {boolean}
 */
export function isProsePath(filePath) {
  // Exported trust-boundary guard: fail closed (false) on a non-string/empty
  // argument rather than crashing in normalizeSep().
  if (typeof filePath !== "string" || filePath.length === 0) return false;
  const fp = normalizeSep(filePath);
  if (SKILLS_DOCS_EXEMPT_RE.test(fp)) return false;
  if (PROSE_PATH_RE.test(fp)) return true;
  if (NARRATIVE_DOC_RE.test(fp)) return true;
  const base = fp.split("/").pop() ?? "";
  if (base.startsWith("README")) return true;
  return false;
}

/**
 * @typedef {object} T0Result
 * @property {string[]} files — flat file paths
 * @property {string[]} extensions — unique file extensions (lowercase, with dot)
 * @property {string[]} directories — unique top-level path segments
 * @property {boolean} renameOnly — true when all entries are renames (no adds/deletes/modifies)
 * @property {boolean} allDocs — true when all files are under docs/ or have a docs extension (.md/.markdown)
 */

/**
 * Parse `git diff --name-status` output into a T0 analysis. Line format:
 * `<status>\t<path>` or `<status>\t<old>\t<new>`.
 * @param {string} nameStatusOutput
 * @returns {T0Result}
 */

/**
 * Normalize path separators to forward slashes (Windows backslash paths).
 * @param {string} filePath
 * @returns {string}
 */
function normalizeSep(filePath) {
  return filePath.replaceAll("\\", "/");
}

export function analyzeT0(nameStatusOutput) {
  const lines = nameStatusOutput.trim().split("\n").filter(Boolean);
  const files = [];
  const extensions = new Set();
  const directories = new Set();
  let renameCount = 0;
  // Prose arming is scoped to content-carrying rows: a pure deletion (`D`) has
  // no prose content to strip, so it must not arm deslop. Added/modified/
  // renamed-dest rows carry content and arm prose.
  let prosePresent = false;

  for (const line of lines) {
    const parts = line.split("\t");
    const status = parts[0];
    const rawPath = parts.length >= 3 ? parts[2] : parts[1];
    const path = normalizeSep(rawPath);
    if (!path) continue;

    files.push(path);

    const ext = path.includes(".") ? "." + path.split(".").pop().toLowerCase() : "";
    if (ext) extensions.add(ext);

    const dir = path.split("/")[0];
    if (dir) directories.add(dir);

    if (status.startsWith("R")) renameCount++;
    // Pure deletions (`D`) and a pure `R100` rename (100% similarity, no content
    // changed) are content-free and must not arm deslop. Renames scored below
    // 100 carry content and still arm prose.
    if (prosePresent) continue;
    if (status === "D" || status.startsWith("D")) continue;
    if (status.startsWith("R") && status === "R100") continue;
    if (isProsePath(path)) prosePresent = true;
  }

  const renameOnly = lines.length > 0 && renameCount === lines.length;
  // Derive from the shared classifier so this predicate can't drift: a code/
  // config/test file under docs/ is not docs, so a mixed diff including one is
  // not docs-only.
  const allDocs = lines.length > 0 && files.every((f) => classifyFile(f) === "docs");

  return {
    files,
    extensions: [...extensions].sort(),
    directories: [...directories].sort(),
    renameOnly,
    allDocs,
    prosePresent,
  };
}

/**
 * @typedef {"code" | "docs" | "config" | "test" | "ci" | "unknown"} FileCategory
 */

/**
 * Classify a single file path into a high-level category.
 *
 * @param {string} filePath
 * @returns {FileCategory}
 */
export function classifyFile(filePath) {
  const fp = normalizeSep(filePath);
  if (fp.startsWith(".github/")) {
    return "ci";
  }
  // A known code/config/test extension wins over the docs/ directory-prefix
  // fallback: a code/config/test file hosted under docs/ is still that surface,
  // not prose. Extension checks run before the prefix fallbacks below.
  if (
    fp.endsWith(".yml") || fp.endsWith(".yaml") ||
    fp.endsWith(".json") || fp === "package.json"
  ) {
    return "config";
  }
  if (DOTFILE_CONFIG_BASENAMES.has(fp.split("/").pop())) {
    return "config";
  }
  if (fp.includes(".test.") || fp.startsWith("test/")) {
    return "test";
  }
  if (
    fp.endsWith(".mjs") || fp.endsWith(".js") ||
    fp.endsWith(".ts") || fp.endsWith(".mts")
  ) {
    return "code";
  }
  if (
    fp.startsWith("docs/") || fp.endsWith(".md") || fp.endsWith(".markdown") ||
    fp === "README.md"
  ) {
    return "docs";
  }
  return "unknown";
}
// ---------------------------------------------------------------------------
// T1: Hunk-level analysis
// ---------------------------------------------------------------------------

/**
 * @typedef {object} T1Result
 * @property {string[]} changeCategories — detected change categories
 * @property {number} hunkCount
 * @property {{ added: number, deleted: number }} lineStats
 */

/**
 * Whether a diff line's content (prefix stripped) is a comment or blank line.
 * @param {string} content
 * @returns {boolean}
 */
function isNonLogicLine(content) {
  if (content === "") return true;
  if (content.startsWith("//") || content.startsWith("/*") || content.startsWith("*")) return true;
  // import/export/require lines are NOT non-logic — they change dependencies
  // and should not be classified as COMMENT_ONLY
  return false;
}

// Security-sensitive seams (#1336): touching these primitives on caller-/plan-
// influenced input is where trust-boundary bugs concentrate. A changed line
// matching any triggers the SECURITY_SENSITIVE_SEAM category, adding an up-front
// adversarial threat-model angle. Fail-safe: over-selection just adds one lens.
// Plain readFile/writeFile are excluded (ubiquitous JSON I/O would flag nearly
// every diff); the browser/process/network/destructive-fs/upload seams below
// cover the genuinely dangerous surface.
const SECURITY_SEAM_PATTERNS = [
  // Browser automation (driving a real browser over semi-trusted navigation)
  /\b(playwright|webkit|chromium|puppeteer)\b/i,
  /\bpage\.(goto|click|fill|evaluate|type|press|selectOption|setInputFiles|route|addInitScript)\b/,
  /\.newPage\s*\(/,
  /\bbrowser\.newContext\b/,
  // Child-process / shell execution
  /\bchild_process\b/,
  /\b(exec|execSync|execFile|execFileSync|spawn|spawnSync)\s*\(/,
  /\bshell\s*:\s*true\b/,
  // Untrusted network fetch
  /\bfetch\s*\(/,
  /\bhttps?\.(get|request)\s*\(/,
  /\b(axios|node-fetch|undici)\b/,
  // Destructive filesystem ops + local-file upload (caller-path removal/read)
  /\b(rm|rmSync|unlink|unlinkSync|rmdir|rmdirSync)\s*\(/,
  /\bsetInputFiles\s*\(/,
];

/**
 * Whether a changed diff line (prefix stripped) touches a security-sensitive seam.
 * @param {string} content
 * @returns {boolean}
 */
function isSecuritySensitiveSeamLine(content) {
  return SECURITY_SEAM_PATTERNS.some((re) => re.test(content));
}

/**
 * Scan a unified diff for a security-sensitive seam on any added/removed LOGIC
 * line of a CODE file. Two gates keep it precise: (1) only files classifyFile()
 * calls `code` are scanned, so a yaml/json/md line naming a primitive never
 * triggers; (2) !isNonLogicLine, so a comment naming a primitive never triggers.
 * Runs independently of the T0/T1 path so it also covers a pure-code diff, the
 * most concentrated seam case.
 * @param {string} diffOutput
 * @returns {boolean}
 */
export function diffHasSecuritySeam(diffOutput) {
  if (!diffOutput) return false;
  let inHunk = false;
  // Only CODE files can carry an executable seam: a YAML/markdown/JSON line
  // naming a primitive (e.g. `shell: true`) is not a seam. Track the current
  // file from the `--- a/`/`+++ b/` headers and gate on classifyFile === "code".
  // Bare-hunk input (no header, used in tests) defaults to code so it still scans.
  let currentFileIsCode = true;
  let fromPath = null;
  for (const line of diffOutput.split("\n")) {
    if (line.startsWith("--- ")) {
      const p = line.slice(4).trim().replace(/^a\//, "");
      fromPath = p === "/dev/null" ? null : p;
      inHunk = false;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim().replace(/^b\//, "");
      const effective = p === "/dev/null" ? fromPath : p;
      currentFileIsCode = effective != null && classifyFile(effective) === "code";
      inHunk = false;
      continue;
    }
    if (line.startsWith("@@")) { inHunk = true; continue; }
    if (!inHunk || !currentFileIsCode) continue;
    const isAdd = line.startsWith("+") && !line.startsWith("+++");
    const isDel = line.startsWith("-") && !line.startsWith("---");
    if (!isAdd && !isDel) continue;
    const content = line.slice(1).trim();
    if (isNonLogicLine(content)) continue;
    if (isSecuritySensitiveSeamLine(content)) return true;
  }
  return false;
}

/**
 * Analyze unified diff hunks to classify change types.
 *
 * Detects:
 * - COMMENT_ONLY: only comment lines changed
 * - DOCS_ONLY: emitted when docs files are present (presence-based, not exclusive)
 * - CONFIG_ONLY: only config files changed
 * - TEST_ONLY: only test files changed
 * - RENAME_ONLY: all renames, no content changes
 * - LOGIC_CHANGE: any non-trivial code change
 *
 * @param {string} diffOutput — raw unified diff output
 * @param {T0Result} t0 — T0 result for context
 * @returns {T1Result}
 */
export function analyzeT1(diffOutput, t0) {
  const lines = diffOutput.split("\n");
  let hunkCount = 0;
  let added = 0;
  let deleted = 0;
  const categories = new Set();

  let inHunk = false;
  let hasLogicChange = false;
  let hasAnyChangedLine = false;
  let allChangedLinesAreNonLogic = true;

  for (const line of lines) {
    // A new file's header block ends the previous file's hunk run. Resetting
    // here lets the counting below treat EVERY +/- line inside a hunk as
    // content: a removed line whose content starts with "--" (a CLI flag, a YAML
    // separator) renders as "---…" and a prefix-based header exclusion would
    // silently drop it from the counts.
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      continue;
    }
    // Track hunk headers
    if (line.startsWith("@@")) {
      hunkCount++;
      inHunk = true;
      continue;
    }

    if (!inHunk) continue;

    // Track line stats and classify
    if (line.startsWith("+")) {
      added++;
      hasAnyChangedLine = true;
      const content = line.slice(1).trim();
      if (!isNonLogicLine(content)) {
        hasLogicChange = true;
        allChangedLinesAreNonLogic = false;
      }
    } else if (line.startsWith("-")) {
      deleted++;
      hasAnyChangedLine = true;
      const content = line.slice(1).trim();
      if (!isNonLogicLine(content)) {
        hasLogicChange = true;
        allChangedLinesAreNonLogic = false;
      }
    }
  }

  // Build categories from T0 (shared with inferCategoriesFromT0) + hunk analysis.
  for (const c of t0FileCategories(t0)) categories.add(c);
  if (hasLogicChange) categories.add("LOGIC_CHANGE");
  // #1336: a diff touching a security-sensitive seam gets an up-front adversarial
  // threat-model angle, batched at draft time instead of drip-fed via Copilot.
  if (diffHasSecuritySeam(diffOutput)) categories.add("SECURITY_SENSITIVE_SEAM");
  // Mixed diffs never satisfy the exclusive `_ONLY` checks (some files are code),
  // so union each peripheral surface by PRESENCE (e.g. code+workflow pulls
  // ci-guard alongside LOGIC_CHANGE). The single-surface path keeps exclusive
  // semantics.
  for (const c of t0PresentSurfaceCategories(t0)) categories.add(c);

  // COMMENT_ONLY: real diff, all changed lines non-logic, not a rename.
  if (hunkCount > 0 && hasAnyChangedLine && allChangedLinesAreNonLogic && !t0.renameOnly) {
    categories.add("COMMENT_ONLY");
  }

  return {
    changeCategories: [...categories],
    hunkCount,
    lineStats: { added, deleted },
  };
}

// ---------------------------------------------------------------------------
// Combined analysis
// ---------------------------------------------------------------------------

/**
 * @typedef {object} DiffAnalysis
 * @property {T0Result} t0
 * @property {T1Result | null} t1
 * @property {boolean} ambiguous — true when heuristics cannot confidently classify
 */

/**
 * Categories derivable from T0 file classification alone (no hunk content).
 * Shared by analyzeT1 (which adds hunk-derived LOGIC_CHANGE/COMMENT_ONLY on top)
 * and inferCategoriesFromT0 (the no-T1 path). All checks are length-guarded so an
 * empty file list yields no category.
 *
 * @param {T0Result} t0
 * @returns {string[]}
 */
function t0FileCategories(t0) {
  if (t0.files.length === 0) return [];
  const categories = [];
  if (t0.renameOnly) categories.push("RENAME_ONLY");
  if (t0.allDocs) categories.push("DOCS_ONLY");
  if (t0.prosePresent) categories.push("PROSE_PRESENT");
  if (t0.files.every((f) => classifyFile(f) === "config")) categories.push("CONFIG_ONLY");
  if (t0.files.every((f) => classifyFile(f) === "test")) categories.push("TEST_ONLY");
  if (t0.files.every((f) => classifyFile(f) === "ci")) categories.push("CI_ONLY");
  return categories;
}

/**
 * Surface categories present in a MIXED diff (>=1 file of the surface), used by
 * the hunk-level path to union a mixed diff's peripheral lenses on top of
 * LOGIC_CHANGE. Presence (not exclusivity) is the correct trigger for a mixed
 * diff. Renames are handled by the exclusive path, so excluded here.
 * @param {T0Result} t0
 * @returns {string[]}
 */
function t0PresentSurfaceCategories(t0) {
  const categories = [];
  const cats = new Set(t0.files.map(classifyFile));
  if (cats.has("docs")) categories.push("DOCS_ONLY");
  if (t0.prosePresent) categories.push("PROSE_PRESENT");
  if (cats.has("config")) categories.push("CONFIG_ONLY");
  if (cats.has("test")) categories.push("TEST_ONLY");
  if (cats.has("ci")) categories.push("CI_ONLY");
  return categories;
}

/**
 * Infer change categories from T0 analysis when T1 (hunk-level) is not run.
 * Reuses the shared T0 file-category derivation, then adds the pure-code
 * LOGIC_CHANGE inference that the hunk-level path would otherwise supply.
 *
 * @param {T0Result} t0
 * @returns {string[]}
 */
function inferCategoriesFromT0(t0) {
  const categories = t0FileCategories(t0);
  // Pure code-only change (all files classify as code, not a rename) is a
  // LOGIC_CHANGE. Without this an all-code diff yields no category, which
  // resolveDynamicAngles treats as unclassifiable → fallback-to-all, regressing
  // the primary case: a code-only PR must resolve to the LOGIC_CHANGE subset.
  if (!t0.renameOnly && t0.files.length > 0 && t0.files.every((f) => classifyFile(f) === "code")) {
    categories.push("LOGIC_CHANGE");
  }
  return categories;
}

/**
 * Run full diff analysis (T0 + T1 if needed).
 *
 * T0 always runs. T1 runs when T0 doesn't produce a clear single-category result.
 * When T1 is not run (unambiguous diff), categories are inferred from T0 so
 * dynamic angle resolution can still narrow the angle list.
 *
 * @param {{ nameStatusOutput: string, diffOutput?: string }} input
 * @returns {DiffAnalysis}
 */
export function analyzeDiff({ nameStatusOutput, diffOutput }) {
  const t0 = analyzeT0(nameStatusOutput);
  let t1 = null;

  // T0 is unambiguous when: renameOnly, allDocs, or single clear category
  const t0Ambiguous = !t0.renameOnly && !t0.allDocs && t0.files.length > 1 &&
    new Set(t0.files.map(classifyFile)).size > 1;

  if (t0Ambiguous && diffOutput) {
    t1 = analyzeT1(diffOutput, t0);
  }

  // When t1 is null (unambiguous diff), infer categories from t0
  // so dynamic angle resolution can narrow for config-only / test-only etc.
  if (!t1) {
    // A genuinely MIXED diff whose T1 never ran (no diffOutput) must NOT get a
    // T0-only category: non-empty categories set ambiguous=false, so it would
    // under-select and drop the code-review core. T0-only inference is safe only
    // for unambiguous diffs; a mixed diff without hunk content is unclassifiable,
    // so return empty categories and fall back to the full angle set (fail closed).
    const changeCategories = t0Ambiguous ? [] : inferCategoriesFromT0(t0);
    t1 = {
      changeCategories,
      hunkCount: 0,
      lineStats: { added: 0, deleted: 0 },
    };
  }

  // Seam detection runs on the raw diff regardless of the T0/T1 path, so a
  // pure-code diff (T1 skipped) editing a browser/exec/fetch/fs-mutation driver
  // still triggers the threat-model angle.
  if (!t1.changeCategories.includes("SECURITY_SENSITIVE_SEAM") && diffHasSecuritySeam(diffOutput)) {
    t1.changeCategories.push("SECURITY_SENSITIVE_SEAM");
  }

  // `ambiguous` flags one case: a diff T0 could not classify (mixed categories)
  // AND whose hunk analysis produced no category. It is NOT the only fallback
  // trigger — resolveDynamicAngles also falls back whenever changeCategories is
  // empty. A mixed diff that yields a category (e.g. LOGIC_CHANGE) is classified
  // and not ambiguous, so LOGIC_CHANGE never forces fallback-to-all via this flag.
  const ambiguous = t0Ambiguous && t1.changeCategories.length === 0;

  return { t0, t1, ambiguous };
}
