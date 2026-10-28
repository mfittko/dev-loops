import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDevLoopConfig, resolveHumanMergeOnly } from '@dev-loops/core/config';
import {
  DEVLOOPS_CONFIG_VARIANTS,
  commandContainsGhPrReady,
  deriveInManagedRepo,
  extractPrNumberFromGhPrReadyAnywhere,
  isCleanRepoSlug,
} from '@dev-loops/core/loop/bash-command-classify';
import { prReadySegmentsProvenForeign } from '@dev-loops/core/loop/bash-gate-decisions';
import type { ExtensionHarnessAdapter } from './harness-types.ts';
import { PRE_PR_READY_GATE_SCRIPT, PR_READY_GATE_TIMEOUT_MS, defaultResolveRepoContext } from './post-merge-update.ts';
import type { PiBashGateFacts } from './readonly-role-gate.ts';

/**
 * Fact resolution for the Pi `tool_call` gate (Bash-gate deny rules:
 * `packages/core/src/loop/bash-gate-decisions.mjs`, decision record 0206).
 *
 * `extension/readonly-role-gate.ts` stays pure: it feeds these facts into the shared
 * `decideBashGateDeny` the Claude PreToolUse hook also calls. The facts mirror exactly what the
 * Claude hook gathers before it decides:
 *   - repo identity (repo root, slug, `.devloops` presence) via the post-merge hook's resolver;
 *   - `autonomy.humanMergeOnly` via `loadDevLoopConfig` + `resolveHumanMergeOnly`;
 *   - `enforceCoordinator` from `DEVLOOPS_COORDINATOR_READONLY=1`, the same flag the Claude hook and
 *     the coordinator write boundary read;
 *   - the `gh pr ready` draft-gate probe, run only when that verb appears in a managed repo.
 *
 * A repo that cannot be resolved and a probe that cannot run fail the way the Claude hook fails:
 * the repo facts stay permissive (no managed context, no human-merge invariant), while a resolved
 * managed repo with an unreadable PR number or a failed probe stays fail-closed (deny). The
 * human-merge invariant is read from the merged config the loader returns, errors included: a
 * schema-rejected repo layer is dropped while every merged layer underneath it stays in effect, so
 * the packaged `autonomy.humanMergeOnly: true` default still binds (mirrors the Claude edge's
 * `scripts/loop/resolve-human-merge-only.mjs`). Repo and config facts are cached per resolved cwd,
 * so a session pays for the git/config reads once per working directory — and the cache is
 * revalidated on every call against a signature of that repo's own `.devloops` and
 * `.pi/dev-loop/defaults` variants (a content digest of each file that exists), so an edit to one of
 * those files is never served from the cache — not even a same-size rewrite inside one filesystem
 * timestamp tick (a stale `humanMergeOnly: false` would fail OPEN on STOP-HUMAN-MERGE-001, the rule
 * this module exists to enforce). That signature does not cover the packaged extension-defaults layer
 * the loader always merges, nor the git remote the slug derives from; an unresolved (non-repo) cwd is
 * not cached at all, so a directory that becomes a repo later is re-probed on the next call.
 */

type RepoFacts = Pick<PiBashGateFacts, 'inManagedContext' | 'managedRepoSlug' | 'repoSlug' | 'humanMergeOnly'>;

const EMPTY_REPO_FACTS: RepoFacts = Object.freeze({
  inManagedContext: false,
  managedRepoSlug: null,
  repoSlug: null,
  humanMergeOnly: false,
});

const NO_READY_GATE: { passed: false; error: null } = Object.freeze({ passed: false, error: null });

/**
 * The draft-gate evidence script, derived from the ONE declaration the extension already carries
 * (`PRE_PR_READY_GATE_SCRIPT`, the post-merge hook's own invocation) so a rename or flag change is
 * applied there once instead of by hand in every copy.
 *
 * The absolute path resolves from THIS module's own location — the dev-loops package the extension
 * runs from — never from the cwd repo. The Claude edge resolves its own launcher the same way
 * (`<plugin>/bin/dev-loops-run`) and runs it with `cwd: repoRoot`; a repo-relative path would deny
 * every `gh pr ready` in a managed consumer repo that ships no `scripts/loop/` of its own, where the
 * identical command is allowed on Claude Code. Quoted at the call site so an install path containing
 * spaces still reaches the script.
 */
const READY_GATE_SCRIPT_LABEL = PRE_PR_READY_GATE_SCRIPT.replace(/^node\s+/, '');
const READY_GATE_SCRIPT = fileURLToPath(new URL(`../${READY_GATE_SCRIPT_LABEL}`, import.meta.url));
/**
 * Node's own startup diagnostics (missing module, unknown extension, permission error): the probe
 * never reached the gate script, so "could not run" must not be reported as "no clean record".
 * Mirrors the Claude hook's `startupFailure` discrimination in `pre-tool-use-bash-gate.mjs`.
 */
const READY_GATE_STARTUP_FAILURE_RE =
  /^(?:Error(?: \[ERR_MODULE_NOT_FOUND\])?: Cannot find (?:module|package)|TypeError \[ERR_UNKNOWN_FILE_EXTENSION\]|Error \[ERR_UNSUPPORTED_DIR_IMPORT\]|Error: (?:EACCES: permission denied|EPERM: operation not permitted), open |SyntaxError:)/m;

/** The gate tool's JSON `{ "error": ... }` on stderr, or null when stderr carries none. */
function reportedGateError(stderr: string): string | null {
  try {
    const parsed = JSON.parse(stderr);
    return typeof parsed?.error === 'string' && parsed.error.trim() !== '' ? parsed.error : null;
  } catch {
    return null;
  }
}

/** The probe could not run at all (spawn, timeout, or node startup failure). */
const couldNotRunReadyGate = (): { passed: false; error: string } =>
  ({ passed: false, error: `could not run ${READY_GATE_SCRIPT_LABEL}` });

/**
 * The repo-level config sources a cached fact entry depends on: the `.devloops` variants the
 * `inManagedContext` probe reads (the core `DEVLOOPS_CONFIG_VARIANTS` list, so a newly supported
 * variant cannot leave the cache blind to it), and the `.pi/dev-loop/defaults` variants the config
 * loader layers underneath them. The packaged extension-defaults layer and the git remote are
 * outside this signature.
 */
const DEFAULTS_CONFIG_BASE = path.join('.pi', 'dev-loop', 'defaults');
// The config loader probes these variants of every config base (packages/core/src/config/config.mjs).
const DEFAULTS_CONFIG_EXTS = Object.freeze(['', '.yaml', '.yml', '.json']);
const CONFIG_SOURCE_FILES = Object.freeze([
  ...DEVLOOPS_CONFIG_VARIANTS.map((ext) => `.devloops${ext}`),
  ...DEFAULTS_CONFIG_EXTS.map((ext) => `${DEFAULTS_CONFIG_BASE}${ext}`),
]);

/**
 * A fingerprint of every repo config source under `repoRoot`: absent files are pinned as absent and
 * each present file contributes a digest of its bytes. A `stat`-only signature (`mtimeMs`, `size`,
 * `ino`) cannot see a same-size rewrite inside one filesystem timestamp tick, which would serve a
 * stale `humanMergeOnly`. Every file that exists is small, so the digest costs one read per present
 * source (usually one) and no spawn.
 */
function configSourceSignature(repoRoot: string): string {
  const parts: string[] = [];
  for (const file of CONFIG_SOURCE_FILES) {
    try {
      parts.push(`${file}:${createHash('sha256').update(fs.readFileSync(path.join(repoRoot, file))).digest('hex')}`);
    } catch {
      parts.push(`${file}:-`);
    }
  }
  return parts.join('|');
}

type CachedRepoFacts = { facts: RepoFacts & { repoRoot: string }; configSignature: string };

async function resolveRepoFacts(exec: ExtensionHarnessAdapter['exec'], cwd: string): Promise<RepoFacts & { repoRoot: string | null }> {
  let repo;
  try {
    repo = await defaultResolveRepoContext(exec, cwd);
  } catch {
    return { ...EMPTY_REPO_FACTS, repoRoot: null };
  }
  if (!repo.repoRoot) return { ...EMPTY_REPO_FACTS, repoRoot: null };
  // Resolve the invariant from the merged config exactly as the Claude edge's
  // `scripts/loop/resolve-human-merge-only.mjs` does — it ignores `errors` too. A schema-rejected
  // `.devloops` drops only its own layer; every layer merged underneath it (including the packaged
  // `autonomy.humanMergeOnly: true` default) stays in effect, so gating on `errors.length === 0`
  // would silently fail OPEN on STOP-HUMAN-MERGE-001, the rule this module exists to enforce.
  let humanMergeOnly = false;
  // Only read inside a managed context: STOP-HUMAN-MERGE-001 is the sole consumer and it also
  // requires a managed repo, so this skips the parse without changing any decision (fail-closed
  // semantics unchanged — the catch below leaves the same `false`).
  if (repo.inManagedContext) {
    try {
      const { config } = await loadDevLoopConfig({ repoRoot: repo.repoRoot });
      humanMergeOnly = resolveHumanMergeOnly(config);
    } catch {
      humanMergeOnly = false;
    }
  }
  return {
    inManagedContext: repo.inManagedContext,
    managedRepoSlug: repo.inManagedContext ? repo.repoSlug : null,
    repoSlug: repo.repoSlug,
    humanMergeOnly,
    repoRoot: repo.repoRoot,
  };
}

/**
 * The draft-gate evidence probe for a `gh pr ready` command, mirroring the Claude hook's
 * `pre-pr-ready-gate.mjs` invocation. `null` when the command carries no ready verb.
 */
async function resolveReadyGate(
  exec: ExtensionHarnessAdapter['exec'],
  facts: RepoFacts & { repoRoot: string | null },
  command: string,
): Promise<PiBashGateFacts['readyGate']> {
  if (!commandContainsGhPrReady(command)) return null;
  // The shared decider allows a ready verb whose EVERY segment is PROVEN foreign (an explicit repo
  // differing from the managed slug) BEFORE it consults `readyGate`, so probing there would spend up
  // to PR_READY_GATE_TIMEOUT_MS on a command that runs anyway. Same normalized slug the decider
  // compares against, from the same shared escape.
  const managedSlug = (facts.managedRepoSlug ?? '').trim().toLowerCase() || null;
  if (prReadySegmentsProvenForeign(command, managedSlug)) return null;
  const prNumber = extractPrNumberFromGhPrReadyAnywhere(command);
  // No PR number or no clean slug to probe: deny fail-closed with the decider's own message.
  if (prNumber === null || !facts.repoSlug || !isCleanRepoSlug(facts.repoSlug)) return NO_READY_GATE;
  const inManagedRepo = deriveInManagedRepo({
    inManagedContext: facts.inManagedContext,
    managedRepoSlug: facts.managedRepoSlug,
    repoSlug: facts.repoSlug,
  });
  if (!inManagedRepo) return null;
  try {
    const result = await exec(`node "${READY_GATE_SCRIPT}" --repo ${facts.repoSlug} --pr ${prNumber}`, {
      cwd: facts.repoRoot ?? undefined,
      timeout: PR_READY_GATE_TIMEOUT_MS,
    });
    if (result.code !== 0 || result.killed) {
      // Keep the probe's own verdict: "could not run" (spawn/timeout/startup), the tool's reported
      // evidence error, and "ran, found no clean record" are three different denials.
      if (result.killed) return couldNotRunReadyGate();
      const reported = reportedGateError(`${result.stderr ?? ''}`.trim());
      if (reported) return { passed: false, error: reported };
      if (READY_GATE_STARTUP_FAILURE_RE.test(`${result.stderr ?? ''}`)) return couldNotRunReadyGate();
      return NO_READY_GATE;
    }
    return { passed: true, error: null };
  } catch {
    return couldNotRunReadyGate();
  }
}

/**
 * Build the per-cwd cached facts resolver the `tool_call` handler awaits for every `bash` call.
 */
export function createPiBashGateFactsResolver({
  exec,
  env = process.env,
}: {
  exec: ExtensionHarnessAdapter['exec'];
  env?: Record<string, string | undefined>;
}): (call: { cwd: string; command: string }) => Promise<PiBashGateFacts> {
  const cache = new Map<string, CachedRepoFacts>();
  async function cachedRepoFacts(cwd: string): Promise<RepoFacts & { repoRoot: string | null }> {
    const cached = cache.get(cwd);
    // Revalidate a resolved repo against its config sources: the same cwd may hold a different
    // `.devloops` than the one the cached facts were resolved from (a branch switch, a config edit
    // in a live session). An unresolved cwd has no config source to compare and is NOT cached, so a
    // directory that becomes a repo later is re-probed instead of serving permissive facts forever.
    if (cached && cached.configSignature === configSourceSignature(cached.facts.repoRoot)) {
      return cached.facts;
    }
    const facts = await resolveRepoFacts(exec, cwd);
    if (facts.repoRoot) cache.set(cwd, { facts, configSignature: configSourceSignature(facts.repoRoot) });
    return facts;
  }
  return async function resolveBashGateFacts({ cwd, command }) {
    const repoFacts = await cachedRepoFacts(cwd);
    return {
      inManagedContext: repoFacts.inManagedContext,
      managedRepoSlug: repoFacts.managedRepoSlug,
      repoSlug: repoFacts.repoSlug,
      humanMergeOnly: repoFacts.humanMergeOnly,
      enforceCoordinator: env.DEVLOOPS_COORDINATOR_READONLY === '1',
      readyGate: await resolveReadyGate(exec, repoFacts, command),
    };
  };
}
