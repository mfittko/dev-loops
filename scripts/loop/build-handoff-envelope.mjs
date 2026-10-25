#!/usr/bin/env node
/**
 * CLI wrapper for buildDevLoopHandoffEnvelope().
 *
 * Subagents and shell scripts should call this instead of writing ad-hoc
 * inline Node.js to import from the @dev-loops/core subpath. Using the
 * bare `@dev-loops/core` specifier fails because the package has no
 * default export — only named subpath exports.
 *
 * Typical usage (pipeline):
 *   dev-loops loop startup --issue 42 > resolver-output.json
 *   dev-loops loop build-envelope --input resolver-output.json
 *
 * Or via npx:
 *   npx dev-loops@<version> loop build-envelope --input resolver-output.json
 */
import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { detectRepoSlug, normalizeRepoSlug } from "@dev-loops/core/github/repo-slug";
import path from "node:path";
import { buildParseError, formatCliError, isDirectCliRun, parseJsonText } from "../_core-helpers.mjs";
import { requireTokenValue } from "../_cli-primitives.mjs";
import { buildDevLoopHandoffEnvelope, CANONICAL_SPEC_SOURCE } from "@dev-loops/core/loop/handoff-envelope";
import { INTERNAL_DEV_LOOP_STRATEGY } from "@dev-loops/core/loop/public-dev-loop-routing-contract";
import { trimmedOrNull } from "@dev-loops/core/loop/normalize";
import { REFINEMENT_ARTIFACT_SPEC_SOURCE } from "@dev-loops/core/loop/pr-gate-coordination";
import { ConfigLoadFailedError, loadDevLoopConfigStrict } from "@dev-loops/core/config";
import { createPiAdapter } from "@dev-loops/core/harness";
import { parseArgs } from "node:util";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
import { SANCTIONED_COMMANDS } from "./sanctioned-commands.mjs";
import { gitEnvNoDirOverrides, listWorktreeEntries } from "./_repo-root-resolver.mjs";
import { classifyWorktreeIsolation, resolveContainingWorktreeRoot } from "@dev-loops/core/loop/worktree-guard";
import { viewPr } from "../github/view-pr.mjs";
import { loadRefinementArtifact } from "./detect-pr-gate-coordination-state.mjs";

const USAGE = `Usage: build-handoff-envelope.mjs --input <path>
Build a deterministic handoff envelope from startup resolver output and settings.
Required:
  --input <path>         Path to resolver output JSON (from resolve-dev-loop-startup.mjs)
Optional:
  --gate-state <json>    Gate state JSON string
                           { currentHeadSha?, ciStatus?, unresolvedThreadCount?, copilotRoundCount?, retrospectiveFindings? }
  --overrides <json>     Overrides JSON string
                           { mergeAuthorized?, preferLocal?, scopeConstraint?, customStopAt? }
  --repo <owner/name>    Repository slug override (falls back to bundle.repoSlug or bundle.repo)
Output (stdout, JSON):
  Handoff envelope object — see workflow-handoff-contract.md for schema.
Error output (stderr, JSON):
  Argument/usage errors:
    { "ok": false, "error": "...", "usage": "..." }
  Runtime failures:
    { "ok": false, "error": "..." }
${JQ_OUTPUT_USAGE}
Exit codes:
  0  Success
  1  Argument error or runtime failure
  2  Invalid --jq filter`.trim();

const parseError = buildParseError(USAGE);

const GIT_READ_OPTIONS = { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  env: gitEnvNoDirOverrides(), timeout: 10000, maxBuffer: 1024 * 1024 };

// Target kinds whose worktree the CLI may bind to the running checkout.
const LOCAL_WORKTREE_KINDS = new Set(["issue", "local_branch", "local_phase"]);

/**
 * The branch ref a target itself owns, or null when none can be derived.
 * `issue` and issue-carrying `local_phase` targets name `<issue-n>`; a
 * `local_branch` target names its own branch. Soft: an underivable identity
 * binds nothing, so the caller keeps the derived cwd.
 */
export function expectedWorktreeBranchRef(artifact, kind) {
  if (kind === "local_branch") {
    const branch = trimmedOrNull(artifact?.branch);
    return branch ? `refs/heads/${branch}` : null;
  }
  if (kind === "issue" || kind === "local_phase") {
    const issue = artifact?.issue;
    return Number.isInteger(issue) && issue > 0 ? `refs/heads/issue-${issue}` : null;
  }
  return null;
}

/**
 * PURE: the registered LINKED checkout `cwd` actually runs inside, or undefined.
 *
 * `registrations` is `listWorktreeEntries()` output (main first, then linked
 * worktrees with their full `refs/heads/...` branch). The derived cwd for a
 * non-PR target appends the loop namespace, so a startup run from an existing
 * checkout — `/work/issue-42` as much as `tmp/worktrees/issue-42` — would name a
 * worktree nested inside itself. Bind the real registered root instead, but only
 * when the git facts agree: `cwd` is inside exactly one registered non-main
 * worktree AND that worktree is on the branch the target owns. Anything else
 * (main checkout, other branch, unregistered cwd, no derivable identity,
 * unparsable registration) returns undefined so today's derivation stands.
 *
 * Root normalization and the longest-match containment rule come from
 * `resolveContainingWorktreeRoot`, so this cannot disagree with the guard.
 */
export function selectLinkedWorktreeRoot(registrations, cwd, expectedBranchRef) {
  if (!Array.isArray(registrations) || registrations.length < 2) return undefined;
  if (typeof cwd !== "string" || cwd.length === 0) return undefined;
  if (typeof expectedBranchRef !== "string" || expectedBranchRef.length === 0) return undefined;
  const paths = registrations.map((entry) => entry?.path);
  if (paths.some((entryPath) => typeof entryPath !== "string" || entryPath.length === 0)) return undefined;
  const normalized = (entryPath) => resolveContainingWorktreeRoot(entryPath, [entryPath]);
  const containing = resolveContainingWorktreeRoot(cwd, paths);
  if (containing === null || containing === normalized(paths[0])) return undefined;
  const owners = registrations.filter((entry) => normalized(entry.path) === containing);
  if (owners.length !== 1 || owners[0].branch !== expectedBranchRef) return undefined;
  return containing;
}

/**
 * SOFT sibling of `resolvePrWorktree`: bind a non-PR target's `worktreeCwd` to the
 * registered linked checkout the process runs inside. It never throws and never
 * refuses — an unresolved worktree must not fail a startup, which keeps the
 * core derivation as the fallback. Only the branch identity binds it; a main
 * checkout stays on the derived path because that is where a new worktree goes.
 */
function resolveLocalWorktree(bundle, repoRoot, cwd) {
  const artifact = bundle?.activeArtifact ?? bundle?.canonicalState?.target;
  const kind = typeof artifact?.kind === "string" ? artifact.kind.trim().toLowerCase() : null;
  // UI-review provisioning owns checkout acquisition; a reconcile route has no worktree owner.
  if (!LOCAL_WORKTREE_KINDS.has(kind) || bundle?.routeKind === "needs_reconcile"
    || trimmedOrNull(bundle?.selectedStrategy) === INTERNAL_DEV_LOOP_STRATEGY.UI_REVIEW) return undefined;
  const expectedBranchRef = expectedWorktreeBranchRef(artifact, kind);
  if (!expectedBranchRef) return undefined;
  try {
    const entries = listWorktreeEntries(repoRoot, GIT_READ_OPTIONS);
    const root = selectLinkedWorktreeRoot(entries, cwd, expectedBranchRef);
    if (!root) return undefined;
    // The listing already came from THIS repository, so the bound checkout only has to
    // still be one of its worktrees: the same common-dir identity the PR path checks.
    const git = (dir, ...args) => execFileSync("git", args, { ...GIT_READ_OPTIONS, cwd: dir }).trim();
    // realpath both spellings so a symlinked checkout path cannot read as a different repo.
    const commonDir = (dir) => realpathSync(
      git(dir, "rev-parse", "--path-format=absolute", "--git-common-dir"));
    if (commonDir(root) !== commonDir(repoRoot)) return undefined;
    return { worktreeCwd: root };
  } catch {
    return undefined;
  }
}

async function resolvePrWorktree(bundle, repoRoot, repoSlug) {
  const artifact = bundle?.activeArtifact ?? bundle?.canonicalState?.target;
  const kind = typeof artifact?.kind === "string" ? artifact.kind.trim().toLowerCase() : null;
  // UI-review provisioning owns checkout acquisition and detaches at the PR head.
  if (kind !== "pr" || bundle?.routeKind === "needs_reconcile"
    || trimmedOrNull(bundle?.selectedStrategy) === INTERNAL_DEV_LOOP_STRATEGY.UI_REVIEW) return undefined;
  const refuse = (refusal, message) => { throw Object.assign(new Error(message), { refusal }); };
  try {
    const prNumber = artifact.pr;
    if (!Number.isInteger(prNumber) || prNumber < 1) {
      refuse("pr_worktree_identity_mismatch", "PR worktree binding requires one positive PR number");
    }
    const repo = normalizeRepoSlug(repoSlug);
    const localRepo = detectRepoSlug(repoRoot);
    if (!localRepo || normalizeRepoSlug(localRepo) !== repo) {
      refuse("pr_worktree_repository_mismatch", "PR repository does not match this checkout's origin");
    }
    const { pr } = await viewPr({ repo, pr: prNumber,
      fields: "number,url,headRefName,headRefOid,headRepository,headRepositoryOwner,body,isDraft,state,mergedAt,closingIssuesReferences" });
    const headRepo = `${pr.headRepositoryOwner?.login}/${pr.headRepository?.name}`;
    const branch = pr.headRefName;
    if (pr.number !== prNumber || typeof pr.url !== "string"
      || pr.url.toLowerCase() !== `https://github.com/${repo}/pull/${prNumber}`
      || headRepo.toLowerCase() !== repo || typeof branch !== "string" || !branch
      || /[\x00-\x1f\x7f]/u.test(branch) || !/^[a-f0-9]{40}$/iu.test(pr.headRefOid ?? "")) {
      refuse("pr_worktree_identity_mismatch", "Live PR, repository and head branch facts do not agree");
    }
    const git = (cwd, ...args) => execFileSync("git", args, { ...GIT_READ_OPTIONS, cwd }).trim();
    try { git(repoRoot, "check-ref-format", `refs/heads/${branch}`); } catch {
      refuse("pr_worktree_identity_mismatch", "Live PR head branch is not a valid Git ref");
    }
    const canonical = (value) => {
      if (typeof value !== "string" || !path.isAbsolute(value) || /[\x00-\x1f\x7f]/u.test(value)) {
        refuse("pr_worktree_verification_failed", "PR worktree metadata contains an unsupported path");
      }
      return realpathSync(value);
    };
    const anchor = canonical(git(repoRoot, "rev-parse", "--show-toplevel"));
    const common = canonical(git(repoRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"));
    const entries = listWorktreeEntries(repoRoot, GIT_READ_OPTIONS);
    if (!entries.length || entries.some((entry) => !path.isAbsolute(entry.path)
      || !/^[a-f0-9]{40}$/iu.test(entry.head ?? ""))) {
      refuse("pr_worktree_verification_failed", "Git did not return valid registered worktrees");
    }
    const main = canonical(entries[0].path);
    if (!entries.some((entry) => {
      try { return canonical(entry.path) === anchor; } catch (error) {
        // Unrelated stale registrations cannot prevent finding the verified caller.
        if (entry.branch !== `refs/heads/${branch}`
          && ["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(error?.code)) return false;
        throw error;
      }
    })) {
      refuse("pr_worktree_verification_failed", "Current checkout is absent from Git's worktree registrations");
    }
    const candidates = entries.slice(1).filter((entry) => entry.branch === `refs/heads/${branch}`);
    if (!candidates.length) refuse("pr_worktree_not_found", "No registered linked checkout matches the live PR branch");
    if (candidates.length !== 1) refuse("pr_worktree_ambiguous", "Multiple registered checkouts match the live PR branch");
    const checkout = canonical(candidates[0].path);
    if (checkout === main || canonical(git(checkout, "rev-parse", "--show-toplevel")) !== checkout
      || git(checkout, "symbolic-ref", "HEAD") !== `refs/heads/${branch}`
      || canonical(git(checkout, "rev-parse", "--path-format=absolute", "--git-common-dir")) !== common
      || normalizeRepoSlug(detectRepoSlug(checkout)) !== repo) {
      refuse("pr_worktree_verification_failed", "Registered PR checkout root, branch or repository changed");
    }
    const isolation = classifyWorktreeIsolation({ cwd: checkout, mainWorktreePath: main,
      allWorktreePaths: entries.map((entry) => entry.path) });
    if (!isolation.ok) refuse("pr_worktree_not_isolated", `PR checkout failed worktree isolation: ${isolation.detail}`);
    // Association follows the branch; existing action checks own local versus pushed HEAD authority.
    return { worktreeCwd: checkout, pr, repo };
  } catch (error) {
    if (error?.refusal) throw error;
    refuse("pr_worktree_verification_failed", `Cannot verify the existing PR checkout: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseFlagJson(raw, flagName, parseErrorFn) {
  try {
    return parseJsonText(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw parseErrorFn(`Invalid JSON for ${flagName}: ${message}`);
  }
}

export function parseBuildHandoffEnvelopeCliArgs(argv) {
  const options = {
    help: false,
    inputPath: undefined,
    gateState: undefined,
    overrides: undefined,
    repo: undefined,
  };

  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      input: { type: "string" },
      "gate-state": { type: "string" },
      overrides: { type: "string" },
      repo: { type: "string" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  for (const token of tokens) {
    if (token.kind === "positional") {
      throw parseError(`Unknown argument: ${token.value}`);
    }
    if (token.kind !== "option") {
      continue;
    }
    if (token.name === "help") {
      options.help = true;
      return options;
    }
    if (token.name === "input") {
      options.inputPath = requireTokenValue(token, parseError);
      continue;
    }
    if (token.name === "gate-state") {
      options.gateState = requireTokenValue(token, parseError);
      continue;
    }
    if (token.name === "overrides") {
      options.overrides = requireTokenValue(token, parseError);
      continue;
    }
    if (token.name === "repo") {
      options.repo = requireTokenValue(token, parseError);
      continue;
    }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }

  if (!options.inputPath) {
    throw parseError("--input <path> is required");
  }

  return options;
}


export async function buildHandoffEnvelopeCli(
  options,
  { adapter = createPiAdapter({ env: gitEnvNoDirOverrides() }) } = {},
) {
  // Resolve repo root via the adapter so envelope construction stays harness-agnostic.
  const cwd = adapter.getCwd();
  const repoRoot = adapter.getRepoRoot();

  // Load resolver output from file
  const inputPath = path.resolve(cwd, options.inputPath);
  const inputText = await readFile(inputPath, "utf8");
  const resolverOutput = parseJsonText(inputText);

  // A startup that already failed its config load stays refused, even if .devloops was fixed since.
  if (resolverOutput?.bundle?.configError) throw new ConfigLoadFailedError(resolverOutput.bundle.configError);

  // Load dev-loop settings from repo config
  const settings = (await loadDevLoopConfigStrict({ repoRoot })).config ?? {};

  // Parse optional gate state
  let gateState = {};
  if (options.gateState) {
    gateState = parseFlagJson(options.gateState, "--gate-state", parseError);
  }

  // Build options for envelope builder
  const envelopeOptions = {};

  // Carry the canonical sanctioned operation → wrapper command map into every
  // emitted envelope by DEFAULT so spawned subagents never re-derive it.
  envelopeOptions.sanctionedCommands = SANCTIONED_COMMANDS;

  // Repo slug: explicit --repo, then resolver output bundle, then git remote
  const bundleSlug = resolverOutput?.bundle?.repoSlug ?? resolverOutput?.bundle?.repo ?? null;
  const repoSlug = options.repo ?? bundleSlug ?? detectRepoSlug(repoRoot);
  if (repoSlug) {
    envelopeOptions.repoSlug = repoSlug;
  } else {
    throw parseError(
      "Repository slug could not be resolved. " +
      "Pass --repo <owner/name>, ensure the resolver output includes a repo slug, " +
      "or configure a git remote 'origin'.",
    );
  }
  envelopeOptions.repoRoot = repoRoot;

  // Parse optional overrides
  if (options.overrides) {
    envelopeOptions.overrides = parseFlagJson(options.overrides, "--overrides", parseError);
  }

  const bundle = resolverOutput?.bundle ?? resolverOutput;
  const binding = (await resolvePrWorktree(bundle, repoRoot, repoSlug))
    ?? resolveLocalWorktree(bundle, repoRoot, cwd);
  envelopeOptions.worktreeCwd = binding?.worktreeCwd;
  let verifiedResolverOutput = resolverOutput;
  // Only a PR binding carries the live PR facts the refinement check reads.
  if (binding?.pr && resolverOutput?.canonicalSpecSource == null && bundle?.canonicalSpecSource == null) {
    const { pr, repo } = binding;
    const refinement = await loadRefinementArtifact({ repo, prData: pr,
      prDraft: pr.isDraft === true, prClosed: pr.state === "CLOSED", prMerged: Boolean(pr.mergedAt) });
    // These enums have different domains; only the owning validator's PR-body result maps across.
    if (refinement.status === "present" && refinement.specSource === REFINEMENT_ARTIFACT_SPEC_SOURCE.PR_BODY
      && refinement.finding === null) {
      verifiedResolverOutput = { ...resolverOutput, canonicalSpecSource: CANONICAL_SPEC_SOURCE.PR_BODY };
    }
  }
  const envelope = buildDevLoopHandoffEnvelope(verifiedResolverOutput, settings, gateState, envelopeOptions);
  return envelope;
}

export async function runCli(
  argv = process.argv.slice(2),
  { stdout = process.stdout, stderr = process.stderr, adapter = createPiAdapter({ env: gitEnvNoDirOverrides() }) } = {},
) {
  let options;
  try {
    options = parseBuildHandoffEnvelopeCliArgs(argv);
  } catch (err) {
    stderr.write(`${formatCliError(err)}\n`);
    process.exitCode = 1;
    return;
  }

  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return;
  }

  try {
    const envelope = await buildHandoffEnvelopeCli(options, { adapter });
    process.exitCode = emitResult(envelope, { jq: options.jq, silent: options.silent, stdout, stderr });
  } catch (err) {
    const msg = err?.refusal
      ? JSON.stringify({ ok: false, refusal: err.refusal, error: err.message })
      : formatCliError(err);
    stderr.write(`${msg}\n`);
    process.exitCode = 1;
  }
}

if (isDirectCliRun(import.meta.url)) {
  await runCli();
}
