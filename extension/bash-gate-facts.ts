import fs from 'node:fs';
import path from 'node:path';
import { loadDevLoopConfig, resolveHumanMergeOnly } from '@dev-loops/core/config';
import {
  commandContainsGhPrReady,
  deriveInManagedRepo,
  extractPrNumberFromGhPrReadyAnywhere,
  isCleanRepoSlug,
} from '@dev-loops/core/loop/bash-command-classify';
import type { ExtensionHarnessAdapter } from './harness-types.ts';
import { PRE_PR_READY_GATE_SCRIPT, PR_READY_GATE_TIMEOUT_MS, defaultResolveRepoContext } from './post-merge-update.ts';
import type { PiBashGateFacts } from './readonly-role-gate.ts';

/**
 * Fact resolution for the Pi `tool_call` gate (issue #2965, decision record 0206).
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
 * A repo that cannot be resolved, a config that cannot be loaded and a probe that cannot run fail
 * the way the Claude hook fails: the repo facts stay permissive (no managed context, no
 * human-merge invariant), while a resolved managed repo with an unreadable PR number or a failed
 * probe stays fail-closed (deny). Repo and config facts are cached per cwd, so a session pays for
 * the git/config reads once per working directory — and the cache is revalidated on every call
 * against the repo config sources' `stat` signature, so a config that changed under the same cwd
 * is never served from the cache (a stale `humanMergeOnly: false` would fail OPEN on
 * STOP-HUMAN-MERGE-001, the rule this module exists to enforce).
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
 * The repo-level config sources a cached fact entry depends on: the `.devloops` variants the
 * `inManagedContext` probe reads, and the `.pi/dev-loop/defaults` variants the config loader layers
 * underneath them. Their `stat` signature is a cheap, spawn-free fingerprint that changes whenever
 * the repo's config content does, so the cache can be revalidated per call without a git read.
 */
const CONFIG_SOURCE_BASES = Object.freeze(['.devloops', path.join('.pi', 'dev-loop', 'defaults')]);
const CONFIG_SOURCE_EXTS = Object.freeze(['', '.yaml', '.yml', '.json']);

/** A stat fingerprint of every repo config source under `repoRoot`; absent files are pinned too. */
function configSourceSignature(repoRoot: string): string {
  const parts: string[] = [];
  for (const base of CONFIG_SOURCE_BASES) {
    for (const ext of CONFIG_SOURCE_EXTS) {
      const file = path.join(repoRoot, base + ext);
      try {
        const stat = fs.statSync(file);
        parts.push(`${base}${ext}:${stat.mtimeMs}:${stat.size}:${stat.ino}`);
      } catch {
        parts.push(`${base}${ext}:-`);
      }
    }
  }
  return parts.join('|');
}

type CachedRepoFacts = { facts: RepoFacts & { repoRoot: string | null }; configSignature: string };

async function resolveRepoFacts(exec: ExtensionHarnessAdapter['exec'], cwd: string): Promise<RepoFacts & { repoRoot: string | null }> {
  let repo;
  try {
    repo = await defaultResolveRepoContext(exec, cwd);
  } catch {
    return { ...EMPTY_REPO_FACTS, repoRoot: null };
  }
  if (!repo.repoRoot) return { ...EMPTY_REPO_FACTS, repoRoot: null };
  // A config that fails to load or validate leaves the invariant unresolved — the same fail-open
  // the Claude hook's `resolve-human-merge-only` helper takes; every other guard still applies.
  let humanMergeOnly = false;
  try {
    const { config, errors } = await loadDevLoopConfig({ repoRoot: repo.repoRoot });
    humanMergeOnly = (errors?.length ?? 0) === 0 && resolveHumanMergeOnly(config);
  } catch {
    humanMergeOnly = false;
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
    const result = await exec(`${PRE_PR_READY_GATE_SCRIPT} --repo ${facts.repoSlug} --pr ${prNumber}`, {
      cwd: facts.repoRoot ?? undefined,
      timeout: PR_READY_GATE_TIMEOUT_MS,
    });
    return result.code === 0 ? { passed: true, error: null } : NO_READY_GATE;
  } catch {
    return { passed: false, error: 'could not run scripts/loop/pre-pr-ready-gate.mjs' };
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
    // `.devloops` than the one the cached facts were resolved from (a moved checkout, a branch
    // switch, a config edit in a live session). An unresolved cwd has no config source to compare
    // (there is no repo root), so it stays cached rather than re-running git on every call.
    if (cached && (!cached.facts.repoRoot || cached.configSignature === configSourceSignature(cached.facts.repoRoot))) {
      return cached.facts;
    }
    const facts = await resolveRepoFacts(exec, cwd);
    cache.set(cwd, { facts, configSignature: facts.repoRoot ? configSourceSignature(facts.repoRoot) : '' });
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
