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

/**
 * Whether `command` contains a `git stash` invocation (any subcommand: bare, `push`, `pop`,
 * `apply`, `save`, `list`, ...) in ANY shell segment. `refs/stash` is a single ref shared by every
 * worktree over this repo's one `.git` directory, so a stash from one worktree can pop into
 * another's — the PreToolUse gate blocks it outright on the target repo (see
 * `docs/worktree-guidance.md#never-git-stash-in-a-shared-git-layout`).
 * @param {string} command @returns {boolean}
 */
export function commandContainsGitStash(command) {
  return command
    .split(SHELL_SEGMENT_SEPARATOR)
    .some((segment) => /^git\s+stash(?:\s|$)/i.test(segment.trim()));
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
 * Leading prefix a `gh pr <verb>` segment may carry before the `gh` executable:
 * a run of `NAME=value` env assignments, optional `command`/`env`/`exec` wrapper
 * words, and an absolute/relative path on the gh binary (`/usr/bin/gh`).
 *
 * Note: this is a pragmatic normalizer, not a full shell tokenizer. Subshell
 * `(gh pr create)`, `{ …; }` group, `-R=value` short-flag, and backslash-escaped
 * `\gh` forms are deliberately out of scope.
 */
const GH_PR_VERB_PREFIX = "(?:[A-Za-z_][A-Za-z0-9_]*=\\S*\\s+)*(?:(?:command|env|exec)\\s+)*(?:\\S*/)?";

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
  return new RegExp(`^${GH_PR_VERB_PREFIX}gh\\s+${subcmd}\\s+${verb}(?:\\s|$)`, "i");
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
