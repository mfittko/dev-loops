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
 * static configured pool when `dynamicAngles` is off or no diff is available.
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
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { resolveGateAnglesDynamic } from "@dev-loops/core/config";

import { parsePrNumber, requireTokenValue } from "../_cli-primitives.mjs";
import { formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { buildAdjacentBundle, DEFAULT_MAX_FILE_BYTES } from "./build-adjacent-bundle.mjs";
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

const USAGE = `Usage: write-gate-context.mjs --repo <owner/name> --pr <number> --gate <draft_gate|pre_approval_gate> --head-sha <sha> --angles <json> [--rationale <json>] [--branch <name>] [--touched-files <json>] [--base <ref>] [--acceptance-criteria <pointer>] [--validation-posture <text>] [--tmp-root <path>]
Write a deterministic gate-review context-builder handoff artifact under tmp/ paths.
Required:
  --repo <owner/name>
  --pr <number>
  --gate <draft_gate|pre_approval_gate>
  --head-sha <sha>
  --angles <json>                JSON array of resolved review-angle name strings
Optional:
  --rationale <json>             JSON array of {angle, action, reason} entries
  --branch <name>                Source branch name
  --touched-files <json>         JSON array of changed file path strings (separate from the diff-derived scope.changedFiles)
  --base <ref>                   Git ref to diff against (git diff <ref>...HEAD); populates scope.diffPath, scope.changedFiles, and adjacentCode (the full build-once bundle). Without it, the CLI emits an explicit thin briefing (scope.diffSource="none") — see docs/gate-review-sub-loop-contract.md.
  --acceptance-criteria <ptr>    Pointer to acceptance criteria (issue ref, doc path, URL)
  --validation-posture <text>    Short description of the validation posture
  --tmp-root <path>              Root tmp directory (default: tmp/)

${JQ_OUTPUT_USAGE}
`.trim();

function parseError(message) {
  return Object.assign(new Error(message), { usage: USAGE });
}

function normalizeGate(value) {
  const gates = new Set(["draft_gate", "pre_approval_gate"]);
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
      options.repo = requireTokenValue(token, parseError).trim();
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
    if (token.name === "tmp-root") {
      options.tmpRoot = requireTokenValue(token, parseError).trim();
      continue;
    }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  const missing = ["repo", "pr", "gate", "headSha", "angles"]
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
  if (gate !== "draft_gate" && gate !== "pre_approval_gate") {
    throw new Error(`--gate segment ${JSON.stringify(gate)} is unsafe (expected draft_gate or pre_approval_gate)`);
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
    },
  };
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
 * @returns {Promise<{ diffPath: string|null, changedFiles: string[], adjacentCode: object|null }>}
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

  return { diffPath, changedFiles, adjacentCode };
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

export async function writeGateContext(options, { repoRoot = process.cwd() } = {}) {
  const contextPath = buildGateContextPath({
    repo: options.repo,
    pr: options.pr,
    gate: options.gate,
    headSha: options.headSha,
    tmpRoot: options.tmpRoot || "tmp",
  });
  const fullPath = path.resolve(repoRoot, contextPath);
  const artifact = {
    ...buildGateContextArtifact(options),
    loggedAt: new Date().toISOString(),
  };
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, JSON.stringify(artifact, null, 2) + "\n", "utf8");
  return { ok: true, path: contextPath, artifact };
}

/**
 * Context-builder entrypoint: resolve the dynamic review-angle set via the
 * canonical resolver and persist the handoff artifact.
 *
 * Angle selection is delegated entirely to `resolveGateAnglesDynamic` (the
 * single source of truth, which honors the mandatory-angle floor and falls back
 * to the static configured pool when `dynamicAngles` is off or no diff is
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
 * @param {number} [input.maxFileBytes] — per-file cap for the adjacent-code bundle (default DEFAULT_MAX_FILE_BYTES)
 * @param {string} [input.tmpRoot]
 * @param {{ repoRoot?: string }} [opts]
 * @returns {Promise<{ ok: boolean, path: string, artifact: object, resolver: object }>}
 *
 * The artifact additionally carries a deterministic, neutral `adjacentCode`
 * bundle (#895) when changed files are present: 1-hop import in/out-edges of the
 * changed files with size guards + a stripped/truncated manifest. Reviewers are
 * seeded with this verbatim instead of re-deriving the diff + adjacent code.
 */
export async function buildGateContext(input, { repoRoot = process.cwd() } = {}) {
  const configKey = mapGateToConfigKey(input.gate);
  const resolverResult = await resolveGateAnglesDynamic(input.config, configKey, {
    diff: input.diff,
  });
  const { resolvedAngles, rationale } = rationaleFromResolver(resolverResult);

  const tmpRoot = input.tmpRoot || "tmp";

  // Diff-derived scope: persisted FULL diff (scope.diffPath), parsed
  // scope.changedFiles, and the neutral adjacentCode bundle, all built ONCE by
  // the shared resolveDiffScope helper (also used by the CLI --base path, #1140).
  const { diffPath, changedFiles, adjacentCode } = await resolveDiffScope(
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
      adjacentCode,
      acceptanceCriteria: input.acceptanceCriteria ?? null,
      validationPosture: input.validationPosture ?? null,
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
 * CLI entrypoint. Exported (argv + repoRoot both overridable) so tests can
 * drive the `--base` diff-capture path against a throwaway git repo fixture
 * without spawning a subprocess.
 * @param {string[]} [argv]
 * @param {{ repoRoot?: string }} [runtime]
 */
export async function main(argv = process.argv.slice(2), { repoRoot = process.cwd() } = {}) {
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
    if (options.base) {
      const diff = captureDiffFromBase(options.base, { repoRoot });
      const scope = await resolveDiffScope(
        { diff, repo: options.repo, pr: options.pr, gate: options.gate, headSha: options.headSha, tmpRoot: options.tmpRoot || "tmp" },
        { repoRoot },
      );
      options.changedFiles = scope.changedFiles;
      options.diffPath = scope.diffPath;
      options.adjacentCode = scope.adjacentCode;
      options.diffSource = "base";
    } else {
      process.stderr.write("[write-gate-context] warning: no --base given; emitting a THIN briefing (scope.diffPath=null, scope.changedFiles=[], no adjacentCode). Pass --base <ref> for the full build-once bundle.\n");
      options.diffSource = "none";
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
