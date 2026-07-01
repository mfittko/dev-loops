/**
 * Diff analysis for dynamic gate angle resolution.
 *
 * T0 — file-level: classifies files by extension and directory.
 * T1 — hunk-level: classifies hunks by change type (comments, imports, config, etc.).
 *
 * T2 (AST-level) is deferred to a follow-up.
 *
 * This module is intentionally pure and side-effect free.
 */

// ---------------------------------------------------------------------------
// T0: File-level analysis
// ---------------------------------------------------------------------------

/**
 * @typedef {object} T0Result
 * @property {string[]} files — flat file paths
 * @property {string[]} extensions — unique file extensions (lowercase, with dot)
 * @property {string[]} directories — unique top-level path segments
 * @property {boolean} renameOnly — true when all entries are renames (no adds/deletes/modifies)
 * @property {boolean} allDocs — true when all files are under docs/ or are .md
 */

/**
 * Parse `git diff --name-status` output into a T0 analysis.
 *
 * Each line format: `<status>\t<path>` or `<status>\t<old>\t<new>`.
 *
 * @param {string} nameStatusOutput — raw stdout from `git diff --name-status`
 * @returns {T0Result}
 */

/**
 * Normalize file path separators to forward slashes.
 * Handles Windows backslash paths from git output on Windows.
 *
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
  }

  const renameOnly = lines.length > 0 && renameCount === lines.length;
  const allDocs = lines.length > 0 && files.every(
    (f) => normalizeSep(f).startsWith("docs/") || f.endsWith(".md") || f === "README.md",
  );

  return {
    files,
    extensions: [...extensions].sort(),
    directories: [...directories].sort(),
    renameOnly,
    allDocs,
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
  if (fp.startsWith("docs/") || fp.endsWith(".md") || fp === "README.md") {
    return "docs";
  }
  if (
    fp.endsWith(".yml") || fp.endsWith(".yaml") ||
    fp.endsWith(".json") || fp === "package.json"
  ) {
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
 * Check whether a diff line content (after stripping the + / - prefix) is
 * a comment or blank line — i.e. not logic.
 *
 * @param {string} content — trimmed line content (without + / - prefix)
 * @returns {boolean}
 */
function isNonLogicLine(content) {
  if (content === "") return true;
  if (content.startsWith("//") || content.startsWith("/*") || content.startsWith("*")) return true;
  // import/export/require lines are NOT non-logic — they change dependencies
  // and should not be classified as COMMENT_ONLY
  return false;
}

/**
 * Analyze unified diff hunks to classify change types.
 *
 * Detects:
 * - COMMENT_ONLY: only comment lines changed
 * - DOCS_ONLY: only .md files changed (from extensions)
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
    // Track hunk headers
    if (line.startsWith("@@")) {
      hunkCount++;
      inHunk = true;
      continue;
    }

    if (!inHunk) continue;

    // Track line stats and classify
    if (line.startsWith("+") && !line.startsWith("+++")) {
      added++;
      hasAnyChangedLine = true;
      const content = line.slice(1).trim();
      if (!isNonLogicLine(content)) {
        hasLogicChange = true;
        allChangedLinesAreNonLogic = false;
      }
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      deleted++;
      hasAnyChangedLine = true;
      const content = line.slice(1).trim();
      if (!isNonLogicLine(content)) {
        hasLogicChange = true;
        allChangedLinesAreNonLogic = false;
      }
    }
  }

  // Build categories from T0 + hunk analysis
  if (t0.renameOnly) categories.add("RENAME_ONLY");
  if (t0.allDocs) categories.add("DOCS_ONLY");
  if (t0.files.every((f) => classifyFile(f) === "config")) categories.add("CONFIG_ONLY");
  if (t0.files.every((f) => classifyFile(f) === "test")) categories.add("TEST_ONLY");
  if (t0.files.every((f) => classifyFile(f) === "ci")) categories.add("CI_ONLY");
  if (hasLogicChange) categories.add("LOGIC_CHANGE");

  // COMMENT_ONLY: hunkCount > 0 (real diff), has changed lines, all are non-logic,
  // and not a rename-only change
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
 * Infer change categories from T0 analysis when T1 is not run.
 *
 * @param {T0Result} t0
 * @returns {string[]}
 */
function inferCategoriesFromT0(t0) {
  const categories = [];
  if (t0.renameOnly) categories.push("RENAME_ONLY");
  if (t0.allDocs) categories.push("DOCS_ONLY");
  if (t0.files.length > 0 && t0.files.every((f) => classifyFile(f) === "config")) categories.push("CONFIG_ONLY");
  if (t0.files.length > 0 && t0.files.every((f) => classifyFile(f) === "test")) categories.push("TEST_ONLY");
  if (t0.files.length > 0 && t0.files.every((f) => classifyFile(f) === "ci")) categories.push("CI_ONLY");
  // Pure code-only change: a diff whose files all classify as code (and is not a
  // rename) is a LOGIC_CHANGE. Without this, an all-code diff has a single file
  // category (so analyzeDiff never runs hunk-level T1) and produces no category,
  // which resolveDynamicAngles treats as "unclassifiable" → fallback-to-all. That
  // regressed the primary case: a code-only PR must resolve to the LOGIC_CHANGE
  // core review subset, not all angles.
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
    t1 = {
      changeCategories: inferCategoriesFromT0(t0),
      hunkCount: 0,
      lineStats: { added: 0, deleted: 0 },
    };
  }

  // Ambiguous is reserved for genuinely unclassifiable diffs (analysis produced
  // no categories). LOGIC_CHANGE is a classified category (resolves to its core
  // review subset), so it no longer forces fallback-to-all.
  const ambiguous = t0Ambiguous && t1.changeCategories.length === 0;

  return { t0, t1, ambiguous };
}
