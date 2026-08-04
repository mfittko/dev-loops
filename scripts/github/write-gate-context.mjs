#!/usr/bin/env node
/**
 * write-gate-context.mjs — context-builder handoff artifact writer.
 *
 * The gate-review context-builder (Phase 1 of the gate-review sub-loop) resolves
 * the dynamic review-angle set and writes a deterministic JSON handoff artifact
 * that the downstream fork fan-out reviewers consume. This module owns that
 * artifact: a deterministic path builder, a writer, and a reader for round-trip
 * use, plus a thin context-builder entrypoint (`buildGateContext`) that derives
 * the angle set + rationale directly from the canonical resolver.
 *
 * Angle resolution is NOT re-implemented here. The single source of truth is
 * `resolveGateAnglesDynamic(config, gate, { diff })` from @dev-loops/core/config:
 * it honors the mandatory-angle floor (mandatory angles are always merged back
 * after dynamic selection, filtered by excludeAngles) and falls back to the
 * static configured pool when dynamic angle resolution is off or no diff is available.
 * This module maps that resolver's output into the persisted artifact:
 *   resolvedAngles  = resolver.recommendedAngles
 *   rationale       = resolver.skippedAngles (action 'dropped', reason from
 *                     resolver.reasons) + the rest as action 'kept', except
 *                     entries present in resolver.addedAngles are recorded as
 *                     action 'added' (reason from resolver.addedReasons) — see #1048
 *
 * The artifact records the resolved angle set + rationale + change scope
 * (branch, head SHA, touched files, acceptance-criteria pointer, validation
 * posture) so reviewers receive a stable, auditable briefing per head SHA.
 *
 * Path scheme mirrors write-gate-findings-log.mjs `buildLogPath`:
 *   <tmpRoot>/gate-context/<repo-slug>/pr-<N>/<gate>-<headSha>.json
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { GATE_FULL_LABEL, loadDevLoopConfig, resolveGateAnglesDynamic } from "@dev-loops/core/config";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { detectIssueRefinementArtifact } from "@dev-loops/core/loop/issue-refinement-artifact";
import { CHECKPOINT_SENTINEL_PREFIX } from "./verify-fresh-review-context.mjs";

import { parsePrNumber, requireTokenValue, runChild } from "../_cli-primitives.mjs";
import { formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { viewPr } from "./view-pr.mjs";
import { viewIssue } from "./view-issue.mjs";
import { buildAdjacentBundle, DEFAULT_MAX_FILE_BYTES } from "./build-adjacent-bundle.mjs";
import { GATE_NAMES } from "./_gate-names.mjs";
import { resolveLinkedIssuesFromPr } from "../loop/detect-pr-gate-coordination-state.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";

/**
 * Map the artifact gate name (draft_gate | pre_approval_gate) to the config
 * gate key understood by resolveGateAnglesDynamic (draft | preApproval).
 * @param {string} gate
 * @returns {"draft"|"preApproval"}
 */
export function mapGateToConfigKey(gate) {
  if (gate === "draft_gate") return "draft";
  if (gate === "pre_approval_gate") return "preApproval";
  throw new Error(`Unknown gate: ${JSON.stringify(gate)} (expected draft_gate or pre_approval_gate)`);
}

/**
 * The env every `git` child process spawned by this module (and by
 * resolve-angle-carry-forward.mjs, which shares assertWorktreeAtHead) must run
 * with: process.env minus GIT_DIR/GIT_WORK_TREE. An exported GIT_DIR overrides
 * repo discovery outright — `git -C <cwd> rev-parse HEAD` with GIT_DIR set
 * elsewhere resolves the OTHER repo's HEAD regardless of cwd. Every caller here
 * means "the worktree at `cwd`"; route every git spawn through this one helper
 * so the worktree guard and the diff/delta it gates can never disagree about
 * which repo they mean.
 * @returns {NodeJS.ProcessEnv}
 */
export function gitEnvWithoutDirOverrides() {
  return { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined };
}

/**
 * Map a resolveGateAnglesDynamic result into the persisted artifact fields.
 * Does NOT re-derive angles — it only reshapes the resolver's output.
 *
 * Angles present in `resolverResult.addedAngles` (additive selection, #1048)
 * are recorded with action 'added' (reason from `resolverResult.addedReasons`)
 * instead of 'kept'.
 *
 * @param {{ recommendedAngles: string[]|null, skippedAngles?: string[], reasons?: Record<string,string>, addedAngles?: string[], addedReasons?: Record<string,string>, dynamicAnglesActive?: boolean }} resolverResult
 * @returns {{ resolvedAngles: string[], rationale: Array<{angle: string, action: "kept"|"added"|"dropped", reason: string}> }}
 */
export function rationaleFromResolver(resolverResult) {
  const recommended = Array.isArray(resolverResult?.recommendedAngles)
    ? resolverResult.recommendedAngles
    : [];
  const skipped = Array.isArray(resolverResult?.skippedAngles)
    ? resolverResult.skippedAngles
    : [];
  const reasons = resolverResult?.reasons ?? {};
  const added = new Set(Array.isArray(resolverResult?.addedAngles) ? resolverResult.addedAngles : []);
  const addedReasons = resolverResult?.addedReasons ?? {};
  const dynamicActive = resolverResult?.dynamicAnglesActive === true;
  const keptReason = dynamicActive
    ? "selected by dynamic angle resolver"
    : "static pool (dynamic angle resolution inactive)";

  const rationale = [];
  for (const angle of recommended) {
    if (added.has(angle) && dynamicActive) {
      rationale.push({
        angle,
        action: "added",
        reason: typeof addedReasons[angle] === "string" && addedReasons[angle].length > 0
          ? addedReasons[angle]
          : "added by dynamic angle resolver (catalog addition)",
      });
      continue;
    }
    rationale.push({ angle, action: "kept", reason: keptReason });
  }
  for (const angle of skipped) {
    rationale.push({
      angle,
      action: "dropped",
      reason: typeof reasons[angle] === "string" && reasons[angle].length > 0
        ? reasons[angle]
        : "not relevant to the change set",
    });
  }
  return { resolvedAngles: [...recommended], rationale };
}

const USAGE = `Usage: write-gate-context.mjs --repo <owner/name> --pr <number> --gate <draft_gate|pre_approval_gate> --head-sha <sha> [--angles <json>] [--rationale <json>] [--branch <name>] [--touched-files <json>] [--base <ref>] [--acceptance-criteria <pointer>] [--pr-body <text>] [--issue-body <text>] [--prefix-file <path>] [--validation-posture <text>] [--tmp-root <path>]
Write a deterministic gate-review context-builder handoff artifact under tmp/ paths.
Required:
  --repo <owner/name>
  --pr <number>
  --gate <draft_gate|pre_approval_gate>
  --head-sha <sha>
Optional:
  --angles <json>               JSON array of review-angle name strings. OPTIONAL: when omitted, angles resolve dynamically from the loaded config (.devloops) + the --base diff via resolveGateAnglesDynamic (the same path buildGateContext uses). When supplied, the list is used VERBATIM as an explicit override (dynamic resolution is bypassed) — an escape hatch for forcing a specific angle set.
  --rationale <json>             JSON array of {angle, action, reason} entries
  --branch <name>                Source branch name
  --touched-files <json>         JSON array of changed file path strings (separate from the diff-derived scope.changedFiles)
  --base <ref>                   Git ref to diff against (git diff <ref>...HEAD); populates scope.diffPath, scope.changedFiles, and adjacentCode (the full build-once bundle). Without it, the CLI emits an explicit thin briefing (scope.diffSource="none") — see skills/docs/gate-review-sub-loop-contract.md.
  --acceptance-criteria <ptr>    Pointer to acceptance criteria (issue ref, doc path, URL); also used as the linked-issue label in the rendered briefing prefix. OPTIONAL: when omitted it resolves to the PR's closing issue reference.
  --validation-posture <text>    Short description of the validation posture
  --pr-body <text>               PR description text, inlined into the rendered briefing prefix. OPTIONAL: when omitted the live PR body is fetched from GitHub. An unreadable PR fails closed rather than rendering the PR as description-less.
  --issue-body <text>            Linked-issue body text, inlined into the briefing prefix under --acceptance-criteria's label. OPTIONAL: when omitted it is fetched from the PR's closing issue reference, but ONLY when --acceptance-criteria is also omitted — supplying --acceptance-criteria suppresses the issue-body fetch, so pass --issue-body too if the prefix should still carry issue text. Omitted from the prefix entirely when the PR closes no issue.
  --prefix-file <path>           Record the EXACT BYTES of this file as the briefing-prefix record (<gate>-<headSha>.briefing-prefix.txt) instead of this module's self-rendered prefix — no rendering, no trailing-newline normalization. The emitted prefixHash is the sha256 of those exact bytes and the result/artifact report prefixMode:"file". For an orchestrator that already briefed reviewers with its OWN rendered prefix, this is what lets it record THAT byte sequence so verify-briefing-prefixes.mjs matches. Fails closed (exit 1) if the file is missing, unreadable, or empty. Skips the GitHub spec-of-record resolution (--pr-body/--issue-body/--acceptance-criteria) entirely — the recorded bytes come from this file, so a fetched PR/issue body could never reach them, and the CLI never touches GitHub in this mode at all (--base only runs local git reads). Omit for the default self-rendered prefix (prefixMode inline|pointer).
  --validation-results <path>    Path to the run-gate-validation.mjs artifact (GATE-EXEC-VALIDATION-ARTIFACT) recording this round's validation suites, run once for every reviewer of this gate pass to read instead of re-running. Resolved to an absolute path and recorded at scope.validationResultsPath, and appends a trailing "## Validation results at this head" section to the rendered briefing prefix (self-rendered mode only — ignored under --prefix-file, whose bytes are recorded verbatim). Fails closed (exit 1) if the file is missing or unreadable. Omit for no validation-results section (byte-identical to before this flag existed).
  --full-label                   The PR carries the gate:full label: dynamic angle resolution skips diff-class tier reduction (resolveGateTier returns gate_full_label) and resolves the untriered angle set. Only meaningful when --angles is omitted. When this flag is absent (and --prefix-file is not in use), the label is derived from the live PR via a labels read; a failed read fails closed to the untriered set. Under --prefix-file the CLI never touches GitHub, so the label cannot be derived and an omitted flag likewise fails closed to the untriered set (pass --angles to force a specific set there).
  --tmp-root <path>              Root tmp directory (default: tmp/)

${JQ_OUTPUT_USAGE}
`.trim();

function parseError(message) {
  return Object.assign(new Error(message), { usage: USAGE });
}

function normalizeGate(value) {
  const gates = new Set(GATE_NAMES);
  const normalized = String(value).trim().toLowerCase();
  return gates.has(normalized) ? normalized : null;
}

function normalizeHeadSha(value) {
  const normalized = String(value).trim().toLowerCase();
  return /^[0-9a-f]{7,64}$/i.test(normalized) ? normalized : null;
}

// ponytail: a DENYLIST, not an allowlist — the `git diff` call runs via
// execFileSync's argv array (no shell), so `base` cannot inject shell syntax
// and we don't need to enumerate every valid git revision grammar. We reject
// only what is genuinely unsafe or malformed for OUR use, and let `git diff`
// itself resolve validity (a syntactically-allowed but nonexistent ref fails
// closed via the unresolvable-base path). Rejected: empty/whitespace-only; a
// leading "-" (flag-injection shape, never a valid ref); and ".." (ambiguous
// with our own "<base>...HEAD" triple-dot construction). Everything else —
// including HEAD@{upstream}, main@{1}, tag-peel v1.0.0^{commit}, HEAD~3 — is
// accepted.
// Revisit toward an explicit allowlist if `base` ever reaches a shell (or any
// call without execFileSync's no-shell argv guarantee), or if a malformed ref
// shape is found slipping past these checks into `git diff`.
function normalizeBaseRef(value) {
  const trimmed = String(value).trim();
  if (trimmed.length === 0 || trimmed.startsWith("-") || trimmed.includes("..")) return null;
  return trimmed;
}

const VALID_ACTIONS = new Set(["kept", "added", "dropped", "joined"]);

function parseAnglesJson(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw parseError("--angles must be valid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw parseError("--angles must be a JSON array");
  }
  return parsed.map((a, i) => {
    if (typeof a !== "string" || a.trim().length === 0) {
      throw parseError(`--angles[${i}] must be a non-empty string`);
    }
    return a.trim();
  });
}

function parseRationaleJson(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw parseError("--rationale must be valid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw parseError("--rationale must be a JSON array");
  }
  return parsed.map((r, i) => {
    if (!r || typeof r !== "object" || Array.isArray(r)) {
      throw parseError(`--rationale[${i}] must be an object`);
    }
    if (!r.angle || typeof r.angle !== "string" || r.angle.trim().length === 0) {
      throw parseError(`--rationale[${i}].angle is required`);
    }
    if (!r.action || !VALID_ACTIONS.has(r.action)) {
      throw parseError(`--rationale[${i}].action must be one of: kept, added, dropped, joined`);
    }
    if (!r.reason || typeof r.reason !== "string" || r.reason.trim().length === 0) {
      throw parseError(`--rationale[${i}].reason is required`);
    }
    return { angle: r.angle.trim(), action: r.action, reason: r.reason.trim() };
  });
}

function parseStringArrayJson(raw, label) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw parseError(`${label} must be valid JSON`);
  }
  if (!Array.isArray(parsed)) {
    throw parseError(`${label} must be a JSON array`);
  }
  return parsed.filter((x) => typeof x === "string" && x.trim().length > 0).map((x) => x.trim());
}

export function parseWriteGateContextCliArgs(argv) {
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      pr: { type: "string" },
      gate: { type: "string" },
      "head-sha": { type: "string" },
      angles: { type: "string" },
      rationale: { type: "string" },
      branch: { type: "string" },
      "touched-files": { type: "string" },
      base: { type: "string" },
      "acceptance-criteria": { type: "string" },
      "validation-posture": { type: "string" },
      "pr-body": { type: "string" },
      "issue-body": { type: "string" },
      "prefix-file": { type: "string" },
      "validation-results": { type: "string" },
      "full-label": { type: "boolean" },
      "tmp-root": { type: "string" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  const options = {
    repo: undefined,
    pr: undefined,
    gate: undefined,
    headSha: undefined,
    angles: undefined,
    rationale: [],
    branch: null,
    touchedFiles: [],
    base: null,
    acceptanceCriteria: null,
    validationPosture: null,
    prBody: null,
    issueBody: null,
    prefixFile: null,
    validationResultsPath: null,
    fullLabel: false,
    tmpRoot: "tmp",
  };
  for (const token of tokens) {
    if (token.kind === "positional") {
      throw parseError(`Unknown argument: ${token.value}`);
    }
    if (token.kind !== "option") {
      continue;
    }
    if (token.name === "help") {
      return { help: true };
    }
    if (token.name === "repo") {
      const repo = requireTokenValue(token, parseError).trim();
      try {
        parseRepoSlug(repo);
      } catch (error) {
        throw parseError(error instanceof Error ? error.message : String(error));
      }
      options.repo = repo;
      continue;
    }
    if (token.name === "pr") {
      options.pr = parsePrNumber(requireTokenValue(token, parseError), parseError);
      continue;
    }
    if (token.name === "gate") {
      const gate = normalizeGate(requireTokenValue(token, parseError));
      if (!gate) throw parseError("--gate must be draft_gate or pre_approval_gate");
      options.gate = gate;
      continue;
    }
    if (token.name === "head-sha") {
      const sha = normalizeHeadSha(requireTokenValue(token, parseError));
      if (!sha) throw parseError("--head-sha must be a 7-64 character hex SHA");
      options.headSha = sha;
      continue;
    }
    if (token.name === "angles") {
      options.angles = parseAnglesJson(requireTokenValue(token, parseError));
      continue;
    }
    if (token.name === "rationale") {
      options.rationale = parseRationaleJson(requireTokenValue(token, parseError));
      continue;
    }
    if (token.name === "branch") {
      options.branch = requireTokenValue(token, parseError).trim();
      continue;
    }
    if (token.name === "touched-files") {
      options.touchedFiles = parseStringArrayJson(requireTokenValue(token, parseError), "--touched-files");
      continue;
    }
    if (token.name === "base") {
      const base = normalizeBaseRef(requireTokenValue(token, parseError));
      if (!base) throw parseError("--base must be a plausible git ref (no leading '-', no '..')");
      options.base = base;
      continue;
    }
    if (token.name === "acceptance-criteria") {
      options.acceptanceCriteria = requireTokenValue(token, parseError).trim();
      continue;
    }
    if (token.name === "validation-posture") {
      options.validationPosture = requireTokenValue(token, parseError).trim();
      continue;
    }
    if (token.name === "pr-body") {
      options.prBody = requireTokenValue(token, parseError);
      continue;
    }
    if (token.name === "issue-body") {
      options.issueBody = requireTokenValue(token, parseError);
      continue;
    }
    if (token.name === "prefix-file") {
      const trimmed = requireTokenValue(token, parseError).trim();
      if (trimmed.length === 0) {
        throw parseError("--prefix-file must not be empty/whitespace-only");
      }
      options.prefixFile = trimmed;
      continue;
    }
    if (token.name === "validation-results") {
      const trimmed = requireTokenValue(token, parseError).trim();
      if (trimmed.length === 0) {
        throw parseError("--validation-results must not be empty/whitespace-only");
      }
      options.validationResultsPath = trimmed;
      continue;
    }
    if (token.name === "full-label") {
      options.fullLabel = true;
      continue;
    }
    if (token.name === "tmp-root") {
      options.tmpRoot = requireTokenValue(token, parseError).trim();
      continue;
    }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  const missing = ["repo", "pr", "gate", "headSha"]
    .filter((k) => options[k] === undefined);
  if (missing.length > 0) {
    throw parseError(`Missing required arguments: ${missing.join(", ")}`);
  }
  return options;
}

/**
 * Build the deterministic artifact path for a gate-review context handoff.
 * Mirrors write-gate-findings-log.mjs buildLogPath. Exported for reuse by the
 * fork fan-out reviewers so producer and consumer agree on the path.
 *
 * @param {object} input
 * @param {string} input.repo — owner/name
 * @param {number|string} input.pr
 * @param {string} input.gate — draft_gate | pre_approval_gate
 * @param {string} input.headSha
 * @param {string} [input.tmpRoot] — default "tmp"
 * @returns {string} relative artifact path
 */
export function buildGateContextPath({ repo, pr, gate, headSha, tmpRoot = "tmp" }) {
  const repoSlug = repoSlugFor(repo);
  const { pr: safePr, gate: safeGate, headSha: safeSha } = validatePathSegments({ pr, gate, headSha });
  return path.join(tmpRoot, "gate-context", repoSlug, `pr-${safePr}`, `${safeGate}-${safeSha}.json`);
}

/**
 * Validate the non-repo path components (gate, pr, headSha) that are
 * interpolated into a filesystem path which is later `path.resolve()`d and
 * read/written. Mirrors the repo-segment safety check in {@link repoSlugFor} so
 * both path builders reject traversal sequences and odd filenames coming from
 * untrusted inputs. Returns sanitized values for interpolation.
 *
 * @param {object} input
 * @param {number|string} input.pr — must coerce to a positive integer
 * @param {string} input.gate — draft_gate | pre_approval_gate
 * @param {string} input.headSha — 7-64 char hex SHA
 * @returns {{ pr: number, gate: string, headSha: string }}
 */
function validatePathSegments({ pr, gate, headSha }) {
  if (!GATE_NAMES.includes(gate)) {
    throw new Error(`--gate segment ${JSON.stringify(gate)} is unsafe (expected ${GATE_NAMES.join(" or ")})`);
  }
  // Require a CANONICAL positive integer: the trimmed string must be all digits
  // (`/^\d+$/`) and > 0. This mirrors the CLI's parsePrNumber rule so the path
  // builder cannot accept non-canonical numeric forms ("1e3" → 1000, "0x10" →
  // 16, "1.5") that Number() would coerce to a DIFFERENT pr-<N> segment than the
  // operator/CLI intended, breaking the deterministic producer/consumer
  // round-trip. " 9 " trims to "9" and stays valid; numbers are stringified first.
  const prStr = String(pr).trim();
  const prNum = Number(prStr);
  if (!/^\d+$/.test(prStr) || !Number.isInteger(prNum) || prNum <= 0) {
    throw new Error(`--pr segment ${JSON.stringify(pr)} is unsafe (expected a positive integer)`);
  }
  // Lowercase the validated SHA so the path segment is case-canonical regardless
  // of caller casing, matching the CLI's normalizeHeadSha. A mixed-case
  // headRefOid (e.g. ABC123) must compute the SAME filename as its lowercase
  // form (abc123) or readGateContext / the .diff lookup would miss it — a
  // determinism bug.
  const sha = String(headSha).trim().toLowerCase();
  if (!/^[0-9a-f]{7,64}$/i.test(sha)) {
    throw new Error(`--head-sha segment ${JSON.stringify(headSha)} is unsafe (expected a 7-64 character hex SHA)`);
  }
  return { pr: prNum, gate, headSha: sha };
}

/**
 * Validate the repo string and return its `owner-name` slug, applying the same
 * safety checks (no `.`/`..` segments, no whitespace/backslashes) shared by the
 * artifact and diff path builders.
 * @param {string} repo — owner/name
 * @returns {string} repo slug
 */
function repoSlugFor(repo) {
  const parts = String(repo).split("/");
  if (parts.length !== 2 || parts.some((p) => p.length === 0)) {
    throw new Error(`--repo must be in owner/name format, got: ${JSON.stringify(repo)}`);
  }
  for (const p of parts) {
    if (p === "." || p === ".." || /[\s\\]/.test(p)) {
      throw new Error(`--repo segment ${JSON.stringify(p)} is unsafe (a "." or ".." path segment, or contains whitespace/backslashes)`);
    }
  }
  return parts.join("-");
}

/**
 * Build the deterministic path for the FULL diff captured alongside the gate
 * context artifact. Mirrors buildGateContextPath but with a `.diff` extension so
 * scoped reviewers can read the entire change set (not just hunks) from a stable
 * location. Exported for reuse by the fork fan-out reviewers.
 *
 * @param {object} input
 * @param {string} input.repo — owner/name
 * @param {number|string} input.pr
 * @param {string} input.gate — draft_gate | pre_approval_gate
 * @param {string} input.headSha
 * @param {string} [input.tmpRoot] — default "tmp"
 * @returns {string} relative diff path
 */
export function buildGateDiffPath({ repo, pr, gate, headSha, tmpRoot = "tmp" }) {
  const repoSlug = repoSlugFor(repo);
  const { pr: safePr, gate: safeGate, headSha: safeSha } = validatePathSegments({ pr, gate, headSha });
  return path.join(tmpRoot, "gate-context", repoSlug, `pr-${safePr}`, `${safeGate}-${safeSha}.diff`);
}

/**
 * Build the deterministic path for the rendered invariant briefing prefix
 * (GATE-EXEC-BRIEFING-PREFIX): the byte-identical block every per-angle
 * reviewer of this gate pass is seeded with, before their angle-specific
 * suffix. Mirrors buildGateContextPath/buildGateDiffPath. Exported so the
 * fan-out reviewers and `verify-fresh-review-context.mjs --prefix-file` agree
 * on the path with the context-builder.
 *
 * @param {object} input
 * @param {string} input.repo — owner/name
 * @param {number|string} input.pr
 * @param {string} input.gate — draft_gate | pre_approval_gate
 * @param {string} input.headSha
 * @param {string} [input.tmpRoot] — default "tmp"
 * @returns {string} relative briefing-prefix path
 */
export function buildGateBriefingPrefixPath({ repo, pr, gate, headSha, tmpRoot = "tmp" }) {
  const repoSlug = repoSlugFor(repo);
  const { pr: safePr, gate: safeGate, headSha: safeSha } = validatePathSegments({ pr, gate, headSha });
  return path.join(tmpRoot, "gate-context", repoSlug, `pr-${safePr}`, `${safeGate}-${safeSha}.briefing-prefix.txt`);
}

/**
 * Build the deterministic path for the shared validation-results artifact
 * (GATE-EXEC-VALIDATION-ARTIFACT, `run-gate-validation.mjs`): the record of
 * this round's validation suites, run once and read (not re-run) by every
 * per-angle reviewer via the briefing-prefix section {@link renderBriefingPrefix}
 * appends when `validationResultsPath` is threaded. Mirrors
 * buildGateContextPath/buildGateDiffPath/buildGateBriefingPrefixPath. Exported
 * so `run-gate-validation.mjs` (the producer) and this module's CLI/context
 * artifact (the consumer that records the path) agree on the location without
 * re-implementing the slug/segment-safety logic.
 *
 * @param {object} input
 * @param {string} input.repo — owner/name
 * @param {number|string} input.pr
 * @param {string} input.gate — draft_gate | pre_approval_gate
 * @param {string} input.headSha
 * @param {string} [input.tmpRoot] — default "tmp"
 * @returns {string} relative validation-results path
 */
export function buildValidationResultsPath({ repo, pr, gate, headSha, tmpRoot = "tmp" }) {
  const repoSlug = repoSlugFor(repo);
  const { pr: safePr, gate: safeGate, headSha: safeSha } = validatePathSegments({ pr, gate, headSha });
  return path.join(tmpRoot, "gate-context", repoSlug, `pr-${safePr}`, `${safeGate}-${safeSha}.validation.json`);
}

/**
 * Size cap (bytes) above which the rendered briefing prefix falls back to
 * pointer mode for the diff section (a scope.diffPath reference when present,
 * else an explicit unavailable-pointer disclosure) instead of inlining the
 * diff text in a fenced block. No `gates.*` config knob exists for this
 * yet — a named constant is the right size for a single fixed threshold;
 * promote to config only if a real need for tuning it emerges.
 */
export const BRIEFING_PREFIX_INLINE_DIFF_CAP_BYTES = 200 * 1024;

/**
 * Rendered when no PR body text reaches the prefix. The CLI resolves the live
 * body itself (resolvePrSpecContext) and fails closed when it cannot, so from
 * the CLI path this wording is reached only for a PR whose description is
 * genuinely empty on GitHub — it is a truthful statement, not the old
 * "(no PR body provided)" which described the CALLER's arguments and read as a
 * claim about the PR. Programmatic callers that pass no `prBody` still land
 * here; that is their explicit choice of a thin briefing.
 */
export const PR_BODY_ABSENT_SENTINEL = "(this PR has an empty description on GitHub)";

/**
 * Rendered in place of an individual linked issue's body when that issue was
 * resolved (it has a closing reference) but its body is genuinely empty on
 * GitHub. Mirrors PR_BODY_ABSENT_SENTINEL: a resolved-but-empty body must read
 * as a truthful, distinguishable statement rather than silently collapsing the
 * `## Linked issue` section (which would then read identically to "the PR
 * closes no issue" — the exact indistinguishability #1511 targets).
 */
export const ISSUE_BODY_ABSENT_SENTINEL = "(this issue has an empty body on GitHub)";

/**
 * Pick a fenced-code-block delimiter that cannot be prematurely closed by the
 * content it will wrap: CommonMark closes a fence at the first line that is a
 * run of backticks at least as long as the opening run, so a delimiter longer
 * than every backtick run already inside `text` always stays open until the
 * delimiter we emit ourselves. Minimum length 3 (the shortest valid fence).
 * @param {string} text
 * @returns {string}
 */
function pickFence(text) {
  const runs = String(text).match(/`+/g);
  const longest = runs ? Math.max(...runs.map((run) => run.length)) : 0;
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * Render the invariant briefing-prefix text (GATE-EXEC-BRIEFING-PREFIX):
 * header (repo/PR/head/gate/worktree + the mandatory verify-fresh-review-context.mjs
 * instruction), PR body, linked-issue body (when present), the full diff at the
 * reviewed head (inlined up to `capBytes`, else a pointer to `diffPath`), and a
 * changed-files/adjacent-code summary — in that fixed order. Pure and
 * deterministic: identical input always renders identical bytes, so two builds
 * at the same head produce a byte-identical prefix (the fan-out's shared-prefix
 * requirement).
 *
 * prBody/issueBody/issueSections/diffOutput are untrusted GitHub text (PR
 * author or linked-issue author controlled) and are each wrapped in their own
 * fenced code block, sized per pickFence(). A fenced block renders as inert
 * literal text, so a hostile body cannot forge a `##` heading (e.g. a second
 * "## Diff at reviewed head" or "## Changed files" section ahead of the real
 * one) or emit either ABSENT_SENTINEL string as if it were the renderer's own
 * statement, and an unbalanced fence inside the body text cannot leak out to
 * swallow a later section. This holds for the multi-issue case too: each
 * issue's `### <label>` heading is emitted by THIS function as a plain line
 * OUTSIDE any fence, immediately followed by that issue's OWN fenced block —
 * never inside another issue's fence — so a hostile issue body cannot forge a
 * `### <label>` heading for a DIFFERENT linked issue (issueSections is
 * structured data, not a pre-joined string carrying the delimiter inside the
 * untrusted region).
 *
 * @param {object} input
 * @param {string} input.repo
 * @param {number|string} input.pr
 * @param {string} input.gate
 * @param {string} input.headSha
 * @param {string} input.worktreeRoot — absolute path reviewers run in
 * @param {string} input.contextPath — the sibling JSON artifact path
 * @param {string} input.briefingPrefixPath — this rendered file's own path
 * @param {string|null} [input.prBody]
 * @param {string|null} [input.issueRef] — label for the linked-issue section heading (e.g. "#877" or "#1496, #1511")
 * @param {string|null} [input.issueBody] — single-issue body, rendered under `issueRef` with no `### <label>` sub-heading. Ignored when `issueSections` is given.
 * @param {{label: string, body: string}[]|null} [input.issueSections] — per-issue bodies for a multi-issue PR (structured, never pre-joined): each renders as a renderer-emitted `### <label>` line OUTSIDE any fence, followed by that issue's OWN pickFence-sized fenced block. Takes precedence over `issueBody` when non-empty.
 * @param {string|null} [input.diffOutput] — full diff text, when captured
 * @param {string|null} [input.diffPath] — persisted `.diff` pointer (pointer-mode fallback)
 * @param {string[]} [input.changedFiles]
 * @param {object|null} [input.adjacentCode] — buildAdjacentBundle output
 * @param {string|null} [input.validationResultsPath] — absolute path to the
 *   run-gate-validation.mjs artifact for this head SHA (GATE-EXEC-VALIDATION-ARTIFACT).
 *   When non-empty, ONE additional `## Validation results at this head` section is
 *   appended LAST, after the changed-files summary. Omitted entirely when absent
 *   (byte-identical to the pre-AC3 prefix).
 * @param {number} [input.capBytes] — default BRIEFING_PREFIX_INLINE_DIFF_CAP_BYTES
 * @returns {{ text: string, prefixMode: "inline"|"pointer", diffBytes: number }}
 */
export function renderBriefingPrefix({
  repo, pr, gate, headSha, worktreeRoot, contextPath, briefingPrefixPath,
  prBody = null, issueRef = null, issueBody = null, issueSections = null,
  diffOutput = null, diffPath = null, changedFiles = [], adjacentCode = null,
  validationResultsPath = null,
  capBytes = BRIEFING_PREFIX_INLINE_DIFF_CAP_BYTES,
}) {
  const hasDiffText = typeof diffOutput === "string" && diffOutput.length > 0;
  const diffBytes = hasDiffText ? Buffer.byteLength(diffOutput, "utf8") : 0;
  const prefixMode = hasDiffText && diffBytes > capBytes ? "pointer" : "inline";

  const lines = [];
  lines.push("# Gate Review Briefing — invariant prefix (GATE-EXEC-BRIEFING-PREFIX)");
  lines.push("");
  lines.push(`repo: ${repo}`);
  lines.push(`pr: #${pr}`);
  lines.push(`gate: ${gate}`);
  lines.push(`head: ${headSha}`);
  lines.push(`worktree: ${worktreeRoot}`);
  lines.push(`prefixMode: ${prefixMode}`);
  lines.push("");
  lines.push(
    `Mandatory: before doing any angle-specific work, run \`node scripts/github/verify-fresh-review-context.mjs --scope ${gate.replace(/_/g, "-")}-<your-angle> --context-path ${contextPath} --prefix-file ${briefingPrefixPath}\`. Refuse to proceed on contamination or a missing artifact.`,
  );
  lines.push("");
  lines.push(
    `Shell cwd is NOT trustworthy: each command may start in the primary checkout, not this worktree. Run the mandatory sentinel command above as ONE compound command that enters this worktree first (\`cd "${worktreeRoot}" && node scripts/github/verify-fresh-review-context.mjs ...\`) keeping its cwd-relative --context-path exactly as written (the locality guard depends on that form; do not absolutize it). After it passes, address the tree explicitly for everything else — every git command as \`git -C "${worktreeRoot}" ...\` and every file read via an absolute path under ${worktreeRoot}. A bare \`git branch\`/\`git log\`/\`git diff\` can read the WRONG tree and produce confident false findings. The sentinel's fresh output echoes the directory it ran in as \`repoRoot\`; it must equal the worktree path above.`,
  );
  lines.push("");
  lines.push("## PR body");
  lines.push("");
  const trimmedPrBody = typeof prBody === "string" ? prBody.trim() : "";
  if (trimmedPrBody.length > 0) {
    const prBodyFence = pickFence(trimmedPrBody);
    lines.push(prBodyFence);
    lines.push(trimmedPrBody);
    lines.push(prBodyFence);
  } else {
    lines.push(PR_BODY_ABSENT_SENTINEL);
  }
  lines.push("");
  const hasIssueSections = Array.isArray(issueSections) && issueSections.length > 0;
  const hasIssueBody = !hasIssueSections && typeof issueBody === "string" && issueBody.trim().length > 0;
  if (hasIssueSections) {
    // Structured per-issue data, not a pre-joined string: each `### <label>`
    // heading below is emitted by THIS renderer as a plain line outside any
    // fence, and each issue's body gets its OWN pickFence-sized block — so a
    // hostile body in issue A's fence cannot forge issue B's `### <label>`
    // heading (the delimiter never lives inside the untrusted region it
    // wraps).
    lines.push(`## Linked issue${issueRef ? ` ${issueRef}` : ""}`);
    lines.push("");
    for (const section of issueSections) {
      const label = section?.label;
      const text = typeof section?.body === "string" && section.body.trim().length > 0
        ? section.body.trim()
        : ISSUE_BODY_ABSENT_SENTINEL;
      const fence = pickFence(text);
      lines.push(`### ${label}`);
      lines.push("");
      lines.push(fence);
      lines.push(text);
      lines.push(fence);
      lines.push("");
    }
  } else if (hasIssueBody) {
    const trimmedIssueBody = issueBody.trim();
    const issueBodyFence = pickFence(trimmedIssueBody);
    lines.push(`## Linked issue${issueRef ? ` ${issueRef}` : ""}`);
    lines.push("");
    lines.push(issueBodyFence);
    lines.push(trimmedIssueBody);
    lines.push(issueBodyFence);
    lines.push("");
  }
  lines.push(`## Diff at reviewed head (${headSha})`);
  lines.push("");
  if (!hasDiffText) {
    lines.push("(no diff text captured for this bundle)");
  } else if (prefixMode === "inline") {
    const diffFence = pickFence(diffOutput);
    lines.push(`${diffFence}diff`);
    lines.push(diffOutput.endsWith("\n") ? diffOutput.slice(0, -1) : diffOutput);
    lines.push(diffFence);
  } else {
    lines.push(
      `Diff exceeds the ${capBytes}-byte inline cap (${diffBytes} bytes) — pointer mode. Read the full diff from:`,
    );
    lines.push(`  ${diffPath ?? "(diff pointer unavailable — re-derive with git diff)"}`);
  }
  lines.push("");
  lines.push("## Changed files + adjacent-code summary");
  lines.push("");
  const files = Array.isArray(changedFiles) ? changedFiles : [];
  lines.push(`Changed files (${files.length}):`);
  for (const f of files) lines.push(`- ${f}`);
  const adjacentFiles = adjacentCode && Array.isArray(adjacentCode.files)
    ? adjacentCode.files.filter((f) => f.role !== "changed")
    : [];
  if (adjacentCode) {
    lines.push(`Adjacent files (${adjacentFiles.length}):`);
    for (const f of adjacentFiles) lines.push(`- ${f.path} (${f.role})`);
    lines.push(
      `Stripped: ${adjacentCode.stripped?.length ?? 0}, Truncated: ${adjacentCode.truncated?.length ?? 0}, Missing: ${adjacentCode.missing?.length ?? 0}`,
    );
  } else {
    lines.push("Adjacent files (0): (no adjacent-code bundle for this briefing)");
  }

  const trimmedValidationResultsPath = typeof validationResultsPath === "string"
    ? validationResultsPath.trim()
    : "";
  if (trimmedValidationResultsPath.length > 0) {
    lines.push("");
    lines.push("## Validation results at this head");
    lines.push("");
    lines.push(
      "The gate preamble ran this round's validation suites once and recorded them here:",
    );
    lines.push(`  ${trimmedValidationResultsPath}`);
    lines.push("");
    lines.push(
      "Read that record for suite status, exit codes, and output tails. Executing a suite it",
    );
    lines.push(
      "already records is outside a read-only angle review's scope. If the record is absent,",
    );
    lines.push(
      `unreadable, or stamped with a head SHA other than ${headSha}, say so as a gate-evidence`,
    );
    lines.push("finding instead of substituting your own run.");
  }

  return { text: lines.join("\n") + "\n", prefixMode, diffBytes };
}

/**
 * Parse `git diff --name-status` output into full repo-relative changed file
 * paths. Handles rename/copy entries (R100 old new, C75 old new) by recording
 * the destination path. Tolerates blank lines and malformed rows.
 * @param {string} nameStatusOutput
 * @returns {string[]}
 */
export function parseChangedFiles(nameStatusOutput) {
  if (typeof nameStatusOutput !== "string" || nameStatusOutput.length === 0) {
    return [];
  }
  const files = [];
  for (const line of nameStatusOutput.split("\n")) {
    const trimmed = line.replace(/\r$/, "");
    if (trimmed.trim().length === 0) continue;
    const cols = trimmed.split("\t");
    if (cols.length < 2) continue;
    const status = cols[0].trim();
    let dest;
    if (/^[RC]\d*$/i.test(status)) {
      // Rename (Rxxx) / copy (Cxxx) entries carry status + old + new paths and
      // must have >= 3 columns; record the new (last) path. A malformed 2-column
      // rename/copy row (e.g. "R100\told-path", missing the new path) is skipped
      // rather than misrecording the OLD path as the changed file.
      if (cols.length < 3) continue;
      dest = cols[cols.length - 1];
    } else {
      dest = cols[1];
    }
    const file = (dest ?? "").trim();
    if (file.length > 0) files.push(file);
  }
  return files;
}

/**
 * True when `git diff --name-status` output contains ANY rename (Rxxx) or copy
 * (Cxxx) row. The carry-forward CLI uses this to force the RENAME_ONLY-mapped
 * angles to re-run: `parseChangedFiles` records only a rename's DESTINATION
 * path, so classifying that path alone would miss what the rename itself
 * implicates (a moved doc breaking a link, a moved test/code file shifting
 * scope/contract-surface). Tolerates blank lines and malformed rows.
 * @param {string} nameStatusOutput
 * @returns {boolean}
 */
export function hasRenameEntry(nameStatusOutput) {
  if (typeof nameStatusOutput !== "string" || nameStatusOutput.length === 0) {
    return false;
  }
  for (const line of nameStatusOutput.split("\n")) {
    const status = line.replace(/\r$/, "").split("\t")[0]?.trim() ?? "";
    if (/^[RC]\d*$/i.test(status)) return true;
  }
  return false;
}

/**
 * Build the deterministic artifact object (no I/O). Exported for callers that
 * want the artifact shape without writing it.
 *
 * @param {object} options — parsed CLI options shape
 * @returns {object}
 */
export function buildGateContextArtifact(options) {
  const artifact = {
    repo: options.repo,
    pr: options.pr,
    gate: options.gate,
    headSha: options.headSha,
    resolvedAngles: [...options.angles],
    rationale: Array.isArray(options.rationale) ? options.rationale : [],
    scope: {
      branch: options.branch ?? null,
      headSha: options.headSha,
      touchedFiles: Array.isArray(options.touchedFiles) ? options.touchedFiles : [],
      changedFiles: Array.isArray(options.changedFiles) ? options.changedFiles : [],
      diffPath: options.diffPath ?? null,
      acceptanceCriteria: options.acceptanceCriteria ?? null,
      validationPosture: options.validationPosture ?? null,
      // Absolute path to the run-gate-validation.mjs artifact for this head SHA
      // (GATE-EXEC-VALIDATION-ARTIFACT), threaded into the rendered briefing
      // prefix's trailing "## Validation results at this head" section. Always
      // present (defaulting null) so every caller's scope object has the same
      // key set, unlike the conditionally-added acceptanceCriteriaSource/diffSource
      // fields below (which distinguish "never resolved" from "resolved absent").
      validationResultsPath: options.validationResultsPath ?? null,
    },
  };
  // How scope.acceptanceCriteria came to be — "provided" (caller flag,
  // regardless of whether an issue body was also fetched); "linked-issue"
  // (resolved from the PR's closing reference(s), and at least one resolved
  // issue has an Acceptance-criteria/DoD section or linked refinement doc, per
  // detectIssueRefinementArtifact); "linked-issue-unrefined" (resolved, but
  // every linked issue is prose-only — a distinguishable "linked, no
  // refinement artifact" marker, AC4 of #1496); or "none" (the PR closes no
  // issue). Only the CLI path sets it, so a null acceptanceCriteria WITH this
  // field means "genuinely absent" and one WITHOUT it means "never resolved"
  // (#1496).
  if (typeof options.acceptanceCriteriaSource === "string") {
    artifact.scope.acceptanceCriteriaSource = options.acceptanceCriteriaSource;
  }
  // ADD (#1140): an explicit posture marker distinguishing a full build-once
  // bundle from a thin briefing. Only set by the CLI (`--base` present → "base";
  // absent → "none"); programmatic `buildGateContext`/`writeGateContext` callers
  // that never pass `diffSource` leave the field out entirely, so this stays
  // backward compatible with the artifact shape they already assert on.
  if (typeof options.diffSource === "string" && options.diffSource.length > 0) {
    artifact.scope.diffSource = options.diffSource;
  }
  // ADD (#895): the deterministic, neutral adjacent-code bundle. Only present
  // when the context-builder computed it — keeps the artifact shape backward
  // compatible for callers that build the artifact without an adjacency pass.
  if (options.adjacentCode && typeof options.adjacentCode === "object") {
    artifact.adjacentCode = options.adjacentCode;
  }
  // Whether the rendered briefing prefix inlined the reviewed-head diff (in a
  // fenced block), fell back to the diffPath pointer (size cap), or (CLI-only,
  // `--prefix-file`) recorded an orchestrator-authored prefix verbatim
  // ("file" — see writeGateContextWithPrefix below). Only set when a caller
  // actually produced/recorded a prefix (writeGateContext does, always).
  if (typeof options.prefixMode === "string" && options.prefixMode.length > 0) {
    artifact.prefixMode = options.prefixMode;
  }
  return artifact;
}

/**
 * Resolve the diff-derived scope fields shared by `buildGateContext` (the
 * programmatic `{ diff }` path) and the CLI `--base` path (#1140): the FULL
 * diff persisted to a deterministic `.diff` file, the parsed `changedFiles`,
 * and the neutral `adjacentCode` bundle built once from those changed files.
 * Extracted to a single function so both callers stay in sync — see the
 * doc comment on {@link buildGateContext} for the field semantics.
 *
 * @param {object} input
 * @param {{ nameStatusOutput: string, diffOutput?: string }} [input.diff]
 * @param {string} input.repo
 * @param {number|string} input.pr
 * @param {string} input.gate
 * @param {string} input.headSha
 * @param {string} input.tmpRoot
 * @param {number} [input.maxFileBytes]
 * @param {{ repoRoot: string }} opts
 * @returns {Promise<{ diffPath: string|null, changedFiles: string[], adjacentCode: object|null, diffOutput: string|null }>}
 */
async function resolveDiffScope({ diff, repo, pr, gate, headSha, tmpRoot, maxFileBytes }, { repoRoot }) {
  const diffOutput = diff?.diffOutput;
  let diffPath = null;
  const changedFiles = parseChangedFiles(diff?.nameStatusOutput);
  if (typeof diffOutput === "string" && diffOutput.length > 0) {
    diffPath = buildGateDiffPath({ repo, pr, gate, headSha, tmpRoot });
    const fullDiffPath = path.resolve(repoRoot, diffPath);
    try {
      await mkdir(path.dirname(fullDiffPath), { recursive: true });
      await writeFile(fullDiffPath, diffOutput.endsWith("\n") ? diffOutput : diffOutput + "\n", "utf8");
    } catch (err) {
      // Best-effort: a diff-file write failure (disk, permissions) must not block
      // the context artifact. Degrade to diffPath=null; reviewers reconstruct the
      // diff with `git diff`. changedFiles (from nameStatusOutput) is unaffected.
      process.stderr.write(`[gate-context] full-diff capture failed (continuing without scope.diffPath): ${err?.message ?? err}\n`);
      diffPath = null;
    }
  }

  // Build the deterministic, neutral adjacent-code bundle ONCE (#895): for each
  // changed source file, include its 1-hop import out-edges (files it imports)
  // and in-edges (files that import it), with size guards (skip
  // lockfiles/generated/binary/minified; cap per-file bytes; truncate the long
  // tail) recorded in a stripped/truncated manifest. Every independent reviewer
  // is seeded with this identical bundle instead of re-deriving it — work-dedup.
  // Best-effort: bundle computation must never block the context artifact.
  let adjacentCode = null;
  if (changedFiles.length > 0) {
    try {
      adjacentCode = await buildAdjacentBundle({
        changedFiles,
        repoRoot,
        maxFileBytes: typeof maxFileBytes === "number" && maxFileBytes > 0 ? maxFileBytes : DEFAULT_MAX_FILE_BYTES,
      });
    } catch (err) {
      process.stderr.write(`[gate-context] adjacent-code bundle failed (continuing without adjacentCode): ${err?.message ?? err}\n`);
      adjacentCode = null;
    }
  }

  return { diffPath, changedFiles, adjacentCode, diffOutput: typeof diffOutput === "string" ? diffOutput : null };
}

/**
 * Capture a diff against `base` for the CLI `--base <ref>` flag: `git diff
 * --name-status <base>...HEAD` and `git diff <base>...HEAD`, shaped as the
 * `{ nameStatusOutput, diffOutput }` input `resolveDiffScope`/`buildGateContext`
 * expect. Uses execFileSync with an argv array (no shell), so `base` cannot
 * inject shell syntax; `parseWriteGateContextCliArgs` additionally validates it
 * looks like a plausible ref before this runs.
 *
 * Split posture:
 * - the `--name-status` capture is FAIL-CLOSED: it drives scope.changedFiles +
 *   the adjacentCode bundle, so an unresolvable base / non-git-repo throws and
 *   the CLI writes NO artifact (never a silent thin briefing).
 * - the FULL diff capture is BEST-EFFORT: if it fails (output exceeds maxBuffer,
 *   a rendering error, etc.) we warn and return an EMPTY diffOutput. downstream
 *   resolveDiffScope then leaves scope.diffPath null while still populating
 *   changedFiles + adjacentCode; reviewers fall back to re-deriving the diff
 *   (the existing safety net). scope.diffSource stays "base" — it IS a
 *   base-derived bundle, just without the persisted full diff.
 *
 * @param {string} base
 * @param {{ repoRoot: string, maxBuffer?: number }} opts — maxBuffer overridable for tests
 * @returns {{ nameStatusOutput: string, diffOutput: string }}
 */
export function captureDiffFromBase(base, { repoRoot, maxBuffer = 64 * 1024 * 1024 }) {
  const range = `${base}...HEAD`;
  // Isolate the persisted .diff BYTES from ambient global/system gitconfig so
  // every reviewer is seeded with an IDENTICAL neutral bundle (the whole point
  // of build-once). Without this isolation, an operator/CI with
  // color.diff=always, a configured diff.external/difftool, or non-default
  // prefix settings would make scope.diffPath environment-dependent.
  // color.ui=false + color.diff=false strip ANSI; core.pager=cat neutralizes a
  // configured pager; diff.noprefix=false + diff.mnemonicPrefix=false pin the
  // a/ b/ prefixes; the --no-ext-diff flag (below) disables any external diff
  // driver (NOT `-c diff.external=`, which makes git try to exec the empty
  // string and die).
  // CROSS-environment reproducibility (#1168): the overrides above only pin
  // bytes WITHIN a single run/machine — an operator/CI box with a contrary
  // local diff.renames/diff.algorithm/diff.context/core.abbrev/core.autocrlf
  // would still produce different bytes than another box on the SAME base and
  // HEAD. diff.algorithm=myers + diff.context=3 + core.abbrev=12 +
  // core.autocrlf=false pin the diff body/hunk headers/blob-id length/line
  // endings. diff.renames=true additionally pins rename DETECTION itself: with
  // it off, a moved-and-edited file shows as a straight D+A pair in
  // `--name-status` instead of an R### pair, which changes the SET of names in
  // scope.changedFiles (and therefore adjacentCode's membership) across
  // environments, not just the diff body's bytes.
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
    // See gitEnvWithoutDirOverrides: without this, an inherited GIT_DIR/GIT_WORK_TREE
    // would resolve this diff against a DIFFERENT repo than the worktree-HEAD guard
    // (assertWorktreeAtHead, above) just validated.
    env: gitEnvWithoutDirOverrides(),
  });
  // FAIL-CLOSED: --name-status feeds changedFiles + adjacentCode (the bundle's core).
  let nameStatusOutput;
  try {
    nameStatusOutput = runGit(["diff", "--no-ext-diff", "--name-status", range]);
  } catch (err) {
    throw new Error(`git diff against --base ${JSON.stringify(base)} failed: ${err?.message ?? err}`);
  }
  // BEST-EFFORT: the full diff only feeds the persisted scope.diffPath; on
  // failure degrade to an empty diffOutput (diffPath becomes null downstream).
  let diffOutput = "";
  try {
    diffOutput = runGit(["diff", "--no-ext-diff", range]);
  } catch (err) {
    process.stderr.write(`[gate-context] full-diff capture against --base ${JSON.stringify(base)} failed (continuing without scope.diffPath): ${err?.message ?? err}\n`);
    diffOutput = "";
  }
  return { nameStatusOutput, diffOutput };
}

/**
 * Write both the JSON context artifact AND its sibling rendered briefing
 * prefix (GATE-EXEC-BRIEFING-PREFIX): the byte-identical invariant block every
 * per-angle reviewer of this gate pass is seeded with. The prefix's
 * `prefixMode` (inline|pointer, from the diff-size cap; or file, when
 * `--prefix-file` records an orchestrator-authored prefix verbatim) is
 * recorded on the JSON artifact so both files stay in sync.
 *
 * @param {object} options — parsed CLI options shape, optionally carrying
 *   `diffOutput`, `prBody`, `issueBody`/`issueSections` (all null-safe; a
 *   caller with none of these still gets a valid — if thin — prefix),
 *   `prefixFile` (a path to an ALREADY-rendered prefix whose exact bytes are
 *   recorded verbatim instead of self-rendering — see the CLI's
 *   `--prefix-file` doc above), and `validationResultsPath` (a path to the
 *   run-gate-validation.mjs artifact; fails closed when missing/unreadable —
 *   see the CLI's `--validation-results` doc above).
 * @param {{ repoRoot?: string }} [runtime]
 * @returns {Promise<{ ok: boolean, path: string, artifact: object, prefixPath: string, prefixHash: string, prefixMode: "inline"|"pointer"|"file" }>}
 */
export async function writeGateContext(options, { repoRoot = process.cwd() } = {}) {
  const contextPath = buildGateContextPath({
    repo: options.repo,
    pr: options.pr,
    gate: options.gate,
    headSha: options.headSha,
    tmpRoot: options.tmpRoot || "tmp",
  });
  const briefingPrefixPath = buildGateBriefingPrefixPath({
    repo: options.repo,
    pr: options.pr,
    gate: options.gate,
    headSha: options.headSha,
    tmpRoot: options.tmpRoot || "tmp",
  });

  // `--validation-results` (GATE-EXEC-VALIDATION-ARTIFACT): fail closed before
  // any write when the supplied path is missing/unreadable — a reviewer must
  // never be pointed at a validation record that does not actually exist.
  // Resolved to an ABSOLUTE path (independent of prefix mode: this feeds
  // scope.validationResultsPath and, in self-rendered mode below, the trailing
  // briefing-prefix section) so the artifact and prefix always agree with
  // whatever CWD produced them, regardless of a later reader's own CWD.
  if (typeof options.validationResultsPath === "string" && options.validationResultsPath.length > 0) {
    const resolvedValidationResultsPath = path.resolve(repoRoot, options.validationResultsPath);
    try {
      await readFile(resolvedValidationResultsPath);
    } catch (err) {
      throw new Error(`--validation-results ${JSON.stringify(options.validationResultsPath)} is unreadable: ${err?.message ?? err}`);
    }
    options.validationResultsPath = resolvedValidationResultsPath;
  }

  // `--prefix-file` (an orchestrator that already briefed reviewers with its
  // OWN rendered prefix cannot ever match verify-briefing-prefixes.mjs's
  // on-disk record if this module always writes ITS self-rendered prefix
  // instead): when given, record the supplied file's EXACT BYTES verbatim —
  // no rendering, no trailing-newline normalization — and hash THOSE bytes.
  // prefixMode reports "file" rather than inline|pointer. When omitted, the
  // load-bearing default self-rendered path below runs byte-identically to
  // before.
  let prefixBytes;
  let prefixMode;
  if (typeof options.prefixFile === "string" && options.prefixFile.length > 0) {
    try {
      prefixBytes = await readFile(path.resolve(repoRoot, options.prefixFile));
    } catch (err) {
      throw new Error(`--prefix-file ${JSON.stringify(options.prefixFile)} is unreadable: ${err?.message ?? err}`);
    }
    if (prefixBytes.length === 0) {
      throw new Error(`--prefix-file ${JSON.stringify(options.prefixFile)} is empty — refusing to record an empty invariant briefing prefix.`);
    }
    prefixMode = "file";
  } else {
    const rendered = renderBriefingPrefix({
      repo: options.repo,
      pr: options.pr,
      gate: options.gate,
      headSha: options.headSha,
      worktreeRoot: path.resolve(repoRoot),
      contextPath,
      briefingPrefixPath,
      prBody: options.prBody ?? null,
      issueRef: options.acceptanceCriteria ?? null,
      issueBody: options.issueBody ?? null,
      issueSections: options.issueSections ?? null,
      diffOutput: options.diffOutput ?? null,
      diffPath: options.diffPath ?? null,
      changedFiles: options.changedFiles ?? [],
      adjacentCode: options.adjacentCode ?? null,
      validationResultsPath: options.validationResultsPath ?? null,
    });
    prefixBytes = Buffer.from(rendered.text, "utf8");
    prefixMode = rendered.prefixMode;
  }

  const fullPath = path.resolve(repoRoot, contextPath);
  const artifact = {
    ...buildGateContextArtifact({ ...options, prefixMode }),
    loggedAt: new Date().toISOString(),
  };
  // Write ORDER matters: the sibling briefing prefix goes first and the JSON
  // artifact last, so the artifact's existence is the completion marker for
  // the whole set. Downstream consumers (readGateContext, the reviewers'
  // --context-path guard) key on the JSON — a prefix-write failure must not
  // leave a complete-looking artifact pointing at a missing prefix file.
  const fullPrefixPath = path.resolve(repoRoot, briefingPrefixPath);
  await mkdir(path.dirname(fullPrefixPath), { recursive: true });
  // Rebuild detection: overwriting a DIFFERENT prefix at a head that already
  // has reviewer sentinels invalidates every one of them (their recorded hash
  // can never match the new bytes), stranding the round. The rebuild itself is
  // legitimate — warn and name the sanctioned retirement command instead of
  // refusing or silently invalidating (GATE-EXEC-ROUND-RETIREMENT).
  let rebuildWarning = null;
  try {
    const existingBytes = await readFile(fullPrefixPath);
    if (!existingBytes.equals(prefixBytes)) {
      // Scoped to THIS gate's sentinels (the other gate's live round at the
      // same head is not invalidated by this rebuild), and matched on the
      // trailing full-SHA filename component with startsWith so a legitimately
      // abbreviated --head-sha still detects them.
      const gateScopePrefix = `${CHECKPOINT_SENTINEL_PREFIX}${String(options.gate).replace(/_/g, "-")}-`;
      const headPrefix = String(options.headSha).trim().toLowerCase();
      const tmpDirEntries = await readdir(path.resolve(repoRoot, "tmp"), { withFileTypes: true }).catch(() => []);
      const liveSentinels = tmpDirEntries.filter((e) => {
        if (!e.isFile() || !e.name.startsWith(gateScopePrefix) || !e.name.endsWith(".json")) return false;
        const shaComponent = e.name.slice(0, -".json".length).split("-").at(-1) ?? "";
        return /^[0-9a-f]{40}$/.test(shaComponent) && shaComponent.startsWith(headPrefix);
      }).length;
      if (liveSentinels > 0) {
        rebuildWarning = `Rebuilt the briefing prefix with DIFFERENT bytes while ${liveSentinels} reviewer sentinel(s) of ${options.gate} for head ${options.headSha} exist — every one of them now fails closed (recorded hash can no longer match). Retire the round explicitly before re-fanning: node scripts/github/retire-gate-round.mjs --gate ${options.gate} --head-sha <full sha> --reason "<why>" [--findings-dir <round artifacts dir>]`;
        process.stderr.write(`WARNING: ${rebuildWarning}\n`);
      }
    }
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  await writeFile(fullPrefixPath, prefixBytes);
  const prefixHash = createHash("sha256").update(prefixBytes).digest("hex");

  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, JSON.stringify(artifact, null, 2) + "\n", "utf8");

  return { ok: true, path: contextPath, artifact, prefixPath: briefingPrefixPath, prefixHash, prefixMode, ...(rebuildWarning ? { warning: rebuildWarning } : {}) };
}

/**
 * Context-builder entrypoint: resolve the dynamic review-angle set via the
 * canonical resolver and persist the handoff artifact.
 *
 * Angle selection is delegated entirely to `resolveGateAnglesDynamic` (the
 * single source of truth, which honors the mandatory-angle floor and falls back
 * to the static configured pool when dynamic angle resolution is off or no diff is
 * given). This function only maps that result into the artifact and writes it.
 *
 * @param {object} input
 * @param {import("@dev-loops/core/config").DevLoopConfig} input.config — merged dev-loop config
 * @param {string} input.gate — draft_gate | pre_approval_gate
 * @param {{ nameStatusOutput: string, diffOutput?: string }} [input.diff] — diff for dynamic resolution; when `diffOutput` is present it is also persisted to `scope.diffPath` and parsed into `scope.changedFiles`
 * @param {string} input.repo — owner/name
 * @param {number|string} input.pr
 * @param {string} input.headSha
 * @param {string|null} [input.branch]
 * @param {string[]} [input.touchedFiles]
 * @param {string|null} [input.acceptanceCriteria]
 * @param {string|null} [input.validationPosture]
 * @param {string|null} [input.prBody] — PR description text, inlined into the rendered briefing prefix
 * @param {string|null} [input.issueBody] — linked-issue body text, inlined under `acceptanceCriteria`'s label; omitted when absent
 * @param {number} [input.maxFileBytes] — per-file cap for the adjacent-code bundle (default DEFAULT_MAX_FILE_BYTES)
 * @param {string} [input.tmpRoot]
 * @param {{ repoRoot?: string }} [opts]
 * @returns {Promise<{ ok: boolean, path: string, artifact: object, prefixPath: string, prefixHash: string, prefixMode: "inline"|"pointer", resolver: object }>}
 *   prefixMode is never "file" here — this programmatic entrypoint never threads a
 *   `prefixFile` into its internal writeGateContext() call, so it always self-renders.
 *   "file" mode is CLI-only (main()'s `--prefix-file` flag).
 *
 * The artifact additionally carries a deterministic, neutral `adjacentCode`
 * bundle (#895) when changed files are present: 1-hop import in/out-edges of the
 * changed files with size guards + a stripped/truncated manifest. Reviewers are
 * seeded with this verbatim instead of re-deriving the diff + adjacent code.
 */
export async function buildGateContext(input, { repoRoot = process.cwd() } = {}) {
  const configKey = mapGateToConfigKey(input.gate);
  // input.hasFullLabel is an ATTESTATION about the live PR's gate:full label,
  // not a preference: only an explicit `false` (caller checked the labels and
  // the label is absent) enables diff-class tier reduction. An omitted or
  // truthy value fails closed to the untriered set, so a caller that never
  // looked at the labels can never grant the reduced tier on a labelled PR.
  const resolverResult = await resolveGateAnglesDynamic(input.config, configKey, {
    diff: input.diff,
    hasFullLabel: input.hasFullLabel !== false,
  });
  const { resolvedAngles, rationale } = rationaleFromResolver(resolverResult);

  const tmpRoot = input.tmpRoot || "tmp";

  // Diff-derived scope: persisted FULL diff (scope.diffPath), parsed
  // scope.changedFiles, and the neutral adjacentCode bundle, all built ONCE by
  // the shared resolveDiffScope helper (also used by the CLI --base path, #1140).
  const { diffPath, changedFiles, adjacentCode, diffOutput } = await resolveDiffScope(
    { diff: input.diff, repo: input.repo, pr: input.pr, gate: input.gate, headSha: input.headSha, tmpRoot, maxFileBytes: input.maxFileBytes },
    { repoRoot },
  );

  const writeResult = await writeGateContext(
    {
      repo: input.repo,
      pr: input.pr,
      gate: input.gate,
      headSha: input.headSha,
      angles: resolvedAngles,
      rationale,
      branch: input.branch ?? null,
      touchedFiles: input.touchedFiles ?? [],
      changedFiles,
      diffPath,
      diffOutput,
      adjacentCode,
      acceptanceCriteria: input.acceptanceCriteria ?? null,
      validationPosture: input.validationPosture ?? null,
      prBody: input.prBody ?? null,
      issueBody: input.issueBody ?? null,
      tmpRoot,
    },
    { repoRoot },
  );

  return { ...writeResult, resolver: resolverResult };
}

/**
 * Read a previously-written gate context artifact. Returns null when absent.
 *
 * @param {object} input — { repo, pr, gate, headSha, tmpRoot }
 * @param {{ repoRoot?: string }} [options]
 * @returns {Promise<object|null>}
 */
export async function readGateContext(input, { repoRoot = process.cwd() } = {}) {
  const contextPath = buildGateContextPath({
    repo: input.repo,
    pr: input.pr,
    gate: input.gate,
    headSha: input.headSha,
    tmpRoot: input.tmpRoot || "tmp",
  });
  const fullPath = path.resolve(repoRoot, contextPath);
  try {
    const raw = await readFile(fullPath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Fail-closed precondition for the CLI `--base` path: verify the CWD git
 * worktree's HEAD equals the caller-declared `--head-sha` BEFORE we resolve a
 * diff from that worktree. `--head-sha` is otherwise just metadata; the diff,
 * changed-file set, and output path all come from whatever worktree the shell
 * CWD happens to be in. Run from the WRONG worktree (a CWD persisted from a
 * prior PR's build), `git diff <base>...HEAD` silently resolves the wrong diff
 * and every fan-out reviewer only fails closed AFTER dispatch on the mislocated
 * bundle. This turns the head SHA into an enforced precondition so the mistake
 * is caught at build time (no artifact written) instead.
 *
 * `headSha` may be abbreviated (7-64 hex, per normalizeHeadSha); the worktree
 * HEAD is the full-length rev-parse output (40 hex for SHA-1, 64 for SHA-256),
 * so accept `headSha` when it is a prefix of that HEAD rather than requiring
 * exact equality.
 *
 * @param {string} headSha — the declared --head-sha (already normalized lowercase)
 * @param {{ repoRoot: string }} opts
 */
export function assertWorktreeAtHead(headSha, { repoRoot }) {
  // Fail-closed self-guard: the abbreviation prefix-match below (declared must be a
  // prefix of the full-length HEAD) FALSE-ACCEPTS an
  // empty/too-short `headSha` (an empty string is a prefix of every HEAD). The sole
  // caller (main) pre-validates via normalizeHeadSha, but re-validate here so this
  // exported boundary stays fail-closed for any future importer.
  const declared = String(headSha).trim().toLowerCase();
  if (!/^[0-9a-f]{7,64}$/.test(declared)) {
    throw new Error(
      `assertWorktreeAtHead: headSha ${JSON.stringify(headSha)} is not a 7-64 character hex SHA — refusing to prefix-match against the worktree HEAD (an empty/short value would false-accept).`,
    );
  }
  let actualHead;
  try {
    actualHead = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      // See gitEnvWithoutDirOverrides: an inherited GIT_DIR/GIT_WORK_TREE would
      // resolve a DIFFERENT repo than `repoRoot`, so this guard and the diff it
      // gates could pass/fail against two different repos. Scrub both here too.
      env: gitEnvWithoutDirOverrides(),
    }).trim().toLowerCase();
  } catch (err) {
    throw new Error(
      `--base was given but the current working directory (${repoRoot}) is not inside a git worktree (git rev-parse HEAD failed: ${err?.message ?? err}). cd into the PR's worktree — the one checked out at --head-sha ${headSha} — before building its gate context.`,
    );
  }
  // `git rev-parse HEAD` always returns the full-length SHA, so the only valid
  // match is `declared` being a prefix of it. Accepting the reverse direction
  // (declared longer than HEAD) would false-accept a --head-sha whose first
  // chars merely happen to equal HEAD (e.g. a 64-char value vs a SHA-1 HEAD).
  const matches = actualHead.startsWith(declared);
  if (!matches) {
    throw new Error(
      `worktree HEAD ${actualHead} does not match --head-sha ${declared}: the current working directory is the WRONG worktree for this PR, so \`git diff <base>...HEAD\` would resolve the WRONG diff. cd into the worktree checked out at ${declared} and re-run.`,
    );
  }
}

/**
 * Resolve the spec-of-record text the briefing prefix states as fact — the PR
 * description, every issue the PR closes, and each issue's body — from
 * GitHub, so a caller that simply omits the flags can never seed every
 * fan-out reviewer with the claim that the PR has no description and no
 * acceptance criteria (#1496/#1511). Explicit flags win: only fields still
 * unset are fetched, and a caller that passes all three never touches the
 * network.
 *
 * `acceptanceCriteria` is resolved from the PR's closing reference(s) ONLY
 * when the caller did not supply `--acceptance-criteria` itself: auto-fetching
 * an issue body and attaching it under a caller-provided (and possibly
 * unrelated, e.g. a doc path) pointer would attribute the wrong document as
 * its source, which is the same false-spec class this resolver exists to
 * remove. When the caller DID supply the AC pointer, `acceptanceCriteriaSource`
 * is always "provided", regardless of whether the PR happens to close an
 * issue or whether `--issue-body` was also given.
 *
 * Every closing issue is resolved (via the same detector the enqueue gate
 * uses, `resolveLinkedIssuesFromPr`: deduped, ordered, n>0 guarded, falls back
 * to `Closes/Fixes/Resolves #N` body keywords), not just the first — an
 * umbrella PR closing several issues previously briefed reviewers with only
 * one issue's ACs and no signal that others were dropped. Each resolved
 * issue's body is fetched from ITS OWN repository (cross-repo closing
 * references are real) and classified via `detectIssueRefinementArtifact`
 * (the same detector the enqueue gate uses) so `acceptanceCriteriaSource`
 * distinguishes "linked issue carries a real refinement artifact" from
 * "linked issue is prose-only" (AC4 of #1496) — the latter stamped
 * `"linked-issue-unrefined"`.
 *
 * Fails closed with a named error when the PR read fails. An unresolvable body
 * must not degrade into an assertion of absence — the whole defect being fixed
 * is that "the caller passed nothing" was rendered as "the PR has nothing".
 *
 * @param {object} options — parsed CLI options shape (mutated in place)
 * @param {{ run?: Function, env?: object, ghCommand?: string }} [deps]
 * @returns {Promise<object>} the same options object
 */
export async function resolvePrSpecContext(options, { run = runChild, env = process.env, ghCommand = "gh" } = {}) {
  // `== null` on purpose: an omitted field (undefined) means the caller
  // supplied nothing just as much as an explicit null does. Treating undefined
  // as "provided" would skip resolution and stamp the artifact `provided`
  // anyway — the false-spec claim this whole path exists to prevent.
  const needsBody = options.prBody == null;
  const acProvided = options.acceptanceCriteria != null;
  const needsIssue = !acProvided;
  if (!needsBody && !needsIssue) {
    options.acceptanceCriteriaSource = "provided";
    return options;
  }

  let pr;
  try {
    ({ pr } = await viewPr(
      { repo: options.repo, pr: options.pr, fields: "body,closingIssuesReferences" },
      { env, ghCommand, run },
    ));
  } catch (error) {
    const missing = needsBody && needsIssue
      ? "the PR has no description and no acceptance criteria"
      : needsBody
        ? "the PR has no description"
        : "the PR has no acceptance criteria";
    throw new Error(
      `gate-context spec resolution failed: could not read PR #${options.pr} in ${options.repo} (${error?.message ?? error}). Refusing to write a bundle whose briefing prefix would state ${missing}. Pass --pr-body (and --issue-body/--acceptance-criteria) explicitly to build without GitHub access.`,
    );
  }
  // An empty string here is a RESOLVED fact (the PR genuinely has no
  // description) and renders as PR_BODY_ABSENT_SENTINEL. That is distinct from
  // the throw above, which is the unresolvable case.
  if (needsBody) options.prBody = typeof pr.body === "string" ? pr.body : "";

  if (!needsIssue) {
    options.acceptanceCriteriaSource = "provided";
    return options;
  }

  const closingNumbers = resolveLinkedIssuesFromPr(pr);
  if (closingNumbers.length === 0) {
    // Genuinely no closing reference (and no body-keyword fallback match) —
    // recorded as such, so a consumer can tell "this PR closes no issue" from
    // "nobody fetched the issue".
    options.acceptanceCriteriaSource = "none";
    return options;
  }

  // Identity is (repository, number), never the number alone: a PR closing
  // owner/repo#5 and owner/other#5 references two different issues, and keying
  // by number would silently drop one from the spec-of-record. GraphQL's
  // closingIssuesReferences carries the repository, so it is the source of
  // truth whenever present; the bare numbers from resolveLinkedIssuesFromPr are
  // the body-keyword fallback and can only mean this PR's own repo.
  const graphqlRefs = (Array.isArray(pr.closingIssuesReferences) ? pr.closingIssuesReferences : [])
    .filter((entry) => Number.isInteger(entry?.number));
  const seen = new Set();
  const targets = [];
  for (const entry of graphqlRefs.length > 0 ? graphqlRefs : closingNumbers.map((number) => ({ number }))) {
    const repo = entry.repository?.owner?.login && entry.repository?.name
      ? `${entry.repository.owner.login}/${entry.repository.name}`
      : options.repo;
    const key = `${repo.toLowerCase()}#${entry.number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Same-repo refs render bare (`#42`). The comparison is case-insensitive
    // because `--repo Owner/Repo` and the API's `owner/repo` name one repo.
    const sameRepo = repo.toLowerCase() === options.repo.toLowerCase();
    targets.push({ repo, number: entry.number, label: sameRepo ? `#${entry.number}` : `${repo}#${entry.number}` });
  }
  options.acceptanceCriteria = targets.map((t) => t.label).join(", ");

  if (options.issueBody == null) {
    const bodies = [];
    // "unrefined" means the pointer leads nowhere: EVERY linked issue is
    // prose-only. One refined issue among several still gives a reviewer real
    // criteria to read, so a mixed set is "linked-issue".
    let anyRefined = false;
    for (const { repo, number, label } of targets) {
      let issue;
      try {
        ({ issue } = await viewIssue({ repo, issue: number, fields: "body" }, { env, ghCommand, run }));
      } catch (error) {
        throw new Error(
          `gate-context spec resolution failed: PR #${options.pr} closes issue ${label} but its body could not be read (${error?.message ?? error}). Refusing to write a bundle whose briefing prefix would omit the acceptance criteria it claims to carry. Pass --issue-body/--acceptance-criteria explicitly to build without GitHub access.`,
        );
      }
      const body = typeof issue.body === "string" ? issue.body : "";
      if (detectIssueRefinementArtifact({ body, issueNumber: number }).hasACs) anyRefined = true;
      bodies.push({ label, body });
    }
    // A single linked issue renders exactly as before (no redundant `### #N`
    // sub-heading duplicating the `## Linked issue #N` heading above it,
    // via options.issueBody). A multi-issue PR instead hands the renderer
    // structured per-issue data (options.issueSections) rather than a
    // pre-joined string: renderBriefingPrefix — not this resolver — owns
    // emitting each `### <label>` heading OUTSIDE any fence, so one issue's
    // hostile body can never forge another issue's label (renderer-security).
    if (bodies.length === 1) {
      options.issueBody = bodies[0].body.trim().length > 0 ? bodies[0].body.trim() : ISSUE_BODY_ABSENT_SENTINEL;
    } else {
      options.issueSections = bodies;
    }
    options.acceptanceCriteriaSource = anyRefined ? "linked-issue" : "linked-issue-unrefined";
  } else {
    // Caller supplied the issue body text directly (without also supplying
    // --acceptance-criteria) — classify it as given rather than making a
    // network call whose result would be discarded.
    options.acceptanceCriteriaSource = detectIssueRefinementArtifact({ body: options.issueBody }).hasACs
      ? "linked-issue"
      : "linked-issue-unrefined";
  }
  return options;
}

/**
 * CLI entrypoint. Exported (argv + repoRoot both overridable) so tests can
 * drive the `--base` diff-capture path against a throwaway git repo fixture
 * without spawning a subprocess. `run` is the injectable child-process runner
 * the GitHub spec-resolution reads go through.
 * @param {string[]} [argv]
 * @param {{ repoRoot?: string, run?: Function }} [runtime]
 */
export async function main(argv = process.argv.slice(2), { repoRoot = process.cwd(), run = runChild } = {}) {
  let options;
  try {
    options = parseWriteGateContextCliArgs(argv);
  } catch (error) {
    process.stderr.write(`${formatCliError(error, { usage: USAGE })}\n`);
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  try {
    // Resolve the spec-of-record (PR body, linked issue(s) + their bodies)
    // BEFORE any diff work: a bundle that cannot state the spec truthfully must
    // not be written at all, and failing here costs nothing (#1496/#1511).
    // Skipped under --prefix-file: the recorded prefix bytes are the supplied
    // file's EXACT bytes (writeGateContext never renders prBody/issueBody into
    // them in that mode), so a GitHub read here would be spent resolving text
    // that can never reach the record — an orchestrator that already rendered
    // its own prefix must not gain a new hard GitHub dependency for that.
    if (!options.prefixFile) {
      await resolvePrSpecContext(options, { run });
    }
    // AC3 (#1140): the CLI only produces the full build-once bundle
    // (scope.diffPath + scope.changedFiles + adjacentCode) when it has a
    // resolvable diff source. --base is OPTIONAL rather than required — making
    // it required would break any existing caller that only ever passed
    // --touched-files (angles + scope already resolved elsewhere) — so a run
    // without --base does not fail closed; it explicitly WARNS and records the
    // thin-briefing posture in scope.diffSource so it is never mistaken for a
    // full bundle. A run WITH --base that then fails to resolve (bad ref, not a
    // git repo, etc.) DOES fail closed: the caller opted into the full bundle,
    // so a silent thin degrade there would be a worse surprise than an error.
    let diff = null;
    if (options.base) {
      // Fail-closed precondition: the diff is resolved FROM the CWD worktree, so
      // enforce that CWD is this PR's worktree at --head-sha before diffing.
      // Otherwise a stale CWD silently yields the wrong diff (caught only after
      // fan-out today). Throws → caught below → exit 1, no artifact written.
      assertWorktreeAtHead(options.headSha, { repoRoot });
      diff = captureDiffFromBase(options.base, { repoRoot });
      const scope = await resolveDiffScope(
        { diff, repo: options.repo, pr: options.pr, gate: options.gate, headSha: options.headSha, tmpRoot: options.tmpRoot || "tmp" },
        { repoRoot },
      );
      // A --base build that resolves an EMPTY change set is degenerate: the
      // caller opted into a full bundle, so a zero-file diff (mis-set base,
      // wrong worktree that slipped the HEAD guard, etc.) is a fail-closed
      // error, not a silently-emitted stub with changedFiles:[].
      if (scope.changedFiles.length === 0) {
        throw new Error(
          `--base ${JSON.stringify(options.base)} resolved an EMPTY change set (git diff ${options.base}...HEAD produced no changed files) — refusing to write a degenerate gate-context bundle. Verify --base and that the CWD worktree is checked out at --head-sha ${options.headSha}.`,
        );
      }
      options.changedFiles = scope.changedFiles;
      options.diffPath = scope.diffPath;
      options.adjacentCode = scope.adjacentCode;
      options.diffOutput = scope.diffOutput;
      options.diffSource = "base";
    } else {
      process.stderr.write("[write-gate-context] warning: no --base given; emitting a THIN briefing (scope.diffPath=null, scope.changedFiles=[], no adjacentCode). Pass --base <ref> for the full build-once bundle.\n");
      options.diffSource = "none";
    }
    // Angle resolution: when --angles is omitted, resolve dynamically from the
    // loaded config (.devloops) + the captured --base diff — the SAME path the
    // programmatic buildGateContext API uses (resolveGateAnglesDynamic). This
    // keeps the CLI consistent with the API: dynamic angle resolution trims to the
    // mandatory floor + diff-selected candidates when a diff is present, and
    // falls back to the static configured pool otherwise. When --angles IS
    // supplied, it is a verbatim override (dynamic resolution bypassed).
    if (!Array.isArray(options.angles)) {
      // loadDevLoopConfig never throws: it returns { config, warnings, errors }, and
      // on a validation error it still returns `config` with every layer merged (its
      // own documented fallback). buildGateContext — the programmatic API this CLI
      // mirrors — never calls loadDevLoopConfig itself (callers hand it a config), so
      // there is no separate fail-closed/null-out behavior to match there; the gap is
      // purely a missing signal. Mirror post-gate-findings.mjs's stderr warning so a
      // malformed .devloops is never silently swallowed, then proceed with that same
      // merged fallback config — nulling it out here (unlike post-gate-findings.mjs's
      // boolean-flag default) would replace a partially-valid configured angle set
      // with an EMPTY one, a worse regression than the signal gap this fixes.
      const { config, errors: configErrors } = await loadDevLoopConfig({ repoRoot });
      if (Array.isArray(configErrors) && configErrors.length > 0) {
        process.stderr.write(
          `[write-gate-context] warning: dev-loop config could not be fully loaded/validated; resolving angles from the merged fallback config. errors=${JSON.stringify(configErrors)}\n`,
        );
      }
      // The gate:full label must not depend on the operator remembering
      // --full-label: derive it from the live PR when the flag is absent, and
      // fail CLOSED (treat as labelled → untriered set) when the read fails.
      // --prefix-file mode never touches GitHub, so the label CANNOT be
      // derived there — an omitted flag in that mode also fails closed to the
      // untriered set rather than silently tier-reducing a labelled PR.
      if (options.fullLabel !== true && !options.prefixFile) {
        try {
          const { pr } = await viewPr(
            { repo: options.repo, pr: options.pr, fields: "labels" },
            { run },
          );
          options.fullLabel = Array.isArray(pr?.labels)
            && pr.labels.some((label) => (label?.name ?? label) === GATE_FULL_LABEL);
        } catch (error) {
          options.fullLabel = true;
          process.stderr.write(
            `[write-gate-context] warning: could not read PR labels to check for ${GATE_FULL_LABEL} (${error?.message ?? error}); failing closed to the untriered angle set.\n`,
          );
        }
      } else if (options.fullLabel !== true && options.prefixFile) {
        options.fullLabel = true;
        process.stderr.write(
          `[write-gate-context] note: --prefix-file mode cannot read PR labels; resolving the untriered angle set (pass --angles to override).\n`,
        );
      }
      const configKey = mapGateToConfigKey(options.gate);
      const resolverResult = await resolveGateAnglesDynamic(config, configKey, { diff, hasFullLabel: options.fullLabel === true });
      const { resolvedAngles, rationale } = rationaleFromResolver(resolverResult);
      if (resolvedAngles.length === 0) {
        process.stderr.write(
          `[write-gate-context] warning: angle resolution produced zero angles for gate ${options.gate}; the gate-context bundle carries no review angles. Check the gate's configured angles/mandatoryAngles.\n`,
        );
      }
      options.angles = resolvedAngles;
      // Resolver-derived rationale is authoritative here: a caller cannot supply
      // meaningful rationale for angles it did not name (angles were just
      // resolved dynamically above), so any --rationale the caller passed is
      // ignored rather than persisted as a stale mismatch.
      if (options.rationale.length > 0) {
        process.stderr.write(
          "[write-gate-context] warning: --rationale was supplied without --angles; ignoring it in favor of the resolver-derived rationale (angles were resolved from config rather than supplied via --angles).\n",
        );
      }
      options.rationale = rationale;
    }
    const result = await writeGateContext(options, { repoRoot });
    process.exitCode = emitResult(result, { jq: options.jq, silent: options.silent });
  } catch (error) {
    process.stderr.write(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }) + "\n");
    process.exitCode = 1;
  }
}

if (isDirectCliRun(import.meta.url)) {
  await main();
}
