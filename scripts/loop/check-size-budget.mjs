#!/usr/bin/env node
/**
 * check-size-budget
 *
 * Fail-closed PR size/tier budget — Phase 1: PURE COMPUTATION ONLY. This
 * module has no enforcement wiring (that is a later phase's `readyForReview()`
 * / `pre-pr-ready-gate.mjs` change); it computes `logicLoc`, resolves the
 * file→tier mapping from `gates.size` config, and emits an outcome
 * (`pass` | `escalate` | `block`) plus the reasons that produced it.
 *
 * `logicLoc = code + testDiscount * test`, summed from the existing diff
 * classifier's per-file category (@dev-loops/core/analysis/diff-analyzer):
 * only files that classify as `code` or `test` contribute — a file
 * classifying as `config`/`docs`/`ci`/`unknown` (which already covers
 * lockfiles and other generated/non-review-worthy content) contributes 0,
 * reusing the classifier's own signal rather than re-deriving one.
 *
 * The T1-slice LOC is the same computation restricted to files whose path
 * resolves to the `t1` tier (via configured glob patterns) — computed
 * separately from the whole-PR total so a large PR with a small, isolated
 * risk slice does not get penalized for its bulk, and a small PR with an
 * oversize risk slice cannot hide inside an otherwise-small diff.
 *
 * The classifier's `code`/`test` extension coverage is JS/TS-only; a diff
 * whose changed lines are substantially outside that coverage (non-JS
 * source, or a configured t1/t3 pattern matching a file that classifies
 * outside code/test) cannot be measured, so it blocks rather than silently
 * computing a zero — see `substantiallyUnclassified` below.
 */
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

import { analyzeDiff, classifyFile } from "@dev-loops/core/analysis/diff-analyzer";
import { loadDevLoopConfig } from "@dev-loops/core/config";

import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { requireTokenValue } from "../_cli-primitives.mjs";
import { gitEnvWithoutDirOverrides } from "../github/write-gate-context.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";

const USAGE = `Usage: check-size-budget.mjs --base <ref> [--head <ref>] [--waived] [--approved-by <name>]

Fail-closed PR size/tier budget: PURE COMPUTATION only (no enforcement —
this script does not block \`gh pr ready\`; a later phase wires it into
readyForReview()/pre-pr-ready-gate.mjs). Reads gates.size config, computes
logicLoc = code + testDiscount * test from the existing diff classifier
(generated/lockfile content excluded via the classifier's own category
signal), resolves each changed file's tier from configured path patterns,
and emits pass | escalate | block.

Required:
  --base <ref>          Git ref to diff against (git diff <ref>...<head>)

Optional:
  --head <ref>          Git ref for the PR head (default: HEAD)
  --waived              Record that a size-budget waiver was granted for
                         this computation (the ready-for-review.mjs waiver
                         CLI surface itself is a later phase; this flag only
                         feeds the outcome computation)
  --approved-by <name>  Named human approver; REQUIRED for a valid T1-slice
                         waiver (a default-tier waiver needs only --waived)
  --help, -h             Show this help

Output (stdout, JSON):
  {
    "ok": true|false,
    "outcome": "pass"|"escalate"|"block",
    "wholeLogicLoc": 120,
    "t1SliceLoc": 0,
    "tierLogicLoc": { "default": 120, "t1": 0, "t3": 0 },
    "thresholds": { "testDiscount": 0.25, "absoluteHardLoc": 2000,
                     "default": { "softLoc": 400, "waiverLoc": 1500 },
                     "t1": null },
    "ambiguous": false,
    "configErrorCount": 0,
    "waiver": { "requested": false, "approvedBy": null, "t1Valid": false, "defaultValid": false },
    "reasons": []
  }

${JQ_OUTPUT_USAGE}

Exit codes:
  0  outcome: pass
  1  outcome: escalate or block
  2  Argument/runtime error, or invalid --jq filter`;

const parseError = buildParseError(USAGE);

// ---------------------------------------------------------------------------
// Glob-style path-pattern matching (gates.size.tiers.{t1,t3}.patterns).
// A minimal shell-glob subset, standard globstar semantics: a "**/" sequence
// matches zero-or-more whole path segments (so "src/**/foo.js" matches both
// "src/foo.js" and "src/a/b/foo.js"), a lone "**" (not followed by "/")
// matches any suffix including "/", a single "*" matches within one path
// segment only, everything else is literal. This is deliberately not a full
// glob library — the config's own examples ("app/models/subscription*",
// "config/routes.rb") only need this subset, and no glob dependency is
// installed in this repo.
//
// Git can report backslash-separated paths on Windows; both the pattern
// (written with "/") and the candidate path are separator-normalized before
// matching so a tier pattern still resolves regardless of platform.
//
// Compiled patterns are cached by (normalized) pattern string — a large PR
// with many changed files re-tests the same handful of configured patterns
// per file, so recompiling the regex per file would be wasted work.
// ---------------------------------------------------------------------------

function escapeGlobLiteral(ch) {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

function normalizePathSeparators(value) {
  return value.replace(/\\/g, "/");
}

const globPatternCache = new Map();

function globToRegExp(pattern) {
  const normalizedPattern = normalizePathSeparators(pattern);
  const cached = globPatternCache.get(normalizedPattern);
  if (cached) return cached;
  let re = "";
  for (let i = 0; i < normalizedPattern.length; i += 1) {
    const ch = normalizedPattern[i];
    if (ch === "*" && normalizedPattern[i + 1] === "*") {
      if (normalizedPattern[i + 2] === "/") {
        re += "(?:.*/)?"; // "**/" — zero or more whole path segments
        i += 2; // consume the second "*" and the "/"
      } else {
        re += ".*"; // lone "**" — any suffix, including "/"
        i += 1; // consume the second "*"
      }
    } else if (ch === "*") {
      re += "[^/]*"; // single "*" — within one path segment only
    } else {
      re += escapeGlobLiteral(ch);
    }
  }
  const compiled = new RegExp(`^${re}$`);
  globPatternCache.set(normalizedPattern, compiled);
  return compiled;
}

export function matchesGlob(filePath, pattern) {
  if (typeof filePath !== "string" || typeof pattern !== "string" || pattern.length === 0) return false;
  return globToRegExp(pattern).test(normalizePathSeparators(filePath));
}

function matchesAnyPattern(filePath, patterns) {
  return Array.isArray(patterns) && patterns.some((p) => matchesGlob(filePath, p));
}

/**
 * Resolve a changed file's size-budget tier from `gates.size.tiers`. t1 wins
 * over t3 when a file (implausibly) matches both, since t1 is the risk-slice
 * tier the absolute/slice caps are meant to catch. A file matching neither
 * configured tier's patterns falls through to `default` — the implicit
 * catch-all tier, which is why `tiers.default` carries no `patterns` field
 * of its own.
 */
export function resolveFileTier(filePath, tiers = {}) {
  if (matchesAnyPattern(filePath, tiers?.t1?.patterns)) return "t1";
  if (matchesAnyPattern(filePath, tiers?.t3?.patterns)) return "t3";
  return "default";
}

// ---------------------------------------------------------------------------
// `git diff --numstat -z` parsing: NUL-separated records give an unambiguous
// per-file added/deleted count without reimplementing hunk-level LOC counting
// (git already computes it). A rename record's third tab-separated field is
// empty, signaling that the next two NUL-separated tokens are the old and new
// paths instead of one; a binary file reports "-" for both counts (mapped to
// 0 — binary content carries no logic-LOC signal, and its diff bytes are not
// reviewable line-by-line anyway).
// ---------------------------------------------------------------------------

export function parseNumstatZ(output) {
  if (typeof output !== "string" || output.length === 0) return [];
  const tokens = output.split("\0");
  const files = [];
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok === "") { i += 1; continue; }
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(tok);
    if (!m) { i += 1; continue; }
    const [, addedRaw, deletedRaw, rest] = m;
    const added = addedRaw === "-" ? 0 : Number(addedRaw);
    const deleted = deletedRaw === "-" ? 0 : Number(deletedRaw);
    if (rest !== "") {
      files.push({ path: rest, added, deleted });
      i += 1;
    } else {
      // Rename: this record's path is split across the next two NUL-separated
      // tokens (old, new); the new path is what classifyFile/resolveFileTier
      // must see (content lands under the new name).
      const newPath = tokens[i + 2] ?? tokens[i + 1] ?? "";
      if (newPath) files.push({ path: newPath, added, deleted });
      i += 3;
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Pure computation
// ---------------------------------------------------------------------------

const DEFAULT_TEST_DISCOUNT = 0.25;
const DEFAULT_ABSOLUTE_HARD_LOC = 2000;
const DEFAULT_TIER_DEFAULTS = Object.freeze({ softLoc: 400, waiverLoc: 1500 });
// Fail-closed threshold for the "substantially unclassified" case: the
// shared classifier only recognizes JS/TS as `code` (see diff-analyzer.mjs),
// so a non-JS-source PR (e.g. Ruby) classifies every file `unknown` and would
// otherwise silently compute logicLoc:0 and pass. Majority-unclassified
// changed lines means the budget cannot be measured, full stop.
const UNCLASSIFIED_BLOCK_RATIO = 0.5;

/**
 * Compute the size-budget outcome for one diff. Pure — no git, no config I/O
 * — so fixtures can drive every branch directly.
 *
 * @param {object} input
 * @param {string} [input.nameStatusOutput] — `git diff --name-status` output
 * @param {string} [input.diffOutput] — full unified diff (feeds the change
 *   classifier's ambiguity detection; per-file LOC comes from numstatOutput)
 * @param {string} [input.numstatOutput] — `git diff --numstat -z` output
 * @param {{ testDiscount?: number, absoluteHardLoc?: number, tiers?: { default?: object, t1?: object, t3?: object } }} [input.sizeConfig]
 * @param {Array<unknown>} [input.configErrors] — `loadDevLoopConfig` errors; non-empty blocks with no waiver
 * @param {boolean} [input.waived] — a size-budget waiver was granted (grant
 *   surface itself is a later phase; this is the computation-facing input)
 * @param {string|null} [input.approvedBy] — named human approver; required
 *   for a valid T1-slice waiver
 */
export function computeSizeBudget({
  nameStatusOutput = "",
  diffOutput = "",
  numstatOutput = "",
  sizeConfig = {},
  configErrors = [],
  waived = false,
  approvedBy = null,
} = {}) {
  const testDiscount = typeof sizeConfig?.testDiscount === "number" ? sizeConfig.testDiscount : DEFAULT_TEST_DISCOUNT;
  const absoluteHardLoc = typeof sizeConfig?.absoluteHardLoc === "number" ? sizeConfig.absoluteHardLoc : DEFAULT_ABSOLUTE_HARD_LOC;
  const tiers = sizeConfig?.tiers ?? {};
  const defaultTier = { ...DEFAULT_TIER_DEFAULTS, ...(tiers.default ?? {}) };
  const t1Tier = tiers.t1 ?? null;

  const diffAnalysis = analyzeDiff({ nameStatusOutput, diffOutput });
  const files = parseNumstatZ(numstatOutput);

  const tierLoc = { default: 0, t1: 0, t3: 0 };
  // Denominator for the unclassified-ratio fail-closed check: source-like
  // changed lines only (code + test + unknown). docs/config/ci are
  // legitimately-zero-LOC categories the classifier already excludes from
  // logicLoc; counting them here would let padding a non-JS-source PR with
  // docs/config dilute the unclassified fraction below the block threshold
  // while wholeLogicLoc stays silently at (or near) 0.
  let sourceChangedLines = 0;
  let unclassifiedChangedLines = 0;
  // A configured t1/t3 pattern is an explicit operator signal that a path is
  // risk-slice/relaxed-tier; a matching file that classifies outside
  // code/test still drops its LOC to 0 (docs/config/ci/unknown all excluded
  // above), which would silently defeat that signal rather than the intended
  // "code the classifier does not recognize" gap.
  let tierPatternDroppedToZero = false;
  const tierPatterns = [...(tiers.t1?.patterns ?? []), ...(tiers.t3?.patterns ?? [])];
  for (const file of files) {
    const category = classifyFile(file.path);
    const changedLines = file.added + file.deleted;
    if (category === "unknown") {
      sourceChangedLines += changedLines;
      unclassifiedChangedLines += changedLines;
    } else if (category === "code" || category === "test") {
      sourceChangedLines += changedLines;
    }
    let logic = 0;
    if (category === "code") logic = changedLines;
    else if (category === "test") logic = testDiscount * changedLines;
    else {
      if (changedLines > 0 && matchesAnyPattern(file.path, tierPatterns)) tierPatternDroppedToZero = true;
      continue; // docs/config/ci/unknown excluded — covers generated/lockfile content
    }
    const tier = resolveFileTier(file.path, tiers);
    tierLoc[tier] += logic;
  }
  // Round each tier's unrounded subtotal once, then derive wholeLogicLoc as
  // the SUM of the rounded tiers rather than independently rounding the
  // unrounded total — otherwise fractional per-tier subtotals (testDiscount
  // applied per test file) can round down to 0 in each tier while their sum
  // rounds up to 1, leaving the reported breakdown unable to reconcile with
  // wholeLogicLoc. Summing the already-rounded tiers keeps the breakdown
  // additive by construction.
  const tierLogicLoc = {
    default: Math.round(tierLoc.default),
    t1: Math.round(tierLoc.t1),
    t3: Math.round(tierLoc.t3),
  };
  const wholeLoc = tierLogicLoc.default + tierLogicLoc.t1 + tierLogicLoc.t3;
  const t1SliceLoc = tierLogicLoc.t1;
  const unclassifiedRatio = sourceChangedLines > 0 ? unclassifiedChangedLines / sourceChangedLines : 0;
  const substantiallyUnclassified = unclassifiedRatio > UNCLASSIFIED_BLOCK_RATIO || tierPatternDroppedToZero;

  const reasons = [];
  let outcome = "pass";

  const configErrorCount = Array.isArray(configErrors) ? configErrors.length : 0;
  if (configErrorCount > 0) {
    outcome = "block";
    reasons.push(`config errors present (${configErrorCount}) from loadDevLoopConfig; a broken .devloops must not silently weaken the size gate — no waiver possible`);
  }
  if (diffAnalysis.ambiguous) {
    outcome = "block";
    reasons.push("diff is unclassifiable (ambiguous change categories); size budget cannot be computed safely — no waiver possible");
  }
  if (substantiallyUnclassified) {
    outcome = "block";
    reasons.push(
      tierPatternDroppedToZero
        ? "a configured t1/t3 pattern matched a file that classifies outside code/test (its logic LOC would silently drop to 0); size budget cannot be computed safely — no waiver possible"
        : `substantial unclassified/non-JS source (${Math.round(unclassifiedRatio * 100)}% of source-like changed lines); size budget cannot be computed safely — no waiver possible`,
    );
  }
  if (wholeLoc > absoluteHardLoc) {
    outcome = "block";
    reasons.push(`whole-PR logic LOC (${wholeLoc}) exceeds absoluteHardLoc (${absoluteHardLoc}); no waiver possible`);
  }

  // Every branch above blocks with no waiver possible; a waiver flag must
  // never read true once one of them has already fired, or a Phase-2
  // consumer keying off waiver.*Valid could mis-record a hard-blocked PR.
  const unwaivableBlock = configErrorCount > 0 || diffAnalysis.ambiguous || substantiallyUnclassified || wholeLoc > absoluteHardLoc;

  let t1WaiverValid = false;
  if (t1Tier && typeof t1Tier.sliceHardLoc === "number" && t1SliceLoc > t1Tier.sliceHardLoc) {
    const waiverRequestValid = waived === true && typeof approvedBy === "string" && approvedBy.trim().length > 0;
    t1WaiverValid = waiverRequestValid && !unwaivableBlock;
    if (t1WaiverValid) {
      reasons.push(`T1-slice logic LOC (${t1SliceLoc}) exceeds t1.sliceHardLoc (${t1Tier.sliceHardLoc}); waived by ${approvedBy.trim()}`);
    } else {
      outcome = "block";
      reasons.push(
        waiverRequestValid && unwaivableBlock
          ? `T1-slice logic LOC (${t1SliceLoc}) exceeds t1.sliceHardLoc (${t1Tier.sliceHardLoc}); no waiver possible alongside an unwaivable block`
          : waived === true
            ? `T1-slice logic LOC (${t1SliceLoc}) exceeds t1.sliceHardLoc (${t1Tier.sliceHardLoc}); a T1 waiver requires --approved-by naming a human approver`
            : `T1-slice logic LOC (${t1SliceLoc}) exceeds t1.sliceHardLoc (${t1Tier.sliceHardLoc}); not waived`,
      );
    }
  }

  let defaultWaiverValid = false;
  if (typeof defaultTier.waiverLoc === "number" && wholeLoc > defaultTier.waiverLoc) {
    defaultWaiverValid = waived === true && !unwaivableBlock;
    if (defaultWaiverValid) {
      reasons.push(`whole-PR logic LOC (${wholeLoc}) exceeds default.waiverLoc (${defaultTier.waiverLoc}); waived`);
    } else {
      outcome = "block";
      reasons.push(
        waived === true && unwaivableBlock
          ? `whole-PR logic LOC (${wholeLoc}) exceeds default.waiverLoc (${defaultTier.waiverLoc}); no waiver possible alongside an unwaivable block`
          : `whole-PR logic LOC (${wholeLoc}) exceeds default.waiverLoc (${defaultTier.waiverLoc}); not waived`,
      );
    }
  }

  if (outcome !== "block" && typeof defaultTier.softLoc === "number" && wholeLoc > defaultTier.softLoc) {
    outcome = "escalate";
    reasons.push(`whole-PR logic LOC (${wholeLoc}) exceeds default.softLoc (${defaultTier.softLoc}); escalating review requirements`);
  }

  return {
    ok: outcome === "pass",
    outcome,
    wholeLogicLoc: wholeLoc,
    t1SliceLoc,
    tierLogicLoc,
    thresholds: {
      testDiscount,
      absoluteHardLoc,
      default: { softLoc: defaultTier.softLoc ?? null, waiverLoc: defaultTier.waiverLoc ?? null },
      t1: t1Tier ? { sliceHardLoc: t1Tier.sliceHardLoc ?? null } : null,
    },
    ambiguous: diffAnalysis.ambiguous,
    configErrorCount,
    waiver: {
      requested: waived === true,
      approvedBy: typeof approvedBy === "string" && approvedBy.trim().length > 0 ? approvedBy.trim() : null,
      t1Valid: t1WaiverValid,
      defaultValid: defaultWaiverValid,
    },
    reasons,
  };
}

// ---------------------------------------------------------------------------
// Git capture + CLI
// ---------------------------------------------------------------------------

/**
 * Capture the three diff views this check needs against `${base}...${head}`:
 * name-status + full diff (feed the shared classifier's ambiguity check) and
 * `--numstat -z` (feeds per-file LOC — see parseNumstatZ). Isolated from
 * ambient git config the same way captureDiffFromBase is (see
 * scripts/github/write-gate-context.mjs) so the byte-for-byte diff/LOC counts
 * a run produces don't depend on the operator's local git config.
 */
function captureSizeBudgetDiff({ base, head = "HEAD", repoRoot = process.cwd(), maxBuffer = 64 * 1024 * 1024 }) {
  const range = `${base}...${head}`;
  const isolation = [
    "-c", "color.ui=false",
    "-c", "color.diff=false",
    "-c", "core.pager=cat",
    "-c", "diff.noprefix=false",
    "-c", "diff.mnemonicPrefix=false",
    "-c", "diff.renames=true",
    "-c", "diff.algorithm=myers",
    "-c", "diff.context=3",
    "-c", "core.abbrev=12",
    "-c", "core.autocrlf=false",
  ];
  const runGit = (args) => execFileSync("git", [...isolation, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer,
    env: gitEnvWithoutDirOverrides(),
  });
  try {
    return {
      nameStatusOutput: runGit(["diff", "--no-ext-diff", "--name-status", range]),
      diffOutput: runGit(["diff", "--no-ext-diff", range]),
      numstatOutput: runGit(["diff", "--no-ext-diff", "--numstat", "-z", range]),
    };
  } catch (err) {
    throw new Error(`git diff against --base ${JSON.stringify(base)} failed: ${err?.message ?? err}`);
  }
}

function assertPlausibleRef(ref, label, onError) {
  if (ref.length === 0 || ref.startsWith("-") || ref.includes("..")) {
    throw onError(`${label} must be a plausible git ref (no leading '-', no '..')`);
  }
}

export function parseCheckSizeBudgetCliArgs(argv) {
  const options = { help: false, base: null, head: null, waived: false, approvedBy: null };
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      base: { type: "string" },
      head: { type: "string" },
      waived: { type: "boolean" },
      "approved-by": { type: "string" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  for (const token of tokens) {
    if (token.kind === "positional") throw parseError(`Unknown argument: ${token.value}`);
    if (token.kind !== "option") continue;
    if (token.name === "help") { options.help = true; return options; }
    if (token.name === "base") { options.base = requireTokenValue(token, parseError).trim(); continue; }
    if (token.name === "head") { options.head = requireTokenValue(token, parseError).trim(); continue; }
    if (token.name === "waived") { options.waived = true; continue; }
    if (token.name === "approved-by") { options.approvedBy = requireTokenValue(token, parseError).trim(); continue; }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (!options.base) throw parseError("check-size-budget requires --base <ref>");
  // Same denylist rationale as write-gate-context.mjs's normalizeBaseRef: the
  // git call runs via execFileSync's argv array (no shell), so this only
  // needs to reject shapes that are unsafe/malformed for OUR "<base>...<head>"
  // construction, not enumerate every valid git revision grammar. --head feeds
  // the identical range construction, so it gets the same denylist.
  assertPlausibleRef(options.base, "--base", parseError);
  if (options.head) assertPlausibleRef(options.head, "--head", parseError);
  return options;
}

export async function runCli(argv = process.argv.slice(2), { repoRoot = process.cwd() } = {}) {
  const options = parseCheckSizeBudgetCliArgs(argv);
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return { ok: true, help: true };
  }
  const { config, errors: configErrors } = await loadDevLoopConfig({ repoRoot });
  const sizeConfig = config?.gates?.size ?? {};
  const { nameStatusOutput, diffOutput, numstatOutput } = captureSizeBudgetDiff({
    base: options.base,
    head: options.head ?? "HEAD",
    repoRoot,
  });
  const result = computeSizeBudget({
    nameStatusOutput,
    diffOutput,
    numstatOutput,
    sizeConfig,
    configErrors,
    waived: options.waived,
    approvedBy: options.approvedBy,
  });
  process.exitCode = emitResult(result, { jq: options.jq, silent: options.silent });
  return result;
}

if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${formatCliError(error, { usage: USAGE })}\n`);
    process.exitCode = 2;
  });
}
