import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILE_VARIANTS, loadDevLoopConfig, resolveHumanMergeOnly } from '@dev-loops/core/config';
import {
  commandContainsGhPrReady,
  deriveInManagedRepo,
  extractPrNumberFromGhPrReadyAnywhere,
  isCleanRepoSlug,
} from '@dev-loops/core/loop/bash-command-classify';
import { prReadySegmentsProvenForeign } from '@dev-loops/core/loop/bash-gate-decisions';
import type { ExtensionHarnessAdapter } from './harness-types.ts';
import { PRE_PR_READY_GATE_SCRIPT, PR_READY_GATE_TIMEOUT_MS, defaultResolveRepoContext, type RepoContext } from './post-merge-update.ts';
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
 * A resolved managed repo with an unreadable PR number or a failed draft-gate probe stays
 * fail-closed (deny). A git identity probe that cannot answer at all — a rejected `exec`, the 5s cap
 * killing a slow login shell, a non-zero exit, or noisy stdout the single-line guard rejects — is
 * NOT read as "no managed context": that would switch every managed-repo deny off (the raw merge and
 * waiver-write rules included) for the session. A `cwd` the resolver cannot use at all — a
 * non-string, or an empty/blank string — is the same case, rejected before either `path.resolve` or
 * `exec` sees it. The cwd is treated as a managed checkout when a
 * `.devloops` layer sits at it or above it, with the repo identity left unresolved so every
 * slug-scoped rule fails closed, and that entry is re-probed rather than cached (a login shell that
 * was slow once must not pin the session to a degraded answer). The Claude edge cannot hit this
 * case: it probes with `execFileSync('git', …)`, no login shell and no cap. The
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
/** Repo facts plus the root they were resolved from, and whether the git probe itself answered. */
type ResolvedRepoFacts = RepoFacts & { repoRoot: string | null; probed: boolean };

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
 * The repo-level config sources a cached fact entry depends on: both repo-local layers the config
 * loader reads — the `.devloops` family above, and the `.pi/dev-loop/defaults` family underneath it
 * — each probed in the loader's own `CONFIG_FILE_VARIANTS` order. Deriving the extensions from the
 * loader's exported list is what keeps the signature honest: one hand-copied variant list per base
 * silently served a cached `humanMergeOnly` for a file the loader had started reading (or stopped
 * reading). The packaged extension-defaults layer and the git remote are outside this signature.
 */
const DEVLOOPS_CONFIG_BASE = '.devloops';
const DEFAULTS_CONFIG_BASE = path.join('.pi', 'dev-loop', 'defaults');
const CONFIG_SOURCE_FILES = Object.freeze([
  ...CONFIG_FILE_VARIANTS.map((ext) => `${DEVLOOPS_CONFIG_BASE}${ext}`),
  ...CONFIG_FILE_VARIANTS.map((ext) => `${DEFAULTS_CONFIG_BASE}${ext}`),
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

type CachedRepoFacts = { facts: ResolvedRepoFacts & { repoRoot: string }; configSignature: string };

/**
 * The nearest directory at `cwd` or above it that carries a repo-local config layer (`.devloops`),
 * probed in the loader's own `CONFIG_FILE_VARIANTS` order — i.e. a directory that LOOKS like a
 * dev-loops-managed checkout. Only consulted when the git identity probe cannot answer, so a failed
 * probe still gates the managed-repo rules instead of failing open. The walk stops before the home
 * directory (and at the filesystem root): a `~/.devloops` is an operator-level config, not evidence
 * that an arbitrary cwd belongs to a managed checkout.
 */
function managedCheckoutRoot(cwd: string): string | null {
  const home = os.homedir();
  let dir = path.resolve(cwd);
  for (;;) {
    if (dir === home) return null;
    if (CONFIG_FILE_VARIANTS.some((ext) => fs.existsSync(path.join(dir, `.devloops${ext}`)))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function resolveRepoFacts(
  probeRepoContext: (cwd: string) => Promise<RepoContext>,
  cwd: string,
): Promise<ResolvedRepoFacts> {
  let repo: RepoContext | null;
  try {
    repo = await probeRepoContext(cwd);
  } catch {
    repo = null;
  }
  const probed = repo?.identityProbe === 'ok';
  // An UNKNOWN probe outcome falls back to the config-layer walk (see the module header): the cwd is
  // then treated as managed with its identity unresolved, so every slug-scoped rule keeps failing
  // closed. A definitive "not a git repository" answer is not unknown — it stays permissive, exactly
  // as on the Claude edge.
  // The tri-state is TOTAL: ONLY the explicit `not-a-repo` answer is permissive. A rejected `exec`
  // (spawn failure, or the 5s cap rejecting) leaves `repo` null (unknown), and a context that
  // carries no `identityProbe` tag at all — the shape the injectable repo-context seam hands over —
  // is unknown too. Reading a missing tag as "not a repository" would flip every managed-repo deny
  // off (the fail-open this module closes), so anything but the explicit answer walks the config
  // layer fail-closed.
  const unknown = !probed && repo?.identityProbe !== 'not-a-repo';
  const repoRoot = probed ? repo!.repoRoot : unknown ? managedCheckoutRoot(cwd) : null;
  if (!repoRoot) return { ...EMPTY_REPO_FACTS, repoRoot: null, probed: false };
  const inManagedContext = probed ? repo!.inManagedContext : true;
  const repoSlug = probed ? repo!.repoSlug : null;
  // Resolve the invariant from the merged config exactly as the Claude edge's
  // `scripts/loop/resolve-human-merge-only.mjs` does — it ignores `errors` too. A schema-rejected
  // `.devloops` drops only its own layer; every layer merged underneath it (including the packaged
  // `autonomy.humanMergeOnly: true` default) stays in effect, so gating on `errors.length === 0`
  // would silently fail OPEN on STOP-HUMAN-MERGE-001, the rule this module exists to enforce.
  let humanMergeOnly = false;
  // Only read inside a managed context: STOP-HUMAN-MERGE-001 is the sole consumer and it also
  // requires a managed repo, so this skips the parse without changing any decision (fail-closed
  // semantics unchanged — the catch below leaves the same `false`).
  if (inManagedContext) {
    try {
      const { config } = await loadDevLoopConfig({ repoRoot });
      humanMergeOnly = resolveHumanMergeOnly(config);
    } catch {
      humanMergeOnly = false;
    }
  }
  return {
    inManagedContext,
    managedRepoSlug: inManagedContext ? repoSlug : null,
    repoSlug,
    humanMergeOnly,
    repoRoot,
    probed,
  };
}

/**
 * The draft-gate evidence probe for a `gh pr ready` command, mirroring the Claude hook's
 * `pre-pr-ready-gate.mjs` invocation. `null` when the command carries no ready verb.
 */
async function resolveReadyGate(
  exec: ExtensionHarnessAdapter['exec'],
  facts: ResolvedRepoFacts,
  command: string,
): Promise<PiBashGateFacts['readyGate']> {
  if (!commandContainsGhPrReady(command)) return null;
  // The shared decider allows a ready verb whose EVERY segment is PROVEN foreign (an explicit repo
  // differing from the managed slug) BEFORE it consults `readyGate`, so probing there would spend up
  // to PR_READY_GATE_TIMEOUT_MS on a command that runs anyway. The escape normalizes the slug itself,
  // so the resolved fact is handed over unchanged: the rule has one home, not a copy here that could
  // stop agreeing with the decision it predicts.
  if (prReadySegmentsProvenForeign(command, facts.managedRepoSlug)) return null;
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
  resolveRepoContext,
}: {
  exec: ExtensionHarnessAdapter['exec'];
  env?: Record<string, string | undefined>;
  /**
   * The repo-context seam `createPostMergeUpdateHook` also exposes, for callers that already hold a
   * resolved context. Defaults to the real `defaultResolveRepoContext(exec, cwd)`. Injecting a
   * resolver does NOT relax the classification: a context carrying no `identityProbe` tag is
   * UNKNOWN, never permissive (`resolveRepoFacts`).
   */
  resolveRepoContext?: (cwd: string) => Promise<RepoContext>;
}): (call: { cwd: string; command: string }) => Promise<PiBashGateFacts> {
  const probeRepoContext = resolveRepoContext ?? ((cwd: string) => defaultResolveRepoContext(exec, cwd));
  const cache = new Map<string, CachedRepoFacts>();
  async function cachedRepoFacts(cwd: string): Promise<ResolvedRepoFacts> {
    const cached = cache.get(cwd);
    // Revalidate a resolved repo against its config sources: the same cwd may hold a different
    // `.devloops` than the one the cached facts were resolved from (a branch switch, a config edit
    // in a live session). An unresolved cwd has no config source to compare and is NOT cached, so a
    // directory that becomes a repo later is re-probed instead of serving permissive facts forever.
    if (cached && cached.configSignature === configSourceSignature(cached.facts.repoRoot)) {
      return cached.facts;
    }
    const facts = await resolveRepoFacts(probeRepoContext, cwd);
    // Only a probe-backed entry is cached: a degraded (unresolved-identity) or rootless answer is
    // re-probed on the next call, so a transient probe failure never pins the session.
    if (facts.probed && facts.repoRoot) cache.set(cwd, { facts, configSignature: configSourceSignature(facts.repoRoot) });
    return facts;
  }
  return async function resolveBashGateFacts({ cwd, command }) {
    // A cwd this resolver cannot probe must never reach `path.resolve` or `exec`: `path.resolve`
    // throws on a non-string (rejecting the `tool_call` handler, so the command runs with no
    // decision at all) and `exec` with an empty cwd would probe the HOST process directory and
    // describe a different repo than the session's — either way STOP-HUMAN-MERGE-001,
    // RAW-GH-PR-MERGE-BYPASS, WORKTREE-NO-STASH and the tripwire waiver write stop being enforced.
    // Reject it up front with the fail-closed shape a degraded probe resolves to: a managed context
    // with the identity unresolved, so every managed-repo deny stays armed. `humanMergeOnly` is the
    // one value that must NOT default permissively here — the packaged default for a managed repo is
    // `true`, and `false` would fail STOP-HUMAN-MERGE-001 open (`ADAPTER_FACTS`,
    // `bash-gate-decisions.mjs`), one of the four denies this guard keeps armed.
    if (typeof cwd !== 'string' || cwd.trim() === '') {
      return {
        inManagedContext: true,
        managedRepoSlug: null,
        repoSlug: null,
        humanMergeOnly: true,
        enforceCoordinator: env.DEVLOOPS_COORDINATOR_READONLY === '1',
        readyGate: null,
      };
    }
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
