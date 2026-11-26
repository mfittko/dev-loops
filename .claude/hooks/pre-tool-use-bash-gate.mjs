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
 *   - `decideBashGate` and the token rules below decide every command; the hook has no separate pre-check list.
 *   - in a managed repo the whole command is denied for EVERY actor (`OPERATOR-OWNED-LINE`) when its tokens hold
 *     `gh`, `issue|pr`, `comment` and a body flag or an editor flag (`--editor`, `--edit*`, a short cluster with `e`);
 *     `gh`, `pr`, `review` and a body flag; `gh`, `issue|pr`, `close|reopen` and `--comment*` or a short cluster with `c`
 *     (a `-c` directly after a shell word such as `sh` is the shell's flag and is ignored); or `gh`, `api`, `graphql`
 *     and a token holding `addComment`, `updateIssueComment` or `addPullRequestReview`, or `gh`, `api` and an
 *     `issues/<n>/comments` or `issues/comments/<id>` write (`segmentWriteKind`). The substring match denies
 *     `addPullRequestReviewComment` and `addPullRequestReviewThread` on purpose. A `$'...'` (ANSI-C) word in a command
 *     that holds `gh` and also `issue|pr` with `comment|review|close|reopen`, or `api graphql`, is denied too (fail closed:
 *     the decoded flag is not judged); a `$'...'` word in any other `gh` command (a read) passes. The deny reason names the sanctioned
 *     writers (comment-issue.mjs and edit-comment.mjs) even when the decider also denies the command.
 *   - raw `gh issue create` — blocked only from a SUBAGENT context (agent_type present); the main agent/operator
 *     retains direct issue creation (#1051).
 *   - in a managed repo the whole command is denied when its tokens (any segment, any order; comma brace groups and
 *     `${VAR:-x}` forms split; a sequence group `{x..y}` stays outside the token model) hold `gh`, `pr`, `edit|create` and a body flag, or `gh`, `api` and a body
 *     field or `--input`, or `gh`, `api`, `graphql` and `updatePullRequest`, `updateIssue` or `body`
 *     (`segmentWriteKind`); fails closed. Accepted false positive: a command
 *     that holds those tokens as data (a title or note that says gh) is denied too.
 *   - raw `gh pr edit` body writes (`--body`/`--body-file`/`-b`/`-F`; `gh pr create` is covered by the token rule above only) and `gh api` body writes to
 *     `pulls/<n>` or `issues/<n>` (a `body` field via `-f`/`-F`/`--field`/`--raw-field`, an
 *     `--input` payload, or a `gh api graphql` `updatePullRequest`) — blocked actor-independently
 *     (`ADR-TRIPWIRE-STANDING-WAIVER`): the sanctioned launcher writers are the only route for these
 *     `gh pr` and `gh api` body writes, because they refuse a hand-written `adr-tripwire:allow` line.
 *     A process wrapper in front of the write cannot hide it: in a managed repo the whole-command token
 *     rule above also denies `gh`, `api` and a body field (`-f`/`-F`/`--field`/`--raw-field` `body=`) or
 *     `--input`, in any order and behind any wrapper (the same accepted false positive applies).
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
 *   - a shell write to a repository file (`OPS-EDITOR-TOOL-WRITES`, issue 2683): a redirect, `tee`, `sed -i`, `perl -i`, a `cp`/`mv`/`rm`
 *     target, or a `tmp/` script run, from a coordinator (`DEVLOOPS_COORDINATOR_READONLY=1`) or a developer or fixer (always on).
 *     `shellWriteTargets` reads the targets; the hook classifies each with `classifyRepoMutation`; `decideBashGate` applies the role table.
 *   - every command from the read-only `judge` subagent except its sanctioned work-order pull
 *     (`dev-loops-run scripts/github/pull-work-order.mjs <executionIdentity>`, ADR 0106, ADR 0115),
 *     its decision check (`check-judge-decision.mjs`) and its read-only search commands (ADR 0269).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { decideBashGate, FIXER_AGENT_TYPE, normalizeAgentType, parseSanctionedPullLine } from "./_hook-decisions.mjs";
import { withHookMarker } from "./_bash-gate-decisions.mjs";
import { listCheckouts, parseFixerPullCommand, recordFixerAgentBinding } from "./_fixer-grants.mjs";
import {
  commandContainsGhPrMerge,
  extractPrNumberFromGhPrReadyAnywhere,
  extractPrNumberFromGhPrMergeAnywhere,
  normalizeGitHubRepoSlug,
  shellWriteTargets,
  tokenizeShellCommand,
} from "./_bash-command-classify.mjs";
import { classifyRepoMutation } from "./_worktree-guard.mjs";

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

// Token deny: the whole command is a body write when its tokens, across all segments and pipes and
// in any order, hold `gh`, `pr`, `edit|create` and a body flag (`--body*`, or a short cluster with
// `b`/`F`: `-b`, `-bx`, `-b=x`, `-Fwaiver.md`, `-db`), or hold `gh`, `api` and a body field (`-f body=`,
// `-F body=`, `--field body=`, `--raw-field body=`) or `--input`, or `gh`, `api`, `graphql` and `updatePullRequest`/`updateIssue`/`body`. `$(`, `)`, backticks, braces and commas split tokens so a
// command substitution or comma brace group is seen (a sequence group `{x..y}` stays literal), a `${VAR:-gh}` default counts as a token, and `gh` matches by basename (`/usr/bin/gh`). No head, wrapper or echo exemption: fails closed.
// A process wrapper needs no parser: the rules read every token of the command.
// Comment writes use the same token model: `comment` with a body or editor flag, `pr review` with a body flag, `close|reopen` with a comment flag, and graphql comment or review mutations.
// `--{body,x}` expands to `--body`, `--x`: one innermost comma group per pass; a comma-less group nested in it stays literal.
// The product of the group sizes is exponential, so a word past BRACE_EXPANSION_CAP returns null and the caller fails closed.
const BRACE_EXPANSION_CAP = 64;
function braceExpansions(value) {
  let words = [value];
  for (;;) {
    let expanded = false;
    let total = 0;
    let over = false;
    words = words.flatMap((word) => {
      if (over) return [];
      // Linear scan for the first innermost `{...,...}` group; a regex here backtracks quadratically on an unclosed `{`.
      // A stack keeps the enclosing group when a comma-less group closes inside it (`--bo{dy,x{y}}`).
      const stack = [];
      let open = -1;
      let end = -1;
      for (let k = 0; k < word.length && end < 0; k++) {
        const c = word[k];
        if (c === "{") stack.push({ at: k, comma: false });
        else if (c === ",") { if (stack.length) stack[stack.length - 1].comma = true; }
        else if (c === "}") {
          const group = stack.pop();
          if (group?.comma) { open = group.at; end = k; }
        }
      }
      if (end < 0) { total++; return [word]; }
      expanded = true;
      // Count the alternatives before building them: the cap holds before allocation, not after the pass.
      let alts = 1;
      for (let k = word.indexOf(",", open); k >= 0 && k < end; k = word.indexOf(",", k + 1)) alts++;
      total += alts;
      if (total > BRACE_EXPANSION_CAP) { over = true; return []; }
      return word.slice(open + 1, end).split(",").map((alt) => word.slice(0, open) + alt + word.slice(end + 1));
    });
    if (over) return null;
    if (!expanded) return words;
  }
}

function segmentWriteKind(command) {
  let overCap = false;
  // Normalize the raw text once: delete quotes and backslash, turn substitution and shell punctuation into spaces
  // (braces and commas stay for the brace rules below), so `$(gh pr "edit" ...)` and `ed"it"` need no parser.
  // The tokenizer's decoded word values (ANSI-C `$'\x65dit'` becomes `edit`, also inside substitutions) join the set.
  // Backtick substitutions are not in `subs`: tokenize each terminated tick's text too (the text between the backticks, unescaped as bash does: \` \$ \\ lose the backslash; nested ticks recurse).
  const decodedWords = (segments) => segments.flatMap((s) => s.words.flatMap((w) => [w.value, ...decodedWords(w.subs.flatMap((x) => x.segments))]));
  // A decoded word that still holds `$'` is a nested shell string (`bash -c "gh pr reopen 5 $'\x2dc' x"`): the inner shell decodes it,
  // so tokenize its value again. Past the depth bound the command fails closed (overCap).
  const decodedOf = (text, depth = 0) => {
    const t = tokenizeShellCommand(text);
    const own = decodedWords(t.segments);
    // A value that tokenizes back to itself is raw substitution text (`$(tr $'\n' ' ')`): its inner words are already in `own`, so stop.
    if (depth > 0 && own.includes(text)) return own;
    // Returns one flat word list: own words, each tick's words and each nested string's words.
    return [...own, ...t.ticks.flatMap((k) => decodedOf(k.slice(1, -1).replace(/\\([`$\\])/g, "$1"), depth)),
      ...own.filter((v) => v.includes("$'")).flatMap((v) => depth >= 3 ? (overCap = true, []) : decodedOf(v, depth + 1))];
  };
  // A backslash-newline is a line continuation: bash joins the words (`-\<nl>c` is `-c`), so delete it before the whitespace split.
  const plainWords = command.replace(/\\\r?\n/g, "").replace(/['"\\]/g, "").replace(/[`$();|&<>\s]+/g, " ").split(" ").filter(Boolean);
  const decoded = decodedOf(command);
  const words = [...plainWords, ...decoded].filter(Boolean);
  const splitWord = (w) => w.split(/[\s=$(){},`]+/).filter(Boolean);
  const expand = (ws) => ws.flatMap((word) =>
    [...(braceExpansions(word) ?? (overCap = true, [])).flatMap((e) => [e, ...splitWord(e)]), ...splitWord(word)
      // `${G:-gh}` leaves `G:-gh`: also keep the default value. Needs a leading name, so `--body`/`-b` are untouched.
      .flatMap((t) => [t, t.replace(/^[A-Za-z_]\w*:?[-+]/, "")])]);
  const tokens = expand(words);
  // Tokens are lower-cased: on case-insensitive filesystems `GH` runs the real gh. Every pattern below is lower-case.
  const has = (test) => tokens.some((token) => test(token.toLowerCase()));
  // `-S`/`-iS` before `gh` covers `env -Sgh` / `env -iSgh`, where the split-string value joins the option cluster.
  if (overCap) return "body";
  if (!has((t) => /^(?:-[a-z]*s)?gh$/.test(t.split("/").pop()))) return null;
  const bodyFlag = () => has((t) => t.startsWith("--body") || /^-[^-]*[bf]/.test(t));
  const isBody = (has((t) => t === "pr") && has((t) => t === "edit" || t === "create") && bodyFlag()) ||
    (has((t) => t === "api") && (has((t) => t.startsWith("--input")) ||
      (has((t) => /^(?:-f|--(?:raw-)?field)$/.test(t)) && has((t) => t === "body")) || has((t) => /^-fbody$/.test(t)) ||
      (has((t) => t === "graphql") && has((t) => /update(?:pullrequest|issue)/.test(t) || t === "body"))));
  const issueOrPr = has((t) => t === "issue" || t === "pr");
  // `comment` opens an editor on `-e`/`--editor` (or edits on `--edit-last`), so GH_EDITOR can supply the body: these count as body flags.
  const editorFlag = () => has((t) => t.startsWith("--edit") || /^-[^-]*e/.test(t));
  // A `-c` that directly follows a shell word (`sh -c "..."`) is the shell's own flag. The shell word is bare or an absolute path;
  // a relative path such as the branch `feat/zsh` is an argument. The shell word must also come before the first `gh` token
  // (command position): after `gh`, a bare `zsh` is a branch argument (`gh pr reopen zsh -c x`). Consecutive duplicates from the token
  // expansion collapse first, so adjacency holds. A `-c` anywhere else, or inside a short cluster, counts.
  const isGh = (t) => /^(?:-[a-z]*s)?gh$/.test(t.split("/").pop());
  const seq = expand(plainWords).map((t) => t.toLowerCase()).filter((t, i, all) => t !== all[i - 1]);
  const ghAt = seq.findIndex(isGh);
  const isShell = (t) => /^(?:\/(?:[^/]+\/)*)?(?:sh|bash|zsh|dash|ksh)$/.test(t ?? "");
  const shellFlag = (i) => isShell(seq[i - 1]) && i - 1 < ghAt;
  const closeComment = seq.some((t, i) => t.startsWith("--comment") || (/^-[^-]*c/.test(t) && !(t === "-c" && shellFlag(i))));
  // Raw comment and review writes (`OPERATOR-OWNED-LINE`): the sanctioned writers refuse an operator-owned line, a raw write does not.
  // Comment clauses win over the body clause: a graphql addComment with `-f body=...` is a comment write, not a PR-body write.
  const isComment = (issueOrPr && has((t) => t === "comment") && (bodyFlag() || editorFlag())) ||
    (has((t) => t === "pr") && has((t) => t === "review") && bodyFlag()) ||
    (issueOrPr && has((t) => t === "close" || t === "reopen") && closeComment) ||
    (has((t) => t === "api") && has((t) => t === "graphql") && has((t) => /addcomment|updateissuecomment|addpullrequestreview/.test(t))) ||
    // REST issue comment writes (`issues/<n>/comments`, `issues/comments/<id>`); `pulls/<n>/comments` stays a body write.
    (isBody && has((t) => t === "api") && has((t) => /issues\/(?:\d+\/)?comments(?:\/|$)/.test(t)));
  // An ANSI-C `$'...'` word in a comment-shaped or body-write command that runs `gh` is denied: bash decodes it to flags and words
  // the token model cannot judge (`$'\x2dc'`, `-$'c'`), so this fails closed instead of decoding and exempting.
  // A body write that holds one keeps the body reason; every other command gets the comment reason.
  // The decoded word set counts too: `eval gh pr reopen 5 \$\'\\x2dc\' x` has no literal `$'` in the raw text, but the outer shell hands eval the word `$'\x2dc'`.
  // Ceiling (`OPERATOR-OWNED-LINE`): a flag built at run time is not judged. A command substitution (`gh pr reopen zsh "$(printf '\x2dc')" x`)
  // or an eval string that composes `$'` from variables (`D=\$; Q=\'; eval "gh pr reopen zsh $D$Q\x2dc$Q x"`) leaves no literal flag or `$'`
  // in the raw text or the decoded words. The guard stops an instruction-following agent.
  // Only a command whose tokens also hold a comment, review, close or reopen word (issue|pr) or `api graphql` is denied;
  // a read or a data mention (`gh pr view 5 --jq $'.title'`) falls through to the normal return.
  const commentShaped = (issueOrPr && has((t) => /^(?:comment|review|close|reopen)$/.test(t))) ||
    (has((t) => t === "api") && has((t) => t === "graphql"));
  if ([command, ...decoded].some((w) => w.includes("$'")) && (isBody || commentShaped)) return isBody && !isComment ? "body" : "comment";
  return isComment ? "comment" : isBody ? "body" : null;
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

const isMerge = typeof command === "string" && commandContainsGhPrMerge(command);
const writeKind = inManagedContext && typeof command === "string" ? segmentWriteKind(command) : null;

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
  const pr = typeof command !== "string" ? null : isMerge ? extractPrNumberFromGhPrMergeAnywhere(command) : extractPrNumberFromGhPrReadyAnywhere(command);
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
      // Exit 3 is TRUST_CONFIG_REFUSED_EXIT: its stderr JSON names the state and remedy, so surface it instead of a missing-verdict deny.
      if (typeof error?.status !== "number" || startupFailure || error.status === 3) {
        gateError = `could not run ${gateScript} via ${override || launcher} in consumer ${repoRoot}: ${stderr || error.message}`;
      }
    }
  }
}

// Boundary 3 (#2082): the coordinator verify-command delegation boundary, gated by the SAME flag
// as boundary 3 of pre-tool-use-write-guard.mjs (decideCoordinatorWriteGuard).
const enforceCoordinator = process.env.DEVLOOPS_COORDINATOR_READONLY === "1";

// OPS-EDITOR-TOOL-WRITES (issue 2683): resolve each shell write target against cwd and classify it with the Write guard's repo-mutation test.
// Only the guarded roles pay the git calls. An unresolvable target stays unclassified (the decider denies it fail closed).
const shellWrites = typeof command === "string" && /(?:^|:)(?:developer|fixer|dev-loop|gate-coordinator)$/.test(agentType ?? "")
  ? shellWriteTargets(command).map((target) => {
    if (target.op === "run" || target.unresolvable) return { ...target, repoMutation: true, existingFile: false };
    const abs = path.resolve(cwd, target.path);
    const { isRepoMutation } = classifyRepoMutation(abs);
    return { ...target, repoMutation: isRepoMutation, existingFile: isRepoMutation && fs.statSync(abs, { throwIfNoEntry: false })?.isFile() === true };
  })
  : [];

const bashGateFacts = {
  command,
  shellWrites,
  repoSlug,
  managedRepoSlug,
  inManagedContext,
  gatePassed,
  gateError,
  agentType,
  humanMergeOnly,
  enforceCoordinator,
};
const COMMENT_TEXT =
  "OPERATOR-OWNED-LINE: this command holds the tokens of a raw GitHub comment or review write (gh, issue or pr, comment and a body or editor flag; pr review and a body flag; close or reopen with a comment flag; or a gh api graphql addComment, updateIssueComment or addPullRequestReview mutation, or a REST issues comment write; a `$'...'` ANSI-C word in a command that holds one of the comment, review, close or reopen words is denied too, because the decoded flag is not judged), so it is blocked for every actor. " +
  "Post a new comment with `dev-loops-run scripts/github/comment-issue.mjs --repo <owner/repo> --issue <n> --body-file <f>` and edit one with `dev-loops-run scripts/github/edit-comment.mjs`. " +
  "To read comments, use `gh pr view <n> --json comments`.";
const COMMENT_REASON = withHookMarker("OPERATOR-OWNED-LINE", COMMENT_TEXT);
const decision = decideBashGate(bashGateFacts);
// The decider decides first. Only the decider's raw write denies (the body-write rule and the generic subagent external write deny) are replaced by the comment reason;
// a registered rule such as COPILOT-FOLLOWUP-REQUEST-HELPER-ONLY keeps its own remedy.
if (decision.decision === "deny") {
  // The decision object carries no rule ID, so the reason prefix identifies the rule.
  // The ADR-TRIPWIRE deny gets the recoverable comment text; the subagent ad-hoc write deny keeps its own stop marker.
  const reason = decision.reason ?? "";
  const replacement = reason.startsWith("ADR-TRIPWIRE-STANDING-WAIVER:") ? COMMENT_REASON
    : reason.startsWith("Ad-hoc GitHub issue/PR creation") ? withHookMarker("SUBAGENT_EXTERNAL_WRITE", COMMENT_TEXT) : null;
  emitDeny(writeKind === "comment" && replacement ? replacement : decision.reason);
}
if (writeKind === "comment") {
  emitDeny(COMMENT_REASON);
}
if (writeKind === "body") {
  emitDeny(withHookMarker("ADR-TRIPWIRE-STANDING-WAIVER",
    "ADR-TRIPWIRE-STANDING-WAIVER: this command holds the gh, pr, edit or create and body-flag tokens, or the gh, api and body-field (or --input) tokens, or the gh, api, graphql and updatePullRequest, updateIssue or body tokens, or a brace expansion too large to read, so it is blocked as a raw PR or issue body write. " +
    "To read a body, use `gh pr view <n> --json body`. " +
    "Write a PR body through the launcher: `dev-loops-run cli/index.mjs pr create` or `dev-loops-run cli/index.mjs pr edit` (it refuses a hand-written adr-tripwire:allow line). " +
    "Edit an issue body through `dev-loops-run cli/index.mjs issue edit`. " +
    "If the launcher command itself was denied because its title or body text holds the word gh, rephrase the title or move the text into the body file. " +
    "If a data word with many comma brace groups (a JSON or jq argument) tripped the size limit, write the data to a file and let a launcher command read it.",
  ));
}
emitAllow();
