#!/usr/bin/env node
/**
 * PreToolUse Bash gate hook (#773).
 *
 * Blocks these commands on the target repo; everything else passes through:
 *   - `gh pr create` — blocked outright (no gate evidence to check): PR creation must flow through
 *     the canonical wrapper scripts/github/create-pr.mjs (dev-loops pr create), which always drafts
 *     and self-assigns. Closes the hole where raw `gh pr create` opens a ready PR (draft-first breach).
 *   - `gh pr ready` — needs a clean draft_gate verdict (via scripts/loop/pre-pr-ready-gate.mjs).
 *   - `gh pr merge` — blocked outright; use scripts/github/merge-pr.mjs. Its gate evidence check
 *     requires a clean draft_gate transition record + current-head pre_approval_gate
 *     (GATE-COMMENT-DRAFT-REQUIREMENTS in skills/docs/gate-review-comment-contract.md).
 *   - raw `gh issue create` / `gh issue comment` / `gh pr comment` — blocked only from a SUBAGENT
 *     context (agent_type present); the main agent/operator retains direct issue creation (#1051).
 *   - in a managed repo the whole command is denied when its tokens (any segment, any order; brace and
 *     `${VAR:-x}` forms split) hold `gh`, `pr`, `edit|create` and a body flag (`segmentHoldsBodyWrite`); fails closed.
 *   - raw `gh pr edit` body writes (`--body`/`--body-file`/`-b`/`-F`; `gh pr create` is covered by the token rule above only) and `gh api` body writes to
 *     `pulls/<n>` or `issues/<n>` (a `body` field via `-f`/`-F`/`--field`/`--raw-field`, an
 *     `--input` payload, or a `gh api graphql` `updatePullRequest`) — blocked actor-independently
 *     (`ADR-TRIPWIRE-STANDING-WAIVER`): the sanctioned launcher writers are the only route for these
 *     `gh pr` and `gh api` body writes, because they refuse a hand-written `adr-tripwire:allow` line.
 *     A process wrapper in front of the write cannot hide it from either side: the pre-check and the
 *     decision it nominates both read the wrapper-unwrapped command head (`unwrappedCommandHeads`),
 *     so a `timeout`/`sudo`/`nice`/`time`/path-prefixed wrapper's own flags are skipped too.
 *     The raw `gh issue edit <n> --body`/`--body-file` command line form is NOT covered by this deny;
 *     it stays with the subagent-scoped external-write guard, which runs only when `agent_type` is present.
 *   - `timeout N <sanctioned command>` — blocked outright: the wrapper hides the `dev-loops-run`
 *     head from operator allow rules. Run the command bare; wait/probe tools bound themselves.
 *   - `git stash` — blocked outright: `refs/stash` is shared across every worktree over this
 *     repo's one `.git` directory (skills/docs/worktree-guidance.md#never-git-stash-in-a-shared-git-layout).
 *   - `bun run verify` / `bun test` / `vitest` / `npm test` / `npm run test` / `bun run build` /
 *     `npm run build` (and yarn/pnpm equivalents) — blocked ONLY from the dev-loop COORDINATOR
 *     (agent_type "dev-loop" or "gate-coordinator"), opt-in via `DEVLOOPS_COORDINATOR_READONLY=1` (#2082). Worker
 *     subagents (developer/fixer/quality/review) may run these freely.
 *   - the `fixer` agent passes through, and its exact sanctioned work-order pull line
 *     records its agent_id as the binding the Write/Edit guard checks (ADR 0107); a modified
 *     fixer pull line (prefix, suffix, redirect, `cd`) is denied with the exact line to run.
 *     The fixer Bash commit/push boundary is owned by issue 2534.
 *   - every command from the read-only `judge` subagent except its sanctioned work-order pull
 *     (`dev-loops-run scripts/github/pull-work-order.mjs <executionIdentity>`, ADR 0106, ADR 0115),
 *     its decision check (`check-judge-decision.mjs`) and its read-only search commands (ADR 0269).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { JUDGE_AGENT_TYPE, decideBashGate, FIXER_AGENT_TYPE, isFixerPullAttempt, isUnresolveInvocation, normalizeAgentType, parseSanctionedPullLine } from "./_hook-decisions.mjs";
import { listCheckouts, parseFixerPullCommand, recordFixerAgentBinding } from "./_fixer-grants.mjs";
import {
  commandContainsGhPrReady,
  commandContainsGhPrMerge,
  commandContainsGhPrCreate,
  commandContainsRawExternalWrite,
  commandContainsGitStash,
  commandContainsInlineInterpreter,
  commandContainsSubIssueAdHocBypass,
  commandContainsReplyResolveBypass,
  commandContainsGraphqlResolveReviewThread,
  commandContainsCopilotRequestBypass,
  commandContainsCopilotSummonComment,
  commandContainsDetachedWaitTool,
  commandContainsTimeoutWrappedSanctionedTool,
  commandContainsRawPrBodyEdit,
  commandContainsRawPrBodyApiWrite,
  commandContainsCodeVerificationEntrypoint,
  extractPrNumberFromGhPrReadyAnywhere,
  extractPrNumberFromGhPrMergeAnywhere,
  normalizeGitHubRepoSlug,
  tokenizeShellCommand,
} from "./_bash-command-classify.mjs";

import { readHookInput, emitDeny, emitAllow } from "./_hook-io.mjs";

const input = readHookInput();
const command = input?.tool_input?.command;
// Claude exposes `agent_type` only inside a subagent; null in the main agent. Scopes the
// external-write guard (raw `gh issue create` etc. is blocked only from a subagent).
const agentType = typeof input?.agent_type === "string" ? input.agent_type : null;

const cwd = typeof input?.cwd === "string" && input.cwd ? input.cwd : process.cwd();

// Fixer grant binding (ADR 0107): the sanctioned pull line binds the pull's grant to this fixer's
// agent_id (see _fixer-grants.mjs); the Write/Edit guard honors only a bound grant.
const isFixer = normalizeAgentType(agentType) === FIXER_AGENT_TYPE;
const mainRoot = isFixer && parseSanctionedPullLine(command) ? listCheckouts(cwd)[0]?.root : null;
const fixerPull = mainRoot ? parseFixerPullCommand(command, mainRoot) : null;
if (fixerPull) recordFixerAgentBinding(mainRoot, { agentId: input?.agent_id, ...fixerPull });

// Consume option values only while reading a wrapper, never by dropping a possible executable.
const WRAPPER_VALUE_OPTIONS = {
  sudo: ["-u", "--user", "-g", "--group", "-h", "--host", "-p", "--prompt", "-C", "--close-from", "-T", "--command-timeout", "-D", "--chdir", "-R", "--chroot"],
  env: ["-u", "--unset", "-C", "--chdir", "-S", "--split-string"],
  xargs: ["-a", "--arg-file", "-E", "-I", "-L", "--max-lines", "-n", "--max-args", "-P", "--max-procs", "-s", "--max-chars"],
  time: ["-f", "--format", "-o", "--output"],
  nice: ["-n", "--adjustment"],
  stdbuf: ["-i", "--input", "-o", "--output", "-e", "--error"],
  ionice: ["-c", "--class", "-n", "--classdata", "-p", "--pid", "-P", "--pgid", "-u", "--uid"],
  setsid: [],
  timeout: ["-s", "--signal", "-k", "--kill-after"],
  gtimeout: ["-s", "--signal", "-k", "--kill-after"],
  command: [],
  exec: [],
};
// Options known to take no value. An option in neither table is unknown: fail closed on it.
const WRAPPER_FLAG_OPTIONS = {
  sudo: ["-n", "--non-interactive", "-E", "--preserve-env", "-H", "-b", "-k", "-K", "-S", "-A", "-B"],
  env: ["-i", "--ignore-environment", "-0", "--null", "-v", "--debug"],
  xargs: ["-0", "--null", "-r", "--no-run-if-empty", "-t", "--verbose", "-x", "-p"],
  time: ["-p", "-v", "-l"],
  ionice: ["-t", "--ignore"],
  setsid: ["-c", "--ctty", "-f", "--fork", "-w", "--wait"],
  timeout: ["--foreground", "--preserve-status", "-v", "--verbose"],
  gtimeout: ["--foreground", "--preserve-status", "-v", "--verbose"],
};

/**
 * Read each executable segment through its process wrappers. The tokenizer keeps quoted data
 * and heredoc bodies from becoming executable segments; offsets preserve the original gh flags.
 * @param {string} command @returns {string[]}
 */
function unwrappedCommandHeads(command) {
  return tokenizeShellCommand(command).segments.flatMap(({ words, end }) => {
    let i = 0;
    let wrapped = false;
    while (i < words.length) {
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i].value)) { i++; continue; }
      const wrapper = words[i].value.split("/").pop();
      if (!Object.hasOwn(WRAPPER_VALUE_OPTIONS, wrapper)) break;
      wrapped = true;
      i++;
      // Fail closed: an option or duration this parser cannot place makes every later token of
      // the segment a candidate head, and `env -S` hides the command inside its quoted value.
      let unknown = false;
      const extra = [];
      while (i < words.length && words[i].value.startsWith("-")) {
        const option = words[i++].value;
        if (option === "--") break;
        // Joined `-S<v>` / `--split-string=<v>`: the option word itself carries the command.
        const joinedSplit = wrapper === "env" ? /^(?:-S|--split-string=)(.+)$/s.exec(option) : null;
        if (joinedSplit) {
          const joined = [joinedSplit[1], i < words.length ? command.slice(words[i].start, end) : ""].join(" ").trim();
          extra.push(joined, ...unwrappedCommandHeads(joined));
        } else if (WRAPPER_VALUE_OPTIONS[wrapper].includes(option)) {
          if (wrapper === "env" && (option === "-S" || option === "--split-string") && i < words.length) {
            // The -S value splits into the command's leading words; the segment's remaining words are its tail.
            const joined = [words[i].value, i + 1 < words.length ? command.slice(words[i + 1].start, end) : ""].join(" ").trim();
            extra.push(joined, ...unwrappedCommandHeads(joined));
          }
          i++;
        } else if (!(WRAPPER_FLAG_OPTIONS[wrapper] ?? []).includes(option)) unknown = true;
      }
      if (/^g?timeout$/.test(wrapper) && !unknown) {
        if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?[smhd]?$/i.test(words[i]?.value ?? "")) unknown = true;
        else i++;
      }
      if (unknown) return [...extra, ...words.slice(i).map((word) => command.slice(word.start, end))];
      if (extra.length) return [...extra, ...(i < words.length ? [command.slice(words[i].start, end)] : [])];
    }
    return wrapped && i < words.length ? [command.slice(words[i].start, end)] : [];
  });
}

// Token deny: the whole command is a body write when its tokens, across all segments and pipes and
// in any order, hold `gh`, `pr`, `edit|create` and a body flag (`--body*`, or a short cluster with
// `b`/`F`: `-b`, `-bx`, `-b=x`, `-Fwaiver.md`, `-db`). `$(`, `)`, backticks, braces and commas split tokens so a
// command substitution or brace expansion is seen, a `${VAR:-gh}` default counts as a token, and `gh` matches by basename (`/usr/bin/gh`). No head, wrapper or echo exemption: fails closed.
// `--{body,x}` expands to `--body`, `--x`: one innermost group per pass.
// The product of the group sizes is exponential, so a word past BRACE_EXPANSION_CAP returns null and the caller fails closed.
const BRACE_EXPANSION_CAP = 64;
function braceExpansions(value) {
  let words = [value];
  for (;;) {
    let expanded = false;
    words = words.flatMap((word) => {
      // Linear scan for the first innermost `{...,...}` group; a regex here backtracks quadratically on an unclosed `{`.
      let open = -1;
      let comma = false;
      let end = -1;
      for (let k = 0; k < word.length && end < 0; k++) {
        const c = word[k];
        if (c === "{") { open = k; comma = false; }
        else if (c === ",") comma ||= open >= 0;
        else if (c === "}") { if (open >= 0 && comma) end = k; else { open = -1; comma = false; } }
      }
      if (end < 0) return [word];
      expanded = true;
      return word.slice(open + 1, end).split(",").map((alt) => word.slice(0, open) + alt + word.slice(end + 1));
    });
    if (words.length > BRACE_EXPANSION_CAP) return null;
    if (!expanded) return words;
  }
}

function segmentHoldsBodyWrite(command) {
  let overCap = false;
  const tokens = tokenizeShellCommand(command).segments.flatMap(({ words }) =>
    words.flatMap((word) => [...(braceExpansions(word.value) ?? (overCap = true, [])), ...word.value.split(/[\s=$(){},`]+/).filter(Boolean)
      // `${G:-gh}` leaves `G:-gh`: also keep the default value. Needs a leading name, so `--body`/`-b` are untouched.
      .flatMap((t) => [t, t.replace(/^[A-Za-z_]\w*:?[-+]/, "")])]));
  const has = (test) => tokens.some((token) => test(token));
  return overCap || has((t) => /^(?:-S)?gh$/.test(t.split("/").pop())) && has((t) => t === "pr") && has((t) => t === "edit" || t === "create") &&
    has((t) => t.startsWith("--body") || /^-[^-]*[bF]/.test(t));
}

let repoRoot = null;
let repoSlug = null;
try {
  repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim();
  const remote = execFileSync("git", ["config", "--get", "remote.origin.url"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  repoSlug = normalizeGitHubRepoSlug(remote);
} catch {
  // Not a git repo / no remote — repoSlug stays null; decider passes through.
}

// A repo is dev-loops-managed when a `.devloops` config exists at its root (the dev-loops-driven
// context) — replaces the old hardcoded-slug (`repoSlug === TARGET_REPO_SLUG`) comparison so the
// guard suite applies in any managed consumer repo, not only mfittko/dev-loops. The config loader
// (packages/core/src/config/config.mjs) accepts a bare `.devloops` file OR any of the
// `.yaml`/`.yml`/`.json` extensions; this hook is self-contained (cannot import @dev-loops/core),
// so the same small variant list is replicated inline rather than hardcoding the bare filename —
// a consumer configured via `.devloops.yaml` alone must still be recognized as managed, or every
// guard below fails open for it.
const DEVLOOPS_CONFIG_VARIANTS = ["", ".yaml", ".yml", ".json"];
const inManagedContext =
  repoRoot != null && DEVLOOPS_CONFIG_VARIANTS.some((ext) => fs.existsSync(path.join(repoRoot, `.devloops${ext}`)));
const managedRepoSlug = inManagedContext ? repoSlug : null;

// The quick pre-check booleans below must be computed AFTER managedRepoSlug resolves: the three
// gh-api classifiers match the managed repo's absolute `repos/<slug>/...` path form only when
// given that slug, so computing them before resolution (with an implicit null slug) would miss an
// absolute-path match and wrongly short-circuit to allow.
const isReady = typeof command === "string" && commandContainsGhPrReady(command);
const isMerge = typeof command === "string" && commandContainsGhPrMerge(command);
const isCreate = typeof command === "string" && commandContainsGhPrCreate(command);
const isExternalWrite = typeof command === "string" && commandContainsRawExternalWrite(command);
const isStash = typeof command === "string" && commandContainsGitStash(command);
// The six-guard-rule predicates (#1622) — each is decided (with scope + actor policy) inside
// decideBashGate, so the hook must not short-circuit to allow before deciding them.
const isInline = typeof command === "string" && commandContainsInlineInterpreter(command);
const isSubIssue = typeof command === "string" && commandContainsSubIssueAdHocBypass(command, managedRepoSlug);
const isReplyResolve =
  typeof command === "string" &&
  (commandContainsReplyResolveBypass(command, managedRepoSlug) || commandContainsGraphqlResolveReviewThread(command));
const isRequestApi = typeof command === "string" && commandContainsCopilotRequestBypass(command, managedRepoSlug);
const isCopilotSummon = typeof command === "string" && commandContainsCopilotSummonComment(command);
const isWaitTool = typeof command === "string" && commandContainsDetachedWaitTool(command);
// The `timeout N <sanctioned command>` deny is decided in the shared decider; the pre-check only
// detects the shape, because a shape it does not name reaches `emitAllow()` before the decider runs.
const isTimeoutWrapped = typeof command === "string" && commandContainsTimeoutWrappedSanctionedTool(command);
// The `ADR-TRIPWIRE-STANDING-WAIVER` raw PR/issue body write shapes are decided in the shared
// decider and denied for EVERY actor, operator and main agent included. The pre-check must
// nominate them too, or the non-match path allows what the decider would deny.
//
// Both sides anchor those predicates on a segment's command HEAD, and `SHELL_EXEC_PREFIX`
// tolerates `NAME=value` assignments, the `env`/`command`/`exec` words and a binary path but NOT a
// process wrapper, so the wrapped form of a shape this file already names (`timeout 300 gh pr edit
// 5 --body-file f`, `sudo -n gh api … -f body=x`) reached neither and the hook emitted allow. Read
// the unwrapped heads as well, here and in the deny below.
const bodyWriteHeads = typeof command === "string" ? [command, ...unwrappedCommandHeads(command)] : [];
const hasRawPrBodyWrite = (view) =>
  commandContainsRawPrBodyEdit(view, managedRepoSlug) || commandContainsRawPrBodyApiWrite(view, managedRepoSlug);
const isSegmentBodyWrite = inManagedContext && typeof command === "string" && segmentHoldsBodyWrite(command);
const isBodyWrite = isSegmentBodyWrite || bodyWriteHeads.some(hasRawPrBodyWrite);
// COORDINATOR-VERIFY-BOUNDARY (#2082) — actor-scoped inside decideBashGate (agentType is
// "dev-loop" or "gate-coordinator"), so the quick pre-check here only detects the command shape; the hook must not
// short-circuit to allow before the decider applies the actor + enforceCoordinator scoping.
const isVerifyEntrypoint = typeof command === "string" && commandContainsCodeVerificationEntrypoint(command);
// The read-only judge may run only its work-order pull, check-judge-decision (ADR 0106) and read-only search commands (ADR 0269); every judge command reaches the decider.
const isJudge = normalizeAgentType(agentType) === JUDGE_AGENT_TYPE;
// A fixer pull attempt reaches the decider, which denies any line other than the exact one.
const isFixerPull = isFixer && isFixerPullAttempt(command);
// Unresolve ownership (issue 2577): the decider denies it for every agent type except the owners.
const isUnresolve = isUnresolveInvocation(command);
if (
  !isReady && !isMerge && !isCreate && !isExternalWrite && !isStash &&
  !isInline && !isSubIssue && !isReplyResolve && !isRequestApi && !isCopilotSummon && !isWaitTool &&
  !isTimeoutWrapped && !isBodyWrite && !isVerifyEntrypoint && !isJudge && !isFixerPull && !isUnresolve
) {
  emitAllow();
}

let gatePassed = false;
let gateError = null;
let humanMergeOnly = false;
const launcher = fileURLToPath(new URL("../bin/dev-loops-run", import.meta.url));
function runHelper(script, args = [], override = null, options = {}) {
  return execFileSync(process.execPath, [...(override ? [override] : [launcher, script]), ...args], {
    cwd: repoRoot, encoding: "utf8", ...options,
  });
}
if (inManagedContext) {
  // When both verbs appear (compound command), apply the stricter merge gate.
  const pr = isMerge ? extractPrNumberFromGhPrMergeAnywhere(command) : extractPrNumberFromGhPrReadyAnywhere(command);
  // STOP-HUMAN-MERGE-001 (#1622): resolve the repo's effective `autonomy.humanMergeOnly` via the
  // resolved toolchain (the hook bundle cannot import @dev-loops/core); fail
  // open (false) when the script is unavailable so the loop-level merge safety remains authoritative.
  if (isMerge && repoRoot) {
    try {
      humanMergeOnly = runHelper("scripts/loop/resolve-human-merge-only.mjs").trim() === "true";
    } catch {
      humanMergeOnly = false;
    }
  }
  // The gate scripts need `--repo <slug>`; when repoSlug is unresolved, skip running them and
  // leave gatePassed=false — the decider then denies ready/merge fail-closed rather than running
  // an ambiguous-repo evidence check.
  if (pr !== null && repoRoot && repoSlug) {
    // Each gate script is overridable for deterministic testing (stub instead of the
    // network-touching real guard). `gh pr ready` → draft-gate only; `gh pr merge` → the full
    // pre-merge evidence check (draft_gate + pre_approval_gate).
    const gateScript = isMerge ? "scripts/github/detect-checkpoint-evidence.mjs" : "scripts/loop/pre-pr-ready-gate.mjs";
    const override = isMerge ? process.env.DEVLOOPS_PRE_MERGE_GATE_SCRIPT : process.env.DEVLOOPS_PRE_PR_READY_GATE_SCRIPT;
    try {
      runHelper(gateScript, ["--repo", repoSlug, "--pr", String(pr)], override, { stdio: ["ignore", "ignore", "pipe"] });
      gatePassed = true;
    } catch (error) {
      const stderr = String(error?.stderr ?? "").trim();
      // Native loader/launcher diagnostics also exit 1; JSON evidence errors are not startup failures.
      const startupFailure = /^(?:dev-loops-run: (?:cannot resolve|cannot start)|Error(?: \[ERR_MODULE_NOT_FOUND\])?: Cannot find (?:module|package)|TypeError \[ERR_UNKNOWN_FILE_EXTENSION\]: Unknown file extension|Error \[ERR_UNSUPPORTED_DIR_IMPORT\]: Directory import|Error: (?:EACCES: permission denied|EPERM: operation not permitted), open |SyntaxError:)/m.test(stderr);
      if (typeof error?.status !== "number" || startupFailure) {
        gateError = `could not run ${gateScript} via ${override || launcher} in consumer ${repoRoot}: ${stderr || error.message}`;
      }
    }
  }
}

// Boundary 3 (#2082): the coordinator verify-command delegation boundary, gated by the SAME flag
// as boundary 3 of pre-tool-use-write-guard.mjs (decideCoordinatorWriteGuard).
const enforceCoordinator = process.env.DEVLOOPS_COORDINATOR_READONLY === "1";

const bashGateFacts = {
  command,
  repoSlug,
  managedRepoSlug,
  inManagedContext,
  gatePassed,
  gateError,
  agentType,
  humanMergeOnly,
  enforceCoordinator,
};
const decision = decideBashGate(bashGateFacts);
if (decision.decision === "deny") {
  emitDeny(decision.reason);
}
// A raw body write behind a wrapper prefix: the decision above reads the command it is handed, so
// the wrapped form cannot produce its own deny. Judge the unwrapped heads too and honor the deny.
for (const head of bodyWriteHeads.slice(1)) {
  if (!hasRawPrBodyWrite(head)) continue;
  const unwrappedDecision = decideBashGate({ ...bashGateFacts, command: head });
  if (unwrappedDecision.decision === "deny") {
    emitDeny(unwrappedDecision.reason);
  }
}
if (isSegmentBodyWrite) {
  emitDeny(
    "ADR-TRIPWIRE-STANDING-WAIVER: this command holds the gh, pr, edit or create and body-flag tokens (or a brace expansion too large to read), so it is blocked as a raw PR body write. " +
    "Write a PR body through the launcher: `dev-loops-run cli/index.mjs pr create` or `dev-loops-run cli/index.mjs pr edit` (it refuses a hand-written adr-tripwire:allow line). " +
    "Edit an issue body through `dev-loops-run cli/index.mjs issue edit`. " +
    "If the launcher command itself was denied because its title or body text holds the word gh, rephrase the title or move the text into the body file. " +
    "If a data word with many comma brace groups (a JSON or jq argument) tripped the size limit, write the data to a file and pass it with `--input <file>` or `-F field=@<file>`.",
  );
}
emitAllow();
