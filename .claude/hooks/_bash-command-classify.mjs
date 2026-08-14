// GENERATED from packages/core/src/loop/bash-command-classify.mjs by scripts/claude/generate-claude-assets.mjs — do not edit; edit the source and regenerate.
/**
 * Pure classification of shell command strings for the dev-loop gate boundary.
 *
 * Shared by the Pi extension (`extension/post-merge-update.ts`, which re-exports these so its
 * behavior is unchanged) and the Claude Code PreToolUse Bash hook. Keeping one source of truth
 * means the `gh pr ready` / merge detection is identical across harnesses.
 *
 * Pure and side-effect free.
 */

/** The repository these gate guards apply to. */
export const TARGET_REPO_SLUG = "mfittko/dev-loops";

/** Flags known to take a value argument for `gh pr ready` (not boolean flags). */
export const FLAGS_THAT_TAKE_VALUE = new Set(["-r", "--repo"]);

/**
 * Shell command separators that terminate one segment and begin the next.
 * Newline (`\n`) and carriage return (`\r`) are full command terminators in bash
 * (equivalent to `;`), and the Claude Code Bash tool accepts multi-line command
 * strings — so a segment must break on them too, else `echo hi\ngh pr create` evades
 * the gate. Used by all segment-splitting sites (DRY).
 */
const SHELL_SEGMENT_SEPARATOR = /\s*(?:&&|\|\||;|\||\n|\r)\s*/;

/**
 * Strip a single balanced surrounding quote pair (`'…'` or `"…"`) from a shell arg value.
 * A repo flag value may reach us quoted (`--repo 'owner/name'`); the scope check compares against
 * the bare slug, so quotes must be normalized or a quoted on-target repo evades the guard (#1074).
 * ponytail: single balanced pair only — no full shell tokenization (mismatched/partial quotes stay).
 * @param {string|null} value @returns {string|null}
 */
function stripSurroundingQuotes(value) {
  if (value == null || value.length < 2) return value;
  const first = value[0];
  if ((first === "'" || first === '"') && value[value.length - 1] === first) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Read an inline `GH_REPO=<value>` env-assignment prefix on a single command segment.
 * `gh` resolves its target repo from the `GH_REPO` env var, and a segment may set it inline
 * (`GH_REPO=owner/name gh issue create …`) — same targeting intent as `--repo owner/name`, so the
 * scope check must treat it the same or an off-cwd redirect evades the guard (#1074). Only the
 * FIRST leading env assignment matching `GH_REPO=` is read (env assignments precede the executable);
 * the value is quote-normalized. Ambient `process.env.GH_REPO` is out of scope — this is a static
 * command-string classifier, so only the inline assignment in the string is considered.
 * @param {string} segment @returns {string|null}
 */
function extractGhRepoEnvAssignment(segment) {
  if (!segment) return null;
  for (const token of segment.trim().split(/\s+/)) {
    const assign = token.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!assign) break; // first non-assignment token ends the env-assignment prefix
    if (assign[1] === "GH_REPO") {
      return trimToNull(stripSurroundingQuotes(assign[2]));
    }
  }
  return null;
}

/** @param {string|null|undefined} value @returns {string|null} */
export function trimToNull(value) {
  const trimmed = `${value ?? ""}`.trim();
  return trimmed ? trimmed : null;
}

/**
 * Normalize a git remote URL into an `owner/name` slug (lowercased), or null.
 * @param {string} remoteUrl
 * @returns {string|null}
 */
export function normalizeGitHubRepoSlug(remoteUrl) {
  const normalized = trimToNull(remoteUrl);
  if (!normalized) {
    return null;
  }

  const patterns = [
    /^git@github\.com:([^\s]+?)(?:\.git)?$/i,
    /^https?:\/\/github\.com\/([^\s]+?)(?:\.git)?$/i,
    /^ssh:\/\/git@github\.com\/([^\s]+?)(?:\.git)?$/i,
    /^git:\/\/github\.com\/([^\s]+?)(?:\.git)?$/i,
    /^git:github\.com\/([^\s]+?)(?:\.git)?$/i,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (!match) {
      continue;
    }
    return trimToNull(match[1])?.toLowerCase() ?? null;
  }

  return null;
}

function segmentIsGhPrMerge(segment) {
  if (!/^gh\s+pr\s+merge(?:\s|$)/i.test(segment)) {
    return false;
  }
  const remainder = segment.replace(/^gh\s+pr\s+merge(?:\s|$)/i, "").trim();
  if (!remainder) {
    return true;
  }
  const firstArg = remainder.match(/^(\S+)/)?.[1]?.toLowerCase() ?? "";
  return !["--help", "-h"].includes(firstArg);
}

function isGitMergeCompletionCommand(segment) {
  if (!/^git\s+merge(?:\s|$)/i.test(segment)) {
    return false;
  }
  const remainder = segment.replace(/^git\s+merge(?:\s|$)/i, "").trim();
  if (!remainder) {
    return true;
  }
  const firstArg = remainder.match(/^(\S+)/)?.[1]?.toLowerCase() ?? "";
  return !["--abort", "--continue", "--quit", "--help", "-h"].includes(firstArg);
}

/** @param {string} command @returns {boolean} */
export function isMergeCapableCommand(command) {
  const normalized = command.trim();
  if (!normalized) {
    return false;
  }
  return normalized
    .split(SHELL_SEGMENT_SEPARATOR)
    .some((segment) => segmentIsGhPrMerge(segment) || isGitMergeCompletionCommand(segment));
}

/** @param {string} command @returns {string} */
export function firstShellSegment(command) {
  return command.trim().split(SHELL_SEGMENT_SEPARATOR)[0]?.trim() ?? "";
}

/** Split a compound shell command into its individual segments. */
function shellSegments(command) {
  return command.trim().split(SHELL_SEGMENT_SEPARATOR).map((s) => s.trim()).filter(Boolean);
}

/**
 * Leading prefix a command segment may carry before its real executable: a run of `NAME=value`
 * env assignments, optional `command`/`env`/`exec` wrapper words, and an absolute/relative path on
 * the binary (`/usr/bin/gh`, `/usr/bin/git`). Shared by every classifier in this file that must
 * catch its verb behind these forms (`gh pr <verb>`, `git stash`, ...).
 *
 * Note: this is a pragmatic normalizer, not a full shell tokenizer. Subshell
 * `(gh pr create)`, `{ …; }` group, `-R=value` short-flag, and backslash-escaped
 * `\gh` forms are deliberately out of scope.
 */
const SHELL_EXEC_PREFIX = "(?:[A-Za-z_][A-Za-z0-9_]*=\\S*\\s+)*(?:(?:command|env|exec)\\s+)*(?:\\S*/)?";

/**
 * Build the `gh <subcmd> <verb>` prefix matcher (subcmd = "pr" | "issue").
 * Tolerates a leading env-assignment/wrapper/path prefix so `GH_TOKEN=x gh pr create`,
 * `command gh issue create`, and `/usr/bin/gh pr create` are all matched. The same regex
 * is reused to strip the matched prefix (`segment.replace(re, "")`), so remainder
 * extraction stays consistent across all matcher/extractor call sites. The `gh` prefix
 * requirement means node-wrapper commands (`node scripts/github/comment-issue.mjs …`) never
 * match — their first token is `node`, not `gh`.
 */
function ghSubcmdVerbRegex(subcmd, verb) {
  return new RegExp(`^${SHELL_EXEC_PREFIX}gh\\s+${subcmd}\\s+${verb}(?:\\s|$)`, "i");
}

/**
 * A run of git global options that may appear between `git` and the subcommand: `-C <path>`,
 * `-c <name>=<value>` (each consumes the following token as its value), `--git-dir=<path>`,
 * `--work-tree=<path>`, or any other bare flag (`-x`, `--long-option`) that takes no value.
 * Pragmatic normalizer, not a full git CLI parser.
 */
const GIT_GLOBAL_OPTION_RUN =
  "(?:(?:-C|-c)\\s+\\S+\\s+|--(?:git-dir|work-tree)=\\S+\\s+|--?[A-Za-z][\\w-]*\\s+)*";

/**
 * Whether `command` contains a `git stash` invocation (any subcommand: bare, `push`, `pop`,
 * `apply`, `save`, `list`, ...) in ANY shell segment — including behind the same env-assignment /
 * `command`/`env`/`exec` wrapper / binary-path prefix (`GIT_DIR=.git git stash`, `command git
 * stash`, `/usr/bin/git stash`) and git global options between `git` and `stash` (`git -C /tmp
 * stash`, `git -c name=value stash pop`) that the sibling `gh` classifiers in this file already
 * tolerate. Anchored per-segment, so `git stashed`, `git commit -m "git stash"`, or a path literal
 * containing "git stash" never match. `refs/stash` is a single ref shared by every worktree over
 * this repo's one `.git` directory, so a stash from one worktree can pop into another's — the
 * PreToolUse gate blocks it outright on the target repo (see
 * `skills/docs/worktree-guidance.md#never-git-stash-in-a-shared-git-layout`).
 * @param {string} command @returns {boolean}
 */
export function commandContainsGitStash(command) {
  const re = new RegExp(`^${SHELL_EXEC_PREFIX}git\\s+${GIT_GLOBAL_OPTION_RUN}stash(?:\\s|$)`, "i");
  return command
    .split(SHELL_SEGMENT_SEPARATOR)
    .some((segment) => re.test(segment.trim()));
}

/** Build the `gh pr <verb>` prefix matcher — delegates to the generic subcmd matcher (DRY). */
function ghPrVerbRegex(verb) {
  return ghSubcmdVerbRegex("pr", verb);
}

/**
 * Return the first segment in the command that is a `gh <subcmd> <verb>` call (ignoring
 * --help/-h), or null. Scans ALL segments so compound commands are caught.
 */
function findGhSubcmdVerbSegment(command, subcmd, verb) {
  const re = ghSubcmdVerbRegex(subcmd, verb);
  for (const segment of shellSegments(command)) {
    if (!re.test(segment)) continue;
    const remainder = segment.replace(re, "").trim();
    if (!remainder) return segment;
    const args = remainder.split(/\s+/).map((a) => a.toLowerCase());
    if (!args.includes("--help") && !args.includes("-h")) return segment;
  }
  return null;
}

/**
 * Extract the `--repo`/`-R` flag value from an already-isolated `gh <subcmd> <verb>` segment.
 * @param {string} segment @param {string} subcmd @param {string} verb @returns {string|null}
 */
function extractRepoFlagFromSubcmdSegment(segment, subcmd, verb) {
  const re = ghSubcmdVerbRegex(subcmd, verb);
  if (!segment || !re.test(segment)) return null;
  const remainder = segment.replace(re, "").trim();
  if (!remainder) return null;
  const tokens = remainder.split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const lower = token.toLowerCase();
    if (lower === "-r" || lower === "--repo") {
      if (i + 1 < tokens.length && !tokens[i + 1].startsWith("-")) return stripSurroundingQuotes(tokens[i + 1]);
    }
    const repoEqMatch = token.match(/^(?:--repo|-R)=(.+)$/i);
    if (repoEqMatch) return stripSurroundingQuotes(repoEqMatch[1]);
  }
  // No explicit --repo/-R flag: fall back to an inline GH_REPO= env assignment (flag wins,
  // mirroring gh's own precedence). This closes the GH_REPO repo-targeting bypass (#1074).
  return extractGhRepoEnvAssignment(segment);
}

/**
 * Return one `{ segment, explicitRepo }` entry for EVERY `gh <subcmd> <verb>` segment (ignoring
 * --help/-h). Mirrors `extractRepoFlagsFromGhPrCreateSegments`.
 * @param {string} command @param {string} subcmd @param {string} verb
 * @returns {{ segment: string, explicitRepo: string|null }[]}
 */
function extractRepoFlagsFromGhSubcmdVerbSegments(command, subcmd, verb) {
  const re = ghSubcmdVerbRegex(subcmd, verb);
  const out = [];
  for (const segment of shellSegments(command)) {
    if (!re.test(segment)) continue;
    const remainder = segment.replace(re, "").trim();
    if (remainder) {
      const args = remainder.split(/\s+/).map((a) => a.toLowerCase());
      if (args.includes("--help") || args.includes("-h")) continue;
    }
    out.push({ segment, explicitRepo: extractRepoFlagFromSubcmdSegment(segment, subcmd, verb) });
  }
  return out;
}

/**
 * The raw external-write verb forms that must be blocked when originating from a subagent:
 * ad-hoc GitHub issue/PR creation, comments, and edits run directly via `gh` (not the sanctioned
 * node wrappers). Each entry is `[subcmd, verb]`.
 */
const EXTERNAL_WRITE_VERB_FORMS = Object.freeze([
  ["issue", "create"],
  ["issue", "comment"],
  ["issue", "edit"],
  ["pr", "comment"],
]);

/**
 * Whether `command` contains a raw `gh issue create`, `gh issue comment`, `gh issue edit`, or
 * `gh pr comment` invocation in ANY shell segment (ignoring --help/-h). PreToolUse gate use only — the gate
 * blocks these when they originate from a subagent context. Node-wrapper commands
 * (`node scripts/github/comment-issue.mjs …`) never match (first token is `node`, not `gh`).
 * @param {string} command @returns {boolean}
 */
export function commandContainsRawExternalWrite(command) {
  return EXTERNAL_WRITE_VERB_FORMS.some(([subcmd, verb]) => findGhSubcmdVerbSegment(command, subcmd, verb) !== null);
}

/**
 * Return `{ segment, explicitRepo }` for every raw external-write segment across all four verb
 * forms (`gh issue create` / `gh issue comment` / `gh issue edit` / `gh pr comment`). PreToolUse gate use only —
 * lets the gate decide in-scope-ness per segment so a leading out-of-scope write can't shield a
 * later in-scope one. `explicitRepo` is the segment's `--repo`/`-R` value or null.
 * @param {string} command @returns {{ segment: string, explicitRepo: string|null }[]}
 */
export function extractRepoFlagsFromExternalWriteSegments(command) {
  return EXTERNAL_WRITE_VERB_FORMS.flatMap(([subcmd, verb]) =>
    extractRepoFlagsFromGhSubcmdVerbSegments(command, subcmd, verb),
  );
}

/**
 * Return the first segment in the command that is a `gh pr <verb>` call (ignoring --help/-h),
 * or null. Scans ALL segments so compound commands (`echo ok && gh pr merge 1`) are caught.
 */
function findGhPrVerbSegment(command, verb) {
  return findGhSubcmdVerbSegment(command, "pr", verb);
}

/**
 * Generic `gh pr <verb>` detector — checks the FIRST shell segment only.
 *
 * Used by the Pi extension's post-execute handler (`onUserBash`) to record that `gh pr ready`
 * actually ran. First-segment-only is correct for that use: `false && gh pr ready 42` short-
 * circuits so ready never executes, and the extension should not record a spurious invocation.
 *
 * For the Claude Code PreToolUse gate (block before execution), use
 * `commandContainsGhPrReady`/`commandContainsGhPrMerge` instead — those scan ALL segments.
 */
function isGhPrVerbCommand(command, verb) {
  const re = ghPrVerbRegex(verb);
  const segment = firstShellSegment(command);
  if (!segment || !re.test(segment)) return false;
  const remainder = segment.replace(re, "").trim();
  if (!remainder) return true;
  const args = remainder.split(/\s+/).map((a) => a.toLowerCase());
  return !args.includes("--help") && !args.includes("-h");
}

/** Extract PR number from a single already-isolated segment (shared by both first- and all-segment paths). */
function extractPrNumberFromSegment(segment, verb) {
  const re = ghPrVerbRegex(verb);
  if (!segment || !re.test(segment)) return null;
  const remainder = segment.replace(re, "").trim();
  if (!remainder) {
    return null;
  }
  const tokens = remainder.split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.startsWith("-")) {
      const flagName = token.replace(/=.*$/, "").toLowerCase();
      if (!token.includes("=") && FLAGS_THAT_TAKE_VALUE.has(flagName)) {
        i++;
      }
      continue;
    }
    if (/^\d+$/.test(token)) {
      const num = Number(token);
      if (num > 0) {
        return num;
      }
    }
    return null;
  }
  return null;
}

/** Extract repo flag from a single already-isolated segment. */
function extractRepoFlagFromSegment(segment, verb) {
  const re = ghPrVerbRegex(verb);
  if (!segment || !re.test(segment)) return null;
  const remainder = segment.replace(re, "").trim();
  if (!remainder) {
    return null;
  }
  const tokens = remainder.split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const lower = token.toLowerCase();
    if (lower === "-r" || lower === "--repo") {
      if (i + 1 < tokens.length && !tokens[i + 1].startsWith("-")) {
        return stripSurroundingQuotes(tokens[i + 1]);
      }
    }
    const repoEqMatch = token.match(/^(?:--repo|-R)=(.+)$/i);
    if (repoEqMatch) {
      return stripSurroundingQuotes(repoEqMatch[1]);
    }
  }
  // No explicit --repo/-R flag: fall back to an inline GH_REPO= env assignment (flag wins,
  // mirroring gh's own precedence). Applied here too so gh pr ready/merge/create scope checks get
  // consistent GH_REPO handling — the root-cause fix, not just the external-write path (#1074).
  return extractGhRepoEnvAssignment(segment);
}

/** First-segment extractor for `gh pr <verb>` PR number — Pi extension public API. */
function extractPrNumberFromGhPrVerb(command, verb) {
  return extractPrNumberFromSegment(firstShellSegment(command), verb);
}

/** First-segment extractor for `gh pr <verb>` --repo flag — Pi extension public API. */
function extractRepoFlagFromGhPrVerb(command, verb) {
  return extractRepoFlagFromSegment(firstShellSegment(command), verb);
}

/** @param {string} command @returns {boolean} */
export function isGhPrReadyCommand(command) {
  return isGhPrVerbCommand(command, "ready");
}

/** @param {string} command @returns {number|null} */
export function extractPrNumberFromGhPrReady(command) {
  return extractPrNumberFromGhPrVerb(command, "ready");
}

/** @param {string} command @returns {string|null} */
export function extractRepoFlagFromGhPrReady(command) {
  return extractRepoFlagFromGhPrVerb(command, "ready");
}

/**
 * Whether `command` contains a `gh pr merge` invocation in the FIRST shell segment,
 * ignoring `--help`/`-h`. Used by the Pi extension's post-execute handler.
 * For the Claude Code PreToolUse gate, use `commandContainsGhPrMerge` instead.
 * @param {string} command @returns {boolean}
 */
export function isGhPrMergeCommand(command) {
  return isGhPrVerbCommand(command, "merge");
}

/**
 * Whether `command` contains a `gh pr ready` invocation in ANY shell segment.
 * For use in the Claude Code PreToolUse gate only — blocks the whole command pre-emptively
 * regardless of shell short-circuit semantics (`false && gh pr ready 42` is still blocked).
 * @param {string} command @returns {boolean}
 */
export function commandContainsGhPrReady(command) {
  return findGhPrVerbSegment(command, "ready") !== null;
}

/**
 * Whether `command` contains a `gh pr merge` invocation in ANY shell segment.
 * For use in the Claude Code PreToolUse gate only — blocks the whole command pre-emptively.
 * @param {string} command @returns {boolean}
 */
export function commandContainsGhPrMerge(command) {
  return findGhPrVerbSegment(command, "merge") !== null;
}

/** Extract PR number from `gh pr ready` in any shell segment — PreToolUse gate use only. */
export function extractPrNumberFromGhPrReadyAnywhere(command) {
  return extractPrNumberFromSegment(findGhPrVerbSegment(command, "ready"), "ready");
}

/** @param {string} command @returns {string|null} */
export function extractRepoFlagFromGhPrReadyAnywhere(command) {
  return extractRepoFlagFromSegment(findGhPrVerbSegment(command, "ready"), "ready");
}

/** Extract PR number from `gh pr merge` in any shell segment — PreToolUse gate use only. */
export function extractPrNumberFromGhPrMergeAnywhere(command) {
  return extractPrNumberFromSegment(findGhPrVerbSegment(command, "merge"), "merge");
}

/** @param {string} command @returns {string|null} */
export function extractRepoFlagFromGhPrMergeAnywhere(command) {
  return extractRepoFlagFromSegment(findGhPrVerbSegment(command, "merge"), "merge");
}

/**
 * Whether `command` contains a raw `gh pr create` invocation in ANY shell segment.
 * PreToolUse gate use only — blocks raw `gh pr create` so PR creation flows through the
 * canonical wrapper (`scripts/github/create-pr.mjs` / `dev-loops pr create`), which always
 * creates a draft and self-assigns. The wrapper runs `gh pr create` inside a node child
 * process, so its Bash command string (`node …/create-pr.mjs …`) never matches this — only a
 * literal `gh pr create` in the agent's shell command does.
 * @param {string} command @returns {boolean}
 */
export function commandContainsGhPrCreate(command) {
  return findGhPrVerbSegment(command, "create") !== null;
}

/** Extract repo flag from `gh pr create` in any shell segment — PreToolUse gate use only. */
export function extractRepoFlagFromGhPrCreateAnywhere(command) {
  return extractRepoFlagFromSegment(findGhPrVerbSegment(command, "create"), "create");
}

/**
 * Return one `{ segment, explicitRepo }` entry for EVERY `gh pr create` segment (ignoring
 * --help/-h), not just the first. PreToolUse gate use only: the create-scope decision must
 * consider every create segment, so a leading out-of-scope create can't shield a later
 * in-scope raw create (`gh pr create --repo other/repo && gh pr create --fill`).
 * `explicitRepo` is the segment's `--repo`/`-R` value or null when none is present.
 * @param {string} command @returns {{ segment: string, explicitRepo: string|null }[]}
 */
export function extractRepoFlagsFromGhPrCreateSegments(command) {
  return extractRepoFlagsFromGhSubcmdVerbSegments(command, "pr", "create");
}

/** @param {string} command @returns {number|null} */
export function extractPrNumberFromGhPrMerge(command) {
  return extractPrNumberFromGhPrVerb(command, "merge");
}

/** @param {string} command @returns {string|null} */
export function extractRepoFlagFromGhPrMerge(command) {
  return extractRepoFlagFromGhPrVerb(command, "merge");
}

// ---------------------------------------------------------------------------
// gh api URL-path matchers + the six guard-rule classifiers (#1622).
// These make the six rules that describe operations the Bash gate could refuse
// enforceable at one seam (decideBashGate in hook-decisions.mjs), where raw
// `gh api` shapes were previously unclassified (anything expressed as a raw API
// call was invisible to the gate).
// ---------------------------------------------------------------------------

/** gh api value-taking flags (short forms). Each consumes the following token. Lowercase (compared
 * against token.toLowerCase()) — the `-H` header flag is real but case-folded here like the rest. */
const GH_API_VALUE_FLAGS = new Set(["-x", "-m", "-f", "-h"]);
/** gh api value-taking flags (long forms). Each consumes the following token. */
const GH_API_VALUE_LONG_FLAGS = new Set(["--method", "--field", "--raw-field", "--header"]);

function ghApiRegex() {
  return new RegExp(`^${SHELL_EXEC_PREFIX}gh\\s+api(?:\\s|$)`, "i");
}

/**
 * Return one `{ segment, endpoint }` entry for EVERY `gh api <endpoint>` call (ignoring --help/-h).
 * `endpoint` is the first positional (non-flag) token after `gh api`, skipping value-taking flags and
 * their values (`gh api -X POST repos/...`, `gh api --method POST repos/...`). Env-assignment /
 * `command`/`env`/`exec` wrapper / binary-path prefixes are tolerated via the shared SHELL_EXEC_PREFIX
 * (`GH_TOKEN=x gh api ...`, `/usr/bin/gh api ...`). Node-wrapper commands (`node scripts/...`) never
 * match — first token is `node`, not `gh`. The endpoint may be a full URL, a `repos/OWNER/REPO/...`
 * path (gh api prefixes a bare path with `https://api.github.com/`), or `graphql`.
 * @param {string} command @returns {{ segment: string, endpoint: string|null }[]}
 */
export function extractGhApiEndpointSegments(command) {
  const re = ghApiRegex();
  const out = [];
  for (const segment of shellSegments(command)) {
    if (!re.test(segment)) continue;
    const remainder = segment.replace(re, "").replace(/(?:--help|-h)\s*$/i, "").trim();
    if (!remainder) continue;
    const tokens = remainder.split(/\s+/);
    let endpoint = null;
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (!token.startsWith("-")) {
        endpoint = token;
        break;
      }
      const lower = token.toLowerCase();
      if (GH_API_VALUE_FLAGS.has(lower) || GH_API_VALUE_LONG_FLAGS.has(lower)) {
        i += 1; // consume the flag's value token
        // A value that opens with a quote may span whitespace (e.g. `-H "Accept: application/vnd.github+json"`)
        // — keep consuming tokens until the matching closing quote so the quoted value is skipped whole
        // and a later positional endpoint is not mis-read as the value's remainder.
        if (i < tokens.length && (tokens[i][0] === '"' || tokens[i][0] === "'")) {
          const quote = tokens[i][0];
          while (i < tokens.length && !tokens[i].endsWith(quote)) i += 1;
        }
      }
    }
    out.push({ segment, endpoint });
  }
  return out;
}

/** The `gh api` segments whose endpoint is the target repo's URL path (embedded repo slug). */
function targetGhApiPathRegex(suffix) {
  const slug = TARGET_REPO_SLUG.replace("/", "\\/");
  return new RegExp(`repos/${slug}/${suffix}`);
}

/** Whether any `gh api` segment targets the `graphql` endpoint. */
function ghApiGraphqlSegments(command) {
  return extractGhApiEndpointSegments(command).filter(({ endpoint }) => endpoint && /^graphql$/i.test(endpoint));
}

/** Whether a `gh api` segment names an explicit write method (POST/PUT/PATCH/DELETE). gh api
 * defaults to GET, so the ad-hoc-write predicates require an explicit write method to refuse. */
const GH_API_WRITE_METHOD_RE = /(?:-X|-m|--method)(?:\s+|\s*=)?(?:"|')?\s*(?:POST|PUT|PATCH|DELETE)\b/i;
function ghApiSegmentHasWriteMethod(segment) {
  return GH_API_WRITE_METHOD_RE.test(segment);
}

/**
 * SUBISSUE-NO-ADHOC-BYPASS: raw `gh api` WRITE to `.../issues/<n>/sub_issues[/priority]` on the target
 * repo — the ad-hoc sub-issue mutation that must flow through the sanctioned `manage-sub-issues`
 * wrapper instead. Actor-independent (the issue's decided policy): the main agent gets no reserved
 * direct path to sub-issue writes. Anchored on the target repo's URL path segment AND an explicit write
 * method, so a `gh api` read or another repo's `sub_issues` write passes through (no false deny).
 * @param {string} command @returns {boolean}
 */
export function commandContainsSubIssueAdHocBypass(command) {
  const re = targetGhApiPathRegex(`issues/\\d+/sub_issues(?:/priority)?(?:\\s|$)`);
  return extractGhApiEndpointSegments(command).some(
    ({ segment, endpoint }) => Boolean(endpoint) && re.test(endpoint) && ghApiSegmentHasWriteMethod(segment),
  );
}

/**
 * COPILOT-FOLLOWUP-REPLY-RESOLVE-HELPER (REST half): raw `gh api` POST to
 * `.../pulls/<n>/comments/<m>/replies` on the target repo — the ad-hoc thread reply that must flow
 * through `reply-resolve-review-thread(s).mjs`. Actor-independent: no reserved direct reply path.
 * @param {string} command @returns {boolean}
 */
export function commandContainsReplyResolveBypass(command) {
  const re = targetGhApiPathRegex(`pulls/\\d+/comments/\\d+/replies(?:\\s|$)`);
  return extractGhApiEndpointSegments(command).some(
    ({ segment, endpoint }) => Boolean(endpoint) && re.test(endpoint) && ghApiSegmentHasWriteMethod(segment),
  );
}

/**
 * COPILOT-FOLLOWUP-REPLY-RESOLVE-HELPER (GraphQL half): a raw `gh api graphql` that carries a
 * `resolveReviewThread` mutation — the ad-hoc GraphQL thread-resolution bypass, which must also flow
 * through `reply-resolve-review-thread(s).mjs`. `graphql` has no path-host repo (gh api graphql
 * resolves against the cwd repo), so the surrounding decideBashGate scopes it to the target repo.
 * @param {string} command @returns {boolean}
 */
export function commandContainsGraphqlResolveReviewThread(command) {
  return ghApiGraphqlSegments(command).some(({ segment }) => /resolveReviewThread/.test(segment));
}

/**
 * COPILOT-FOLLOWUP-REQUEST-HELPER-ONLY (REST half): raw `gh api` write to
 * `.../pulls/<n>/requested_reviewers` on the target repo — the ad-hoc Copilot review request that must
 * flow through `scripts/github/request-copilot-review.mjs`. Actor-independent.
 * @param {string} command @returns {boolean}
 */
export function commandContainsCopilotRequestBypass(command) {
  const re = targetGhApiPathRegex(`pulls/\\d+/requested_reviewers(?:\\s|$)`);
  return extractGhApiEndpointSegments(command).some(
    ({ segment, endpoint }) => Boolean(endpoint) && re.test(endpoint) && ghApiSegmentHasWriteMethod(segment),
  );
}

/**
 * COPILOT-FOLLOWUP-REQUEST-HELPER-ONLY (comment-summon half): a raw `gh pr comment` body carrying a
 * bare Copilot summon (`/copilot` or `/copilot re-review`). The agent MUST request Copilot via
 * `request-copilot-review.mjs`, never by posting a literal `/copilot` comment. Actor-independent: even
 * the main agent (which may otherwise post `gh pr comment`) must not summon Copilot by comment.
 * @param {string} command @returns {boolean}
 */
export function commandContainsCopilotSummonComment(command) {
  if (!findGhSubcmdVerbSegment(command, "pr", "comment")) return false;
  // A bare summon is `/copilot` or `/copilot re-review` on its own (optionally quoted) — never a
  // prose mention like `see /copilot for more` / `see /copilot docs`. Match only when the summon
  // runs to the end of the (quoted) body or is the explicit `re-review` form.
  return /\/copilot(?:\s+re-review\b)?\s*(?:["']|$)/i.test(command);
}

/**
 * COPILOT-FOLLOWUP-WAIT-TOOLS: a banned detached/polling wait — `nohup`, `disown`, `tmux new-session`,
 * `screen -dm`, or a `while`/`until`/`seq` loop whose body contains both a `sleep` and a gh or
 * loop-state call. Behavioral rule (required-rules classification `agent`): scoped in decideBashGate to the
 * dev-loop driving agent (subagent-only) so the main agent/operator retains manual wait tooling.
 * @param {string} command @returns {boolean}
 */
export function commandContainsDetachedWaitTool(command) {
  const whole = command.trim();
  // while/until/seq polling loop with both a sleep and a gh or loop-state call. The loop body is
  // `;`-delimited, so this is checked against the whole command (a per-segment split would
  // separate the `while` head from the `sleep`/`gh` body calls and miss the pattern).
  // A polling loop is detected wherever the `while`/`until`/`seq` head appears (a leading expression
  // like `gh pr view 1 && while ...` must not silence the deny) as long as the body carries both a
  // `sleep` and a gh/loop-state call.
  if (/\b(?:while|until|seq)\b/i.test(whole) && /\bsleep\b/.test(whole) && /\b(?:gh|loop-state)\b/.test(whole)) {
    return true;
  }
  return shellSegments(command).some((segment) => {
    // `nohup`/`disown` only detach when they head a command (segment start, or right after a shell
    // operator) — a bare mention (`cat nohup.out`, `echo "nohup banned"`) is not a detach.
    if (/(?:^|[;&|])\s*(?:nohup|disown)\b/.test(segment)) return true;
    if (/^tmux\s+new-session\b/i.test(segment)) return true;
    if (/^screen\s+-dm/i.test(segment)) return true;
    return false;
  });
}

/** Build a `node`/`python`/`python3` command-head matcher (env/wrapper/path prefix tolerated). */
function interpreterRegex(bin) {
  return new RegExp(`^${SHELL_EXEC_PREFIX}${bin}(?:\\s|$)`, "i");
}

/**
 * OPS-NO-INLINE-INTERPRETER: an inline interpreter — `node -e`/`--eval`/`-p`, `python3 -c`, or a
 * heredoc fed to node/python (`node - <<EOF`, `python3 - <<EOF`). Ported from the long-orphaned
 * inline-interpreter classifier in the retrospective-tooling check (zero production callers). Sanctioned
 * output parsing uses `--jq`/`--silent`, never an inline interpreter. Actor-independent: the rule bars
 * "Coordinator and agent flows" (both actors). Script-path invocations (running a `.mjs` file,
 * `python3 script.py`) never match.
 * @param {string} command @returns {boolean}
 */
export function commandContainsInlineInterpreter(command) {
  return shellSegments(command).some((segment) => {
    const s = segment.trim();
    // Heredoc fed straight to an interpreter (`node - <<EOF`, `python3 - <<EOF`).
    if (/(?:^|\s)(?:node|python3?)\s+-\s*<</i.test(s)) return true;
    if (interpreterRegex("node").test(s)) {
      const tokens = s.replace(interpreterRegex("node"), "").trim().split(/\s+/).filter(Boolean);
      for (const t of tokens) {
        if (t === "-e" || t === "--eval" || t.startsWith("--eval=") || t === "-p") return true;
        if (!t.startsWith("-")) break; // script path reached — a later `-e` is a script argument
      }
    }
    if (interpreterRegex("python3?").test(s)) {
      const tokens = s.replace(interpreterRegex("python3?"), "").trim().split(/\s+/).filter(Boolean);
      for (const t of tokens) {
        if (t === "-c") return true;
        if (!t.startsWith("-")) break; // script path reached — a later `-c` is a script argument
      }
    }
    return false;
  });
}
