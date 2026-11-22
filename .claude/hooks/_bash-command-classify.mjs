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
import { parseShell, shellOperators, walkShell } from "./_shell-ast.mjs";

/**
 * The dev-loops repo itself. Retained ONLY for the Pi extension's
 * (`extension/post-merge-update.ts`) dev-loops-repo SELF-UPDATE scoping (`markPendingUpdate` /
 * `queueIfEligible`), which is legitimately anchored to this one repo, not to whatever repo the
 * harness happens to run in. Both harness guard suites — the Claude PreToolUse Bash gate
 * (`decideBashGate` in `hook-decisions.mjs`) and the Pi extension's `gh pr ready`/`gh pr merge`
 * guards (`post-merge-update.ts`) — now resolve the managed repo dynamically via
 * `deriveInManagedRepo` below instead of comparing against this hardcoded slug, so every guard
 * also applies in a dev-loops-managed consumer repo.
 */
export const TARGET_REPO_SLUG = "mfittko/dev-loops";

/** `.devloops` config file extensions checked (in order) to decide whether a repo root is
 * dev-loops-managed. Shared by every harness that resolves `inManagedContext` from the
 * filesystem (`fs.existsSync(path.join(repoRoot, \`.devloops${ext}\`))`). */
export const DEVLOOPS_CONFIG_VARIANTS = ["", ".yaml", ".yml", ".json"];

/**
 * Whether the current repo counts as "managed" for guard-gating purposes: inside a
 * dev-loops-managed context (a `.devloops` config exists at its root) AND, when the managed
 * repo's identity resolves, the cwd repo IS that managed repo. FAIL CLOSED: inside a managed
 * context whose identity can't be resolved (`managedRepoSlug` null), the guard suite still
 * applies rather than silently allowing everything.
 * @param {Object} [params]
 * @param {boolean} [params.inManagedContext] - Whether a `.devloops` config exists at the repo root.
 * @param {string|null} [params.managedRepoSlug] - Resolved owner/name of the managed repo, or null.
 * @param {string|null} [params.repoSlug] - Resolved owner/name of the cwd repo, or null.
 * @returns {boolean}
 */
export function deriveInManagedRepo({ inManagedContext = false, managedRepoSlug = null, repoSlug = null } = {}) {
  const managedSlug = (managedRepoSlug ?? "").trim().toLowerCase() || null;
  const cwdSlug = (repoSlug ?? "").trim().toLowerCase() || null;
  return Boolean(inManagedContext) && (managedSlug === null || cwdSlug === managedSlug);
}

/**
 * Whether an explicit `--repo`/`-R` (or `GH_REPO=`) target is PROVABLY a different repo than the
 * managed one — both slugs must resolve and differ. An unresolvable managed slug never proves
 * foreign-ness (fail closed: the guard stays active rather than waving an explicit flag through).
 * @param {string|null} explicitRepo
 * @param {string|null} managedRepoSlug
 * @returns {boolean}
 */
export function explicitRepoProvenForeign(explicitRepo, managedRepoSlug) {
  const managedSlug = (managedRepoSlug ?? "").trim().toLowerCase() || null;
  const explicit = (explicitRepo ?? "").trim().toLowerCase() || null;
  if (managedSlug === null || explicit === null) {
    return false;
  }
  // Both sides must be clean owner/name identities before we can prove foreign: a
  // managed slug that bypassed the normalizer (e.g. a hostile `acme/widgets;id` test
  // double) can't be trusted to prove anything about the explicit `--repo` — fail
  // closed (the managed-repo guard still applies) rather than wave it through.
  if (!isCleanRepoSlug(managedSlug) || !isCleanRepoSlug(explicit)) {
    return false;
  }
  return explicit !== managedSlug;
}

/** Flags known to take a value argument for `gh pr ready` (not boolean flags). */
export const FLAGS_THAT_TAKE_VALUE = new Set(["-r", "--repo"]);

/**
 * Shell command separators that terminate one segment and begin the next.
 * Newline (`\n`) and carriage return (`\r`) are full command terminators in bash
 * (equivalent to `;`), and the Claude Code Bash tool accepts multi-line command
 * strings — so a segment must break on them too, else `echo hi\ngh pr create` evades
 * the gate. Used by all segment-splitting sites (DRY).
 * A `&` that belongs to a redirection (`2>&1`, `>&2`, `&>f`) is not a separator. This changes
 * segmentation for every gate that uses this regex (merge, stash, detached-wait, PR-number and
 * repo-flag extraction, and the Pi extension via extension/post-merge-update.ts). It is needed so
 * a redirection before a heredoc (`python3 -I 2>&1 <<EOF`) still reaches the interpreter scan.
 */
const SHELL_SEGMENT_SEPARATOR = /\s*(?:&&|\|\||;|\||(?<!(?<!\\)[<>])&(?!>)|\n|\r)\s*/;

/**
 * Strip a single balanced surrounding quote pair (`'…'` or `"…"`) from a shell arg value.
 * A repo flag value may reach us quoted (`--repo 'owner/name'`); the scope check compares against
 * the bare slug, so quotes must be normalized or a quoted on-target repo evades the guard.
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
 * scope check must treat it the same or an off-cwd redirect evades the guard. Only the
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
 * Strict GitHub owner/name identity shape: each of the two path segments is
 * `[A-Za-z0-9._-]+` — the character set GitHub itself allows in an owner or repo name. A slug
 * outside this shape (a shell metacharacter, whitespace, path traversal, or an extra `/` segment)
 * can never be a real GitHub identity.
 */
const CLEAN_REPO_SLUG_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/**
 * Whether `slug` is a clean `owner/name` GitHub identity (see `CLEAN_REPO_SLUG_RE`). Exported so a
 * sink that interpolates a repo slug into a shell command string (e.g. the Pi extension's
 * `gateCommand` in `extension/post-merge-update.ts`) can defense-in-depth guard the interpolation,
 * on top of `normalizeGitHubRepoSlug` already enforcing this shape at the source.
 * @param {string|null|undefined} slug @returns {boolean}
 */
export function isCleanRepoSlug(slug) {
  return typeof slug === "string" && CLEAN_REPO_SLUG_RE.test(slug);
}

/**
 * Normalize a git remote URL into an `owner/name` slug (lowercased), or null.
 * A hostile remote (e.g. `git@github.com:acme/widgets;id`) never yields a slug carrying the
 * injected metacharacters — the extracted candidate must match `CLEAN_REPO_SLUG_RE` or this
 * returns null instead, so every caller (both harnesses' managed-repo scope checks, and any sink
 * that interpolates the slug into a shell command) sees either a real GitHub identity or null,
 * never shell-metacharacter-bearing text.
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
    const slug = trimToNull(match[1])?.toLowerCase() ?? null;
    return isCleanRepoSlug(slug) ? slug : null;
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

/** A run of leading `NAME=value` env assignments. */
const ENV_ASSIGNMENT_RUN = "(?:[A-Za-z_][A-Za-z0-9_]*=\\S*\\s+)*";

/**
 * The `env` wrapper word plus any trailing run (any order/count) of `NAME=value` assignments and the
 * common `env` options: `-i`/`--ignore-environment`, `-u <NAME>`/`--unset=<NAME>`, `-C <dir>`/
 * `--chdir=<dir>`, `-S <str>`/`--split-string=<str>`, `--` and a bare `-`. A short option also
 * takes its argument attached (`-C/w`, `-uX`), and a long option also takes it after a space
 * (`--chdir /w`), as GNU `env` accepts. Shared by
 * `SHELL_EXEC_PREFIX` and `VERIFY_EXEC_PREFIX` so both see the same `env` forms.
 * Ceilings: an `-S` string is one token and is not split into words; any other `env` option is
 * not covered. The `-C <dir>` target is not resolved, so the caller's repo scoping applies
 * (fails closed for a managed context).
 */
const ENV_WRAPPER =
  "env(?:\\s+(?:[A-Za-z_][A-Za-z0-9_]*=\\S*|-i|--ignore-environment|-u\\s*\\S+|--unset(?:=|\\s+)\\S+|-C\\s*\\S+|--chdir(?:=|\\s+)\\S+|-S\\s*\\S+|--split-string(?:=|\\s+)\\S+|--|-))*\\s+";

/**
 * Leading prefix a command segment may carry before its real executable: a run of `NAME=value`
 * env assignments, zero or more `ENV_WRAPPER` (`env` plus its options/assignments) or
 * `command`/`exec` wrapper words, and an absolute/relative path on the binary (`/usr/bin/gh`,
 * `/usr/bin/git`). Shared by every classifier in this file that must catch its verb behind these
 * forms (`gh pr <verb>`, `git stash`, `env -C /w node -e ...`, ...). See `ENV_WRAPPER` for the
 * `env` option ceilings.
 *
 * Note: this is a pragmatic normalizer, not a full shell tokenizer. Subshell
 * `(gh pr create)`, `{ …; }` group, `-R=value` short-flag, and backslash-escaped
 * `\gh` forms are deliberately out of scope.
 */
const SHELL_EXEC_PREFIX = `${ENV_ASSIGNMENT_RUN}(?:${ENV_WRAPPER}|(?:command|exec)\\s+)*(?:\\S*/)?`;

/**
 * Leading prefix a code-verification/build command may carry before its real executable: the
 * shared `SHELL_EXEC_PREFIX` (env assignments, `ENV_WRAPPER`, `command`/`exec` wrapper words, binary path)
 * plus `nice`/`timeout` process wrappers, scoped to this classifier only so the sibling `gh`/`git`
 * classifiers above are not broadened by wrapper forms they never need to tolerate. Covers bare
 * `nice`, `nice -n <N>`, bare `timeout <duration>`, and `timeout` carrying `-s <sig>`/`-k <dur>`/
 * `--signal=<sig>`/`--kill-after=<dur>`/`--preserve-status`/`--foreground` before the duration —
 * the wrapper forms the coordinator's daily verify/build commands are routinely run behind
 * (`timeout 600 bun run verify`, `nice -n 10 bun run verify`). Not a full flag parser: other
 * `timeout`/`nice` flags are a known, deliberately uncovered ceiling.
 *
 * The `env` forms come from the shared `ENV_WRAPPER` (`env CI=1 bun run verify`,
 * `env -u DEVLOOPS_COORDINATOR_READONLY bun run verify`, `env -u FOO CI=1 npm test`).
 * `command`/`exec` do not get the trailing-assignment/option tolerance — no known daily
 * invocation shape needs it, and adding it would only widen the pattern without a use case.
 */
const VERIFY_EXEC_PREFIX =
  `${ENV_ASSIGNMENT_RUN}(?:${ENV_WRAPPER}|(?:command|exec)\\s+|nice(?:\\s+-n\\s+\\S+)?\\s+|timeout(?:\\s+(?:-s\\s+\\S+|-k\\s+\\S+|--signal=\\S+|--kill-after=\\S+|--preserve-status|--foreground))*\\s+\\S+\\s+)*(?:\\S*/)?`;

/** Reuse the existing wrapper boundary for pure validation classification. */
export function verificationCommandSegments(command) {
  const prefix = new RegExp(`^${VERIFY_EXEC_PREFIX}`, "i");
  return shellSegments(command).map((segment) => segment.replace(prefix, ""));
}

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
 * Whether `command` contains a `git stash` invocation (any subcommand: bare,
 * `push`, `pop`, `apply`, `save`, `list`, ...) in ANY shell segment —
 * including behind an env-assignment/wrapper/path prefix and git global
 * options between `git` and `stash` (mirrors the `gh` classifiers' tolerance
 * in this file). Anchored per-segment, so `git stashed` or a path literal
 * containing "git stash" never match. `refs/stash` is shared by every
 * worktree over this repo's one `.git` directory, so a stash from one
 * worktree can pop into another's — the PreToolUse gate blocks it outright
 * (see `skills/docs/worktree-guidance.md#never-git-stash-in-a-shared-git-layout`).
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

/** A help request puts -h/--help first after the verb; gh reads a later -h as a flag value. */
function isHelpRemainder(remainder) {
  return ["--help", "-h"].includes(remainder.split(/\s+/)[0]);
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
    if (!isHelpRemainder(remainder)) return segment;
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
  // mirroring gh's own precedence). This closes the GH_REPO repo-targeting bypass.
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
    if (isHelpRemainder(remainder)) continue;
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
  return !isHelpRemainder(remainder);
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
  // consistent GH_REPO handling — the root-cause fix, not just the external-write path.
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

/**
 * Return `{ segment, explicitRepo }` for every `gh pr merge` segment (ignoring --help/-h) —
 * PreToolUse gate scope check use only, so a proven-foreign leading segment can't shield a later
 * managed one. Mirrors `extractRepoFlagsFromGhPrCreateSegments`.
 * @param {string} command @returns {{ segment: string, explicitRepo: string|null }[]}
 */
export function extractRepoFlagsFromGhPrMergeSegments(command) {
  return extractRepoFlagsFromGhSubcmdVerbSegments(command, "pr", "merge");
}

/**
 * Return `{ segment, explicitRepo }` for every `gh pr ready` segment (ignoring --help/-h) —
 * PreToolUse gate scope check use only. Mirrors `extractRepoFlagsFromGhPrCreateSegments`.
 * @param {string} command @returns {{ segment: string, explicitRepo: string|null }[]}
 */
export function extractRepoFlagsFromGhPrReadySegments(command) {
  return extractRepoFlagsFromGhSubcmdVerbSegments(command, "pr", "ready");
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
// gh api URL-path matchers + the six guard-rule classifiers.
// These make the six rules that describe operations the Bash gate could refuse
// enforceable at one seam (decideBashGate in hook-decisions.mjs), where raw
// `gh api` shapes were previously unclassified (anything expressed as a raw API
// call was invisible to the gate).
// ---------------------------------------------------------------------------

/** gh api value-taking flags (short forms); each consumes the following token. Lowercase-compared,
 * covering every value-taking short flag gh api accepts so a flag placed BEFORE the endpoint skips
 * its value and the real endpoint is still read: -X/--method, -m/--method, -f/--field, -F/--raw-field
 * (both case-fold to -f), -q/--jq, -p/--preview, -t/--template, -r/--repo. `-h` (help) is EXCLUDED —
 * it takes no value, and folding it with `-H` (header) would let a mid-command `-h` swallow the real
 * endpoint and bypass the write-path deny. `-H` stays an exact-token value-taking flag
 * despite the case-fold. */
const GH_API_VALUE_FLAGS = new Set(["-x", "-m", "-f", "-r", "-q", "-p", "-t"]);
/** gh api value-taking flags (long forms). Each consumes the following token. */
const GH_API_VALUE_LONG_FLAGS = new Set([
  "--method", "--field", "--raw-field", "--header", "--repo", "--jq", "--preview",
  "--template", "--hostname", "--input", "--cache", "--cache-ttl", "--unix-socket",
]);

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
      // `-h`/`--help` is a boolean help flag (consumes no value); mid-command it must not swallow
      // the endpoint and silently bypass the write-path deny. `-H` is the case-sensitive header
      // value flag and stays value-taking here even though `-h` is excluded from the folded set.
      if (token === "-h" || token === "--help") continue;
      const lower = token.toLowerCase();
      if (token === "-H" || GH_API_VALUE_FLAGS.has(lower) || GH_API_VALUE_LONG_FLAGS.has(lower)) {
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
    // A quoted endpoint (`gh api "repos/..."`) carries its surrounding quotes through the tokenizer;
    // strip them so the write-path/anchor regexes see the bare path.
    if (endpoint && endpoint.length >= 2 && (endpoint[0] === '"' || endpoint[0] === "'")) {
      const q = endpoint[0];
      if (endpoint.endsWith(q)) endpoint = endpoint.slice(1, -1);
    }
    out.push({ segment, endpoint });
  }
  return out;
}

/** The `gh api` segments whose endpoint is the dev-loops-managed repo's URL path. Matches the
 * absolute slug-embedded form (`repos/<managedSlug>/...`) when `managedSlug` resolves, plus the
 * bare relative form (`issues/...`), which gh api resolves against the cwd repo — the
 * decideBashGate call site gates the relative form on `inManagedRepo`. When `managedSlug` is null
 * (the managed repo's identity could not be resolved in a managed context — AC4's fail-closed
 * case), the absolute arm matches ANY owner/repo rather than a specific slug: identity is unknown,
 * so an absolute write must be denied regardless of which repo it targets, not waved through for
 * lack of a slug to compare against. The absolute arm fully regex-escapes a resolved slug (a `.`
 * in a legitimate repo name must match literally, not as a wildcard) and matches
 * case-insensitively (GitHub repo identity is case-insensitive). */
function managedGhApiPathRegex(suffix, managedSlug) {
  if (!managedSlug) {
    return new RegExp(`(?:repos/[^/]+/[^/]+/|^)${suffix}`, "i");
  }
  const slug = managedSlug.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  return new RegExp(`(?:repos/${slug}/|^)${suffix}`, "i");
}

/** Strip a `scheme://host` prefix from an absolute gh api URL endpoint (`https://api.github.com/...`),
 * yielding the bare `/repos/<slug>/…` path that the write-path anchors match. gh api accepts both a
 * bare `repos/<slug>/…`/`issues/…` path and an absolute https:// URL, so both must reach the same
 * anchors or an absolute-URL write bypasses the deny. */
function normalizeGhApiEndpoint(endpoint) {
  if (!endpoint) return endpoint;
  return endpoint.replace(/^https?:\/\/[^/]+/, "").replace(/^\//, "").replace(/\/+$/, "");
}

/** Whether any `gh api` segment targets the `graphql` endpoint. */
function ghApiGraphqlSegments(command) {
  return extractGhApiEndpointSegments(command).filter(({ endpoint }) => endpoint && /^graphql$/i.test(endpoint));
}

/** Whether a `gh api` segment names an explicit write method (POST/PUT/PATCH/DELETE). gh api
 * defaults to GET, so the ad-hoc-write predicates require an explicit write method to refuse. */
function ghApiSegmentHasWriteMethod(segment) {
  const re = ghApiRegex();
  if (!re.test(segment)) return false;
  const tokens = segment.replace(re, "").trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    // Only a method FLAG (`--method`, `-X`/`-m`, or an inline `=POST`) declares an explicit write
    // method. A method-looking token inside a FIELD VALUE (`-F 'body=--method DELETE'`) is data, not
    // the method flag, so the read gets no write-method deny (token-scoped, not segment-scoped).
    const m = tokens[i].match(/^(?:--method|-X|-m)(?:=([A-Za-z]+)|([A-Za-z]+))?$/i);
    if (!m) continue;
    const inline = m[1] ?? m[2];
    const value = (inline ?? tokens[i + 1] ?? "").replace(/^["']|["']$/g, "");
    if (/^(?:POST|PUT|PATCH|DELETE)\b/i.test(value)) return true;
  }
  return false;
}

/**
 * SUBISSUE-NO-ADHOC-BYPASS: raw `gh api` WRITE to `.../issues/<n>/sub_issues[/priority]` on the
 * dev-loops-managed repo — the ad-hoc sub-issue mutation that must flow through the sanctioned
 * `manage-sub-issues` wrapper instead. Actor-independent (the issue's decided policy): the main
 * agent gets no reserved direct path to sub-issue writes. Anchored on the managed repo's URL path
 * segment AND an explicit write method, so a `gh api` read or another repo's `sub_issues` write
 * passes through (no false deny).
 * @param {string} command @param {string|null} [managedSlug] - Resolved managed-repo slug, or
 *   null when unresolvable (both the relative and any absolute repos/<owner>/<repo>/ form match then, fail closed).
 * @returns {boolean}
 */
export function commandContainsSubIssueAdHocBypass(command, managedSlug = null) {
  const re = managedGhApiPathRegex(`issues/\\d+/sub_issues(?:/priority)?(?:\\s|$)`, managedSlug);
  return extractGhApiEndpointSegments(command).some(
    ({ segment, endpoint }) => Boolean(endpoint) && re.test(normalizeGhApiEndpoint(endpoint)) && ghApiSegmentHasWriteMethod(segment),
  );
}

/**
 * COPILOT-FOLLOWUP-REPLY-RESOLVE-HELPER (REST half): raw `gh api` POST to
 * `.../pulls/<n>/comments/<m>/replies` on the dev-loops-managed repo — the ad-hoc thread reply
 * that must flow through `reply-resolve-review-thread(s).mjs`. Actor-independent: no reserved
 * direct reply path.
 * @param {string} command @param {string|null} [managedSlug] - Resolved managed-repo slug, or
 *   null when unresolvable (both the relative and any absolute repos/<owner>/<repo>/ form match then, fail closed).
 * @returns {boolean}
 */
export function commandContainsReplyResolveBypass(command, managedSlug = null) {
  const re = managedGhApiPathRegex(`pulls/\\d+/comments/\\d+/replies(?:\\s|$)`, managedSlug);
  return extractGhApiEndpointSegments(command).some(
    ({ segment, endpoint }) => Boolean(endpoint) && re.test(normalizeGhApiEndpoint(endpoint)) && ghApiSegmentHasWriteMethod(segment),
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
 * `.../pulls/<n>/requested_reviewers` on the dev-loops-managed repo — the ad-hoc Copilot review
 * request that must flow through `scripts/github/request-copilot-review.mjs`. Actor-independent.
 * @param {string} command @param {string|null} [managedSlug] - Resolved managed-repo slug, or
 *   null when unresolvable (both the relative and any absolute repos/<owner>/<repo>/ form match then, fail closed).
 * @returns {boolean}
 */
export function commandContainsCopilotRequestBypass(command, managedSlug = null) {
  const re = managedGhApiPathRegex(`pulls/\\d+/requested_reviewers(?:\\s|$)`, managedSlug);
  return extractGhApiEndpointSegments(command).some(
    ({ segment, endpoint }) => Boolean(endpoint) && re.test(normalizeGhApiEndpoint(endpoint)) && ghApiSegmentHasWriteMethod(segment),
  );
}

/** `gh` global repo flags that may sit between `gh` and the subcommand: `-R <slug>`, `-R<slug>`,
 * `--repo <slug>`, `--repo=<slug>`. */
const GH_GLOBAL_REPO_FLAGS = "(?:(?:(?:-R|--repo)(?:=|\\s+)|-R)\\S+\\s+)*";

/** `gh [global repo flags] <subcmd> <verb>` prefix matcher; the same regex strips the prefix. */
function ghBodyWriterRegex(subcmd) {
  return new RegExp(`^${SHELL_EXEC_PREFIX}gh\\s+${GH_GLOBAL_REPO_FLAGS}${subcmd}\\s+edit(?:\\s|$)`, "i");
}

/** A `gh pr edit` literal anywhere in a command string, quoted or not. */
const GH_BODY_WRITER_LITERAL = new RegExp(`\\bgh\\s+${GH_GLOBAL_REPO_FLAGS}pr\\s+edit(?=[\\s"'\`]|$)`, "i");

/** A shell wrapper that hides a command from per-segment inspection: `bash|sh|zsh|dash|ksh -c`, `eval`, `xargs`. */
const SHELL_WRAPPER_RE = /(?:^|[\s;&|(])(?:(?:\S*\/)?(?:ba|z|da|k)?sh\s+(?:-\S+\s+)*-\S*c|eval|xargs)(?=\s)/;

/**
 * Shell-word unquoting for flag tokens: the shell strips the quotes, so `'--body'`, `"-F"` and
 * `-f "body"=x` reach gh as `--body`, `-F` and `-f body=x`. Only a quoted token that is a bare
 * flag name (or the `body` field name before `=`) is unquoted; quoted values stay quoted.
 * @param {string} segment @returns {string}
 */
function unquoteFlagTokens(segment) {
  return segment.replace(/(['"])(-{1,2}[A-Za-z][\w-]*(?:=(?:(?!\1).)*)?)\1/g, "$2").replace(/(['"])body\1(?==)/g, "body");
}

/**
 * ADR-TRIPWIRE-STANDING-WAIVER (CLI half): a raw `gh pr edit` that sets the body
 * (`--body`, `--body-file`, `-b`, `-F`), with or without `gh` global repo flags before the subcommand
 * (`gh -R o/n pr edit ...`). A body write is the path that carries an `adr-tripwire:allow` waiver
 * line, so it must flow through the launcher's `pr edit` / `pr waive-adr-tripwire`. Quoted values are
 * blanked first, so a flag-looking word inside a title does not match. A `gh pr edit`
 * literal inside `bash -c`/`sh -c`/`eval`/`xargs` is denied outright: the wrapper hides the real
 * flags from segment inspection, so the literal itself is the signal (fail closed). An explicit
 * `--repo`/`-R` that is provably not `managedSlug` passes through (direct, unwrapped forms only).
 * @param {string} command @param {string|null} [managedSlug] @returns {boolean}
 */
export function commandContainsRawPrBodyEdit(command, managedSlug = null) {
  if (SHELL_WRAPPER_RE.test(command) && GH_BODY_WRITER_LITERAL.test(command)) return true;
  const res = [ghBodyWriterRegex("pr")];
  return shellSegments(command).map(unquoteFlagTokens).some((segment) =>
    res.some((re) => {
      if (!re.test(segment)) return false;
      // An explicit --repo/-R that is provably another repo is out of scope (fail closed otherwise).
      const repoFlag = hasQuotePairingHazard(segment) ? null : /(?:^|\s)(?:--repo|-R)(?:=|\s+)(\S+)/.exec(stripQuotedLiterals(segment));
      if (repoFlag && explicitRepoProvenForeign(repoFlag[1], managedSlug)) return false;
      const flags = blankQuotedForFlags(segment.replace(re, " "));
      return /(?:^|\s)(?:--body(?:-file)?(?=[=\s]|$)|-[bF](?=[=\s]|\S|$))/.test(flags);
    }));
}

/**
 * ADR-TRIPWIRE-STANDING-WAIVER (API half): a raw `gh api` write to `.../pulls/<n>` or
 * `.../issues/<n>` on the managed repo that carries a `body` field (`-f`/`-F`/`--field`/
 * `--raw-field body=...`) or an `--input` payload, or a `gh api graphql` call carrying an
 * `updatePullRequest` mutation. The endpoint may be a bare path, an absolute URL, carry a query
 * string (`pulls/5?x=1`), or use gh's `{owner}/{repo}` placeholders. A write to a sub-path
 * (`pulls/<n>/comments`, `issues/<n>/comments`) or without a body field passes through.
 * @param {string} command @param {string|null} [managedSlug] @returns {boolean}
 */
export function commandContainsRawPrBodyApiWrite(command, managedSlug = null) {
  // A `gh api` literal inside `bash -c`/`eval`/`xargs` hides its flags from segment inspection: mirror the
  // CLI half and deny the literal when it names a pull/issue path with a body field or `--input`, or `updatePullRequest`.
  if (SHELL_WRAPPER_RE.test(command) && /\bgh\s+api\b/.test(command)
    && (/updatePullRequest/.test(command) || (/(?:pulls|issues)\/(?:\d+|\{\})/.test(command) && /body=|--input/.test(command)))) return true;
  const owner = managedSlug ? `(?:${managedSlug.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}|\\{owner\\}/\\{repo\\})` : "[^/]+/[^/]+";
  const re = new RegExp(`^(?:repos/${owner}/)?(?:pulls|issues)/\\d+$`, "i");
  return extractGhApiEndpointSegments(command).map((e) => ({ ...e, segment: unquoteFlagTokens(e.segment) })).some(({ segment, endpoint }) => {
    if (endpoint && /^graphql$/i.test(endpoint)) return /updatePullRequest/.test(segment);
    if (!endpoint || !re.test(normalizeGhApiEndpoint(endpoint).replace(/\?.*$/, ""))) return false;
    // `--input` supplies the whole payload, so it is a write without a method flag (gh then POSTs).
    if (/(?:^|\s)--input(?:=|\s)/.test(blankQuotedForFlags(segment))) return true;
    // gh defaults to POST when a field is present, so only an explicit GET/HEAD makes a body field a read.
    if (!hasQuotePairingHazard(segment) && /(?:^|\s)(?:--method|-X|-m)(?:=|\s*)["']?(?:GET|HEAD)\b/i.test(stripQuotedLiterals(segment))) return false;
    // Not quote-stripped: the field is usually quoted (`-f "body=..."`), so blanking would hide it.
    return /(?:^|\s)(?:-[fF]|--(?:raw-)?field)(?:=|\s*)["']?body=/.test(segment);
  });
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
  // A summon is `/copilot`/`/copilot re-review` anchored at the START of the quoted body — a
  // trailing prose mention (`--body "see /copilot"`) or in-prose `/copilot re-review` never
  // matches. The `re-review` form allows trailing modifiers (`/copilot re-review now`) so
  // appending a word cannot defeat the deny. Only `gh pr comment` segments reach here.
  return /(["'])\s*\/copilot(?:\s+re-review\b(?:\s+[^\s"']+)*|\s*(?:["']|$))/i.test(command);
}

/**
 * Flag-lookup view of COMMAND: `stripQuotedLiterals`, except that on a quote-pairing hazard (where it returns the raw text)
 * every quote character becomes a space, so retained quotes cannot defeat a flag lookahead (`--body""` stays `--body`).
 * @param {string} command @returns {string}
 */
function blankQuotedForFlags(command) {
  return hasQuotePairingHazard(command) ? command.replace(/['"]/g, " ") : stripQuotedLiterals(command);
}

/**
 * Blank the CONTENTS of quoted string literals ('...' and "...") to a space (a command with a quote-pairing hazard is returned unchanged), EXCEPT a quote that is
 * the payload of an executable-code flag — a short-flag cluster CONTAINING `c` ANYWHERE in the
 * cluster (`sh -c '…'`, `bash -c '…'`, `bash -lc '…'`, `bash -ec '…'`, `bash -cl '…'`, `bash -ci '…'`,
 * `bash -cx '…'`) — bash treats ANY `-c`-containing short-flag cluster as command-execution
 * regardless of where `c` sits in the cluster, not only one that ENDS in `c` — optionally followed by
 * a `--` terminator (`bash -c -- '…'`), a long `--command` flag, or `eval` — that payload is REAL
 * shell syntax to be executed, not inert data, so blanking it would hide an actual poll-loop
 * construct wrapped in one of these forms. A real poll loop's structural tokens
 * (`while`/`until`/`for`/`do`/`sleep`/`done`, a `[ -f … ]` file test) are UNQUOTED shell syntax; a
 * quoted issue body, `--body` payload, or quoted example that merely mentions them carries them
 * INSIDE quotes as inert data. Blanking those quoted contents is what lets the poll-loop matchers key
 * on an actual loop CONSTRUCT rather than the token sequence appearing anywhere in a command
 * (`gh issue create --body "while … sleep … done"` must not be flagged). Default mode matches spans with a
 * dotAll pattern, so a MULTI-LINE quoted `--body` (a real issue body commonly spans lines) is stripped in full.
 * A quoted string that itself contains a command substitution (`$(...)`) or a backtick (`` `...` ``)
 * is executable code, not inert data — its inner command runs regardless of the surrounding quotes.
 * Blanking it would hide a real poll loop such as `while [ "$(gh pr view 5)" != MERGED ]; do sleep 5;
 * done` that the gh/loop-state ban already denies, so such a quoted literal is PRESERVED (fail-closed
 * direction) ahead of the `-c`/`--command`/`eval` exemption check below.
 *
 * Default mode only: the `-c`-cluster/`--command`/`eval` exemption is intentionally coarse in the fail-closed direction:
 * it looks only for a `c` anywhere in a preceding short-flag cluster (or `--command`/`eval`), not for
 * a shell-interpreter anchor. A non-shell command carrying `-c` (e.g. `grep -ci '<loop text>'`,
 * `wc -c`) may therefore have its quoted argument preserved too and get over-denied — an accepted
 * benign false positive, because tightening the exemption to a shell-interpreter anchor would risk a
 * fail-open (missing a real `sh -c` poll loop), the worse direction.
 *
 * Two modes. The default (PR-body predicates) is strictly fail-closed against the frozen differential oracle: when
 * `hasQuotePairingHazard(command)` is true it returns the command unchanged, because a caller that would read the unblanked
 * text as more permissive (a foreign `--repo`, an explicit `-X GET`) must not. `precise` (wait and poll predicates) trusts the
 * tokenizer instead of that coarse guard, which removes the hazard false positives. It also blanks the bodies that
 * `blankDataHeredocs` finds to be data, treats a single-quoted or ANSI-C `$(`/backtick as inert, and keeps every
 * quoted span inside a payload word (`isPayloadWord`, see `payloadFrom`). Text from an
 * unterminated quote, `$(` or heredoc onward is left as raw executable text in both modes (deny direction). Accepted ceiling, default mode
 * only: a deliberately quoted structural keyword (e.g. `"sleep"`) placed inside a real UNQUOTED loop is blanked like any other quoted
 * literal and can evade the ban.
 * `waitView` (the detached-wait operator view) also keeps a quoted span visible unless every segment around it passes `inertQuoteSegment`. The poll predicates use the default mode, as on origin/main.
 * @param {string} command @param {boolean} [precise] @param {boolean} [waitView] @returns {string}
 */
function stripQuotedLiterals(command, precise = false, waitView = false) {
  const tok = tokenizeShellCommand(command);
  if (!precise && hasQuotePairingHazard(command)) return command;
  const text = precise ? blankDataHeredocs(command, tok) : command;
  const all = precise ? allWords(tok.segments) : [];
  const payloads = all.filter(({ words, k }) => isPayloadWord(words, k)).map(({ w }) => w);
  const limit = tok.incompleteAt < 0 ? text.length : tok.incompleteAt;
  let out = "";
  let pos = 0;
  for (const { start, end, kind } of [...tok.spans].sort((a, b) => a.start - b.start)) {
    if (start < pos || start >= limit) continue; // nested in a span already handled, or in the unterminated tail (kept as a guard: a backtick span can start past the opener without a quote)
    const body = text.slice(start + 1, end - 1);
    const subst = /\$\(|`/.test(body);
    const kept = precise
      ? (subst && kind === "double") || (waitView && all.some(({ w, seg }) => w.start <= start && end <= w.end && !inertQuoteSegment(tok, seg))) || payloads.some((w) => w.start <= start && end <= w.end)
      : subst || // executable code in quotes: preserve (fail-closed)
        /(?:^|\s)(?:-[A-Za-z]*c[A-Za-z]*(?:\s+--)?|--command|eval)\s*$/.test(text.slice(0, start)); // -c/eval payload: real shell syntax
    out += text.slice(pos, start) + (kept ? text.slice(start, end) : " ");
    pos = end;
  }
  return out + text.slice(pos);
}

/** @returns {{w: object, words: object[], k: number, seg: object}[]} every word in SEGMENTS with its segment's words and index, nested substitutions included. */
function allWords(segments, out = []) {
  for (const seg of segments) seg.words.forEach((w, k) => { out.push({ w, words: seg.words, k, seg }); for (const sub of w.subs) allWords(sub.segments, out); });
  return out;
}
const EXEC_FLAG_RE = /^(?:-[a-z]*c[a-z]*|--command)$/i;
const ENV_ASSIGNMENT_WORD_RE = /^[A-Za-z_]\w*=/;
/** Programs that only read their text (`-c` counts or selects bytes, a here-string is stdin data, an operand is a file name). */
const TEXT_CONSUMER_RE = /^(?:echo|printf|grep|rg|wc|cat|tee|head|tail|cut|sort|uniq|tr|od|jq|read)$/;
/** Basename of the program that receives a segment's input and arguments: the first word after env assignments and `env`/`command`/`exec` launchers with their flags. ponytail: `env -u NAME sh` reads NAME as the head. */
function receiverOf(words) {
  const w = words.filter((x) => !x.op && !ENV_ASSIGNMENT_WORD_RE.test(x.raw));
  let i = 0;
  while (/^(?:env|command|exec)$/.test(w[i]?.value.split("/").pop() ?? "")) for (i++; w[i]?.value.startsWith("-"); i++);
  return w[i]?.value.split("/").pop() ?? "";
}
/** Index of the first payload word of a segment: every word after `eval` or a `-c`-containing short-flag cluster (origin/main's coarse rule) is executable text. Also every argument of `watch`/`trap`, and the value of `git -x`/`--exec`. A TEXT_CONSUMER_RE head has no payload (`-c` counts bytes, `eval` is an argument). */
const payloadFrom = (words) => {
  const hi = words.findIndex((w) => !ENV_ASSIGNMENT_WORD_RE.test(w.raw) && !w.op);
  const base = receiverOf(words);
  const run = words.findIndex((w, i) => i >= hi && (i === hi || /^(?:sudo|timeout|nice|nohup|env|exec|command)$/.test(base)) && /^(?:watch|trap)$/.test(w.value.split("/").pop()));
  if (run >= 0) return run + 1; // every argument of `watch`/`trap` (also behind a wrapper) is command text the shell runs
  if (TEXT_CONSUMER_RE.test(base)) return words.length; // literal-text consumers: `-c` counts bytes, `eval` is an argument
  const at = words.findIndex((w) => !w.op && (w.value === "eval" || EXEC_FLAG_RE.test(w.value) || (base === "git" && /^(?:-x|--exec(?:=.*)?)$/.test(w.value))));
  return at < 0 ? words.length : at + (words[at].value.startsWith("--exec=") ? 0 : 1);
};
/** Words that the shell executes as command text: the words `payloadFrom` selects (`-c`/`--command`/`eval`, `watch`/`trap`, `git -x`/`--exec`), or the target of a `<<<` here-string whose consumer is not a text reader. */
export const isPayloadWord = (words, k) => k >= payloadFrom(words) || (words[k - 1]?.op === "<<<" && !TEXT_CONSUMER_RE.test(receiverOf(words)));

const rawHead = (seg) => seg.words.find((w) => !ENV_ASSIGNMENT_WORD_RE.test(w.raw) && !w.op)?.value ?? "";
const segmentHead = (seg) => rawHead(seg).split("/").pop();
const REDIRECT_RE = /^\d*(?:&>>?|<>|>>?&?)\|?(.*)$/s;
/** Words a `cat`/`tee` segment writes to: the word after any `>`, `>>`, `>|`, `>&`, `&>`, `&>>` or `<>` operator, an attached `>file`, and every `tee` operand. `>&2`/`>&-` duplicate a descriptor and write no file. */
function writeTargets(seg) {
  const targets = seg.words.map((w, k) => { const attached = REDIRECT_RE.exec(w.value); return attached ? attached[1] || seg.words[k + 1]?.value : segmentHead(seg) === "tee" && k > 0 && !w.op && !w.value.startsWith("-") ? w.value : null; });
  return targets.filter((t) => t && !/^\d+$|^-$/.test(t)).map((t) => t.replace(/^\.\//, ""));
}

const TEXT_FLAG_RE = /^(?:-m|--message|--body|--title|--notes)$/;
const TEXT_FLAG_ATTACHED_RE = /^--(?:message|body|title|notes)=/;
/** A `git commit` segment whose head is the bare name: the only host whose text flag value is inert. `gh` hosts are excluded. */
const isTextHost = (seg) => seg.words[0]?.value === "git" && seg.words[1]?.value === "commit";
/** Whether the substitution in word K of SEG (a `isTextHost` segment) is inert text: the value of a text flag, never an env-assignment word. */
function substitutionIsInert(seg, k) {
  const { raw: w } = seg.words[k];
  const attached = TEXT_FLAG_ATTACHED_RE.exec(w);
  return !overridesConfig(seg) && isTextHost(seg) && /^(?:\$\(.*\)|"\$\(.*\)")$/s.test(attached ? w.slice(attached[0].length) : w) && (attached !== null || TEXT_FLAG_RE.test(seg.words[k - 1]?.value ?? ""));
}

/** A `-c`/`--config` override or `alias.` word (any case): git/gh run a shell alias from it. */
const overridesConfig = (seg) => seg.words.some((w) => /^(?:-c|--config)|alias\./i.test(w.value));

/**
 * Heredocs whose body is data (issue 2442 item 8): a `cat` or `tee` heredoc that is closed, whose delimiter is quoted or whose body has no
 * `$(`/backtick, whose segment is not piped onward, and that sits in no `-c`/`eval`/here-string payload.
 * Structural rule, counted over the whole tree: the command is exactly one `cat`/`tee` heredoc segment, or one root `git commit` segment (bare head) holding exactly one substitution that holds exactly one `cat` segment that writes no file. A top-level `git commit -F -` is not a host. Anything else keeps every heredoc body visible, so a later segment or substitution that runs a written file never sees a blanked body.
 * The host must write no file, carry no env-assignment word and no `-c`/alias override (`substitutionIsInert`); `echo`/`printf` are not hosts. The `cat`/`tee` head is the bare name or a `/bin/` or `/usr/bin/` path, with no env-assignment word and no `<(`/`>(` anywhere in a word.
 * Every other body executes and stays visible.
 * @returns {object[]}
 */
function dataHeredocs(segments) {
  if (segments.length !== 1) return []; // multi-segment: a later segment may run what the heredoc writes
  const seg = segments[0];
  const dataBody = (s) => { // closed, not piped onward, no process-substitution word (`>(sh)`, a `(`-target)
    if (s.pipedOut || s.words.some((w) => /[<>]\(/.test(w.raw) || /[<>]\(/.test(w.value))) return [];
    if (!/^(?:\/bin\/|\/usr\/bin\/)?(?:cat|tee)$/.test(rawHead(s)) || s.words.some((w) => ENV_ASSIGNMENT_WORD_RE.test(w.raw))) return []; // not cat/tee, or a path-prefixed or PATH-overridden `cat`, is an unknown program
    return s.heredocs.filter((x) => x.closed && (x.quoted || !/\$\(|`|\$\{[\s|]/.test(x.body.replace(/\\\n/g, ""))));
  };
  const subs = seg.words.flatMap((w, k) => w.subs.map((sub) => ({ sub, k })));
  if (subs.length === 0) return dataBody(seg);
  // exactly one inert git commit text-flag substitution holding exactly one substitution-free, file-writing-free cat segment
  if (subs.length !== 1 || seg.pipedOut || writeTargets(seg).length !== 0 || seg.words.some((w) => ENV_ASSIGNMENT_WORD_RE.test(w.raw))) return [];
  const { sub, k } = subs[0];
  const [inner] = sub.segments;
  return !isPayloadWord(seg.words, k) && substitutionIsInert(seg, k) && sub.segments.length === 1 && segmentHead(inner) === "cat" && writeTargets(inner).length === 0 && inner.words.every((w) => w.subs.length === 0) ? dataBody(inner) : [];
}

/** COMMAND with the data heredoc bodies blanked to same-length whitespace (newlines kept), so offsets still index the input. Incomplete input is returned unchanged. */
function blankDataHeredocs(command, tok) {
  if (tok.incomplete) return command;
  let out = command;
  for (const h of dataHeredocs(tok.segments)) out = out.slice(0, h.bodyStart) + out.slice(h.bodyStart, h.bodyEnd).replace(/[^\n]/g, " ") + out.slice(h.bodyEnd);
  return out;
}

/**
 * Coarse text hazards used by the default (PR-body) mode of `stripQuotedLiterals` and by `blankQuotedForFlags`; the wait and
 * poll predicates no longer use them (they trust the tokenizer). A caller that would read unblanked text as more permissive
 * (a foreign `--repo`, an explicit `-X GET`) must not.
 * ponytail: coarse text hazards (an escaped quote anywhere, a `#` comment with a quote, a quoted heredoc body, an unmatched quote inside a backtick span).
 * @param {string} command @returns {boolean}
 */
function hasQuotePairingHazard(command) {
  const { segments, ticks, comments, spans, incompleteAt } = tokenizeShellCommand(command);
  const quoteAfterIncomplete = incompleteAt >= 0 && /['"]/.test(command.slice(incompleteAt + 1)); // the tokenizer records no spans past an unterminated opener, but the old regex still paired quotes there
  const nestedQuote = spans.some(({ start, end, kind }) => {
    const inner = command.slice(start + 1, end - 1);
    return kind === "double" && /\$\(|`/.test(inner) && /['"]/.test(inner); // a substitution holding a nested quote the old regex mispaired
  });
  return quoteAfterIncomplete || nestedQuote || /\\['"]/.test(command) || ticks.some((span) => /['"]/.test(span)) || comments.some((text) => /['"]/.test(text)) || segmentsHaveQuotedHeredoc(segments);
}

/** Whether any heredoc body (including inside `$(...)`) contains a quote character. */
function segmentsHaveQuotedHeredoc(segments) {
  return segments.some((s) => s.heredocs.some((h) => /['"]/.test(h.body)) || s.words.some((w) => segmentsHaveQuotedHeredoc(w.subs.flatMap((x) => x.segments))));
}

/**
 * Shell-word tokenizer for the classifier. Returns `{ segments, spans, ticks, comments, incomplete, incompleteAt }`.
 * A segment ends at an unquoted `;`, `&&`, `||`, `|`, `|&`, `&` or newline (`>|`, `>&`, `&>` are
 * redirects). Each segment has `words` (`raw`, unquoted `value`, `single`/`double`/`ansi` quoting
 * flags, `subs` for `$(...)`, `op` for `<<`/`<<<` operator words) and `heredocs` (`delimiter`,
 * `quoted`, `stripTabs`, `body`, `start`, `segment` index). Models single/double/ANSI-C quotes, backslash
 * escapes, word-start `#` comments, here-strings, heredocs and `$(...)`/backtick substitutions.
 * `spans` lists every terminated quote span (`start`/`end` offsets in COMMAND). `ticks` lists the texts of terminated backtick substitutions and `comments` the texts of real unquoted `#` comments. Substitution nesting deeper than 64 levels sets `incomplete`. An unterminated
 * quote, `$(`, backtick or heredoc sets `incomplete`; `incompleteAt` is the offset of the earliest
 * unclosed opener, and callers treat the text from there on as unquoted executable text.
 * A heredoc record also carries `closed`, `bodyStart` and `bodyEnd` (offsets of the body in COMMAND) once its delimiter line is found; a segment
 * carries `pipedOut` when an unquoted `|`/`|&` follows it. A heredoc operator at the end of input with no
 * newline has no body to hide and is complete; a `<<` with no delimiter word, or a body that never reaches its delimiter line, is incomplete.
 * `$((expr))` with a plain expression is read as arithmetic text (so `1<<2` is no heredoc);
 * inside `$(...)` a line `DELIM)` followed only by whitespace or the substitution's closing double quote closes the heredoc and the substitution together.
 * ponytail: `${...}` quoting, subshell grouping and arithmetic holding a substitution or quote are not modelled; the last fails closed.
 * @param {string} command
 * @returns {{ segments: object[], spans: {start:number,end:number,kind:string}[], ticks: string[], comments: string[], incomplete: boolean, incompleteAt: number }}
 */
export function tokenizeShellCommand(command) {
  const ANSI_SIMPLE = { a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };
  // ANSI-C `$'...'` decoding: simple escapes, \xHH, \nnn, \uHHHH, \UHHHHHHHH; an unknown escape keeps its backslash.
  const decodeAnsiC = (text) => text.replace(/\\(x[0-9a-fA-F]{1,2}|[0-7]{1,3}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|.)/gs, (m, e) => {
    if (e in ANSI_SIMPLE) return ANSI_SIMPLE[e];
    if (/^[xuU]/.test(e) && e.length > 1) {
      const cp = parseInt(e.slice(1), 16);
      return cp > 0x10ffff ? m : String.fromCodePoint(cp); // out of range: keep the escape text instead of throwing
    }
    if (/^[0-7]/.test(e)) return String.fromCharCode(parseInt(e, 8) & 0xff);
    return /^[\\'"?]$/.test(e) ? e : m;
  });
  const n = command.length;
  const spans = [];
  const ticks = []; // terminated backtick substitutions the tokenizer actually reads (not inert backticks in quotes' literals or comments)
  const comments = []; // texts of real unquoted `#` comments
  let depth = 0;
  let i = 0;
  let incompleteAt = -1;
  const fail = (at) => { incompleteAt = incompleteAt < 0 ? at : Math.min(incompleteAt, at); i = n; };

  const readTicks = () => {
    const start = i;
    for (i++; i < n && command[i] !== "`"; i += command[i] === "\\" ? 2 : 1);
    if (i >= n) { fail(start); return command.slice(start); }
    i++;
    ticks.push(command.slice(start, i));
    return command.slice(start, i);
  };
  // `$((expr))` with a plain expression is arithmetic text (`1<<2` is a shift, not a heredoc). Anything that could hold a command or quote falls back to the `$(` reader.
  const readArith = () => {
    if (command[i + 2] !== "(") return null;
    let level = 2;
    for (let j = i + 3; j < n; j++) {
      if (command[j] === "(") level++;
      else if (command[j] === ")") {
        level--;
        if (level === 1 && command[j + 1] !== ")") return null; // bash (chk_arithsub): parens must stay balanced up to the final `))`; `$((a) > >(b))` is a substitution of subshells
        if (level === 0) {
          if (/\$\(|[`'"\\]/.test(command.slice(i + 3, j - 1))) return null;
          const text = command.slice(i, j + 1);
          i = j + 1;
          return text;
        }
      }
    }
    return null;
  };
  const readSub = (word) => {
    const start = i;
    const arith = readArith();
    if (arith !== null) return arith;
    if (depth >= 64) { fail(start); return command.slice(start); } // bounded recursion: past the cap the input is incomplete, so the gate denies
    i += 2;
    depth++;
    const { segments, closed } = parseSeq(true);
    depth--;
    if (!closed) fail(start);
    word.subs.push({ start, end: i, segments });
    return command.slice(start, i);
  };
  const readDouble = (word) => {
    const start = i;
    let value = "";
    word.double = true;
    for (i++; i < n;) {
      const c = command[i];
      if (c === '"') { i++; spans.push({ start, end: i, kind: "double" }); return value; }
      if (c === "\\") { const d = command[i + 1] ?? ""; value += /["\\$`]/.test(d) ? d : c + d; i += 2; }
      else if (c === "$" && command[i + 1] === "(") value += readSub(word);
      else if (c === "`") value += readTicks();
      else { value += c; i++; }
    }
    fail(start);
    return value;
  };

  function parseSeq(inSub) {
    const pending = []; // heredocs queued in THIS sequence: a newline inside a substitution must not consume its parent's heredoc
    const segments = [];
    let seg = { words: [], heredocs: [], start: i, end: i };
    let word = null;
    const newWord = () => ({ raw: "", value: "", start: i, end: i, single: false, double: false, ansi: false, subs: [] });
    const endWord = () => {
      if (!word) return;
      word.end = i;
      word.raw = command.slice(word.start, i);
      seg.words.push(word);
      word = null;
    };
    const endSeg = () => {
      endWord();
      if (seg.words.length || seg.heredocs.length) { seg.end = i; segments.push(seg); }
      seg = { words: [], heredocs: [], start: i, end: i };
    };
    const operator = (op, len) => {
      endWord();
      word = { ...newWord(), value: op, op };
      i += len;
      endWord();
    };
    const wordUnit = () => {
      word ??= newWord();
      const c = command[i];
      const next = command[i + 1];
      if (c === "\\") { if (next !== "\n") word.value += next ?? ""; i += 2; }
      else if (c === "'") {
        const end = command.indexOf("'", i + 1);
        word.single = true;
        if (end < 0) { word.value += command.slice(i + 1); fail(i); return; }
        word.value += command.slice(i + 1, end);
        spans.push({ start: i, end: end + 1, kind: "single" });
        i = end + 1;
      } else if (c === "$" && next === "'") {
        let j = i + 2;
        while (j < n && command[j] !== "'") j += command[j] === "\\" ? 2 : 1;
        word.ansi = true;
        if (j >= n) { word.value += command.slice(i + 2); fail(i); return; }
        word.value += decodeAnsiC(command.slice(i + 2, j));
        spans.push({ start: i + 1, end: j + 1, kind: "ansi" });
        i = j + 1;
      } else if (c === '"') word.value += readDouble(word);
      else if (c === "$" && next === "(") word.value += readSub(word);
      else if (c === "`") word.value += readTicks();
      else { word.value += c; i++; }
    };
    const readHeredocBodies = () => {
      for (const h of pending.splice(0)) {
        const bodyStart = i;
        let found = false;
        for (let lineStart = i; lineStart < n && !found;) {
          let eol = command.indexOf("\n", lineStart);
          if (eol < 0) eol = n;
          const line = command.slice(lineStart, eol);
          // A delimiter line at end of input needs no trailing newline (bash accepts it). Inside `$(...)`, `EOF)` closes the heredoc and the substitution together; outside one it is not a delimiter, so the heredoc stays incomplete.
          const text = h.stripTabs ? line.replace(/^\t+/, "") : line;
          const closesSub = inSub && text.startsWith(`${h.delimiter})`) && /^\s*"?\s*$/.test(text.slice(h.delimiter.length + 1)); // only whitespace or the substitution's closing quote may follow
          if (text === h.delimiter || closesSub) {
            h.bodyStart = bodyStart;
            h.bodyEnd = Math.max(bodyStart, lineStart - 1);
            h.body = command.slice(h.bodyStart, h.bodyEnd);
            h.closed = true;
            i = closesSub ? lineStart + line.length - text.length + h.delimiter.length : Math.min(eol + 1, n);
            found = true;
          }
          lineStart = eol + 1;
        }
        if (!found) { h.body = command.slice(bodyStart); fail(h.start); }
      }
    };

    while (i < n) {
      const c = command[i];
      const next = command[i + 1];
      const redirectChar = word && (command[i - 1] === ">" || command[i - 1] === "<");
      if (inSub && c === ")") { endSeg(); if (pending.length) fail(pending[0].start); i++; return { segments, closed: true }; }
      if (c === " " || c === "\t") { endWord(); i++; }
      else if (c === "\n") { endSeg(); i++; readHeredocBodies(); }
      else if (c === "#" && !word) { const at = i; while (i < n && command[i] !== "\n") i++; comments.push(command.slice(at, i)); }
      else if (c === "&" && next === "&") { endSeg(); i += 2; }
      else if (c === "|" && next === "|") { endSeg(); i += 2; }
      else if (c === "|" && next === "&") { seg.pipedOut = true; endSeg(); i += 2; }
      else if (c === ";" || (c === "|" && !(word && command[i - 1] === ">")) || (c === "&" && !redirectChar && next !== ">")) { if (c === "|") seg.pipedOut = true; endSeg(); i++; }
      else if (c === "<" && command.startsWith("<<<", i)) operator("<<<", 3);
      else if (c === "<" && next === "<") {
        const start = i;
        const stripTabs = command[i + 2] === "-";
        operator("<<", stripTabs ? 3 : 2);
        while (command[i] === " " || command[i] === "\t") i++;
        while (i < n && !/[ \t\n;&|()<>]/.test(command[i])) wordUnit();
        const delimiter = word;
        endWord();
        if (!delimiter) { fail(start); continue; }
        const heredoc = { delimiter: delimiter.value, quoted: delimiter.single || delimiter.double || delimiter.ansi || delimiter.raw.includes("\\"), stripTabs, body: "", start, segment: segments.length };
        seg.heredocs.push(heredoc);
        pending.push(heredoc);
      } else wordUnit();
    }
    endSeg();
    return { segments, closed: false };
  }

  const { segments } = parseSeq(false);
  return { segments, spans, ticks, comments, incomplete: incompleteAt >= 0, incompleteAt };
}

/**
 * Whether COMMAND is (or contains) a sleep-poll loop over `gh`/`loop-state` — a `while`/`until`/
 * `for` loop whose body contains both a `sleep` and a `gh` or `loop-state` call. Checked on the
 * WHOLE command (not per-segment): the loop body is `;`-delimited, so a per-segment split would
 * separate the loop head from its `sleep`/`gh` body calls and miss the pattern. `gh` must be a
 * standalone token (not `grep gh-notes`), and `loop-state` must sit at a command-head position
 * (not a substring inside `grep loop-state x`). Quoted literals are blanked first (see
 * `stripQuotedLiterals`) so a quoted body/example that merely contains the tokens is not flagged.
 * @param {string} command @returns {boolean}
 */
export function commandIsSleepPollLoop(command) {
  const whole = stripQuotedLiterals(command.trim());
  return (
    /(?:while|until|for)\b/i.test(whole) &&
    /\bsleep\b/.test(whole) &&
    /\bgh(?=\s|$)|(?:^|[;&|(])\s*loop-state(?=\s|$)/.test(whole)
  );
}

/**
 * Whether COMMAND is (or contains) a bare FILE-MARKER poll loop: a `while`/`until`/`for` loop that
 * repeatedly tests for a file's existence/type/permission (`[ -f … ]`, `[[ -e … ]]`, `test -f …`,
 * `[ -r … ]`, `[ -L … ]`) and sleeps, with NO gated wait-tool. This is the orphan pattern under
 * Claude Code — a `<tasks>/<id>.done` sentinel Claude Code never writes (completion arrives via
 * async notification), so the loop never exits and, once backgrounded, orphans with no async wake to
 * reap it. Distinct from `commandIsSleepPollLoop`, which keys on a `gh`/`loop-state` CALL: this keys
 * on any bash FILE-test operator (existence, type, or permission — `efsdrwxugkOGLNShb`; string/numeric
 * tests like `-z`/`-n`/`-t` are deliberately excluded, as those never test a marker FILE), catching a
 * marker poll that calls no gh/loop-state at all. Verb-independent (while/until/for). Quoted literals
 * are blanked first (see `stripQuotedLiterals`) so a quoted example or `--body` payload that merely
 * contains the tokens is NOT flagged.
 * @param {string} command @returns {boolean}
 */
export function commandIsFileMarkerPollLoop(command) {
  const whole = stripQuotedLiterals(command.trim());
  return (
    /(?:while|until|for)\b/i.test(whole) &&
    /\bsleep\b/.test(whole) &&
    /(?:\[\[?|\btest\b)\s+(?:!\s+)?-[a-hkprsuwxGLNOS]\b/.test(whole)
  );
}

const SLEEP_LOOP_SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

/**
 * Whether COMMAND holds a `while`/`until`/`for` loop whose body runs `sleep`, whatever the loop condition.
 * Reads tokenizer segments, so quoted literals and heredoc bodies never count; `eval` and `sh|bash|zsh -c`
 * payloads are checked again as shell. An incomplete parse fails closed on raw text.
 * A `sh|bash|zsh|dash|ksh [flags] -c` payload is found after wrappers only, so `env -i`, `nice -n` and `xargs -I{}` do not hide it and `echo bash -c ...` is text.
 * A loop opened after `{` (function body) or inside `<(`/`>(` counts, and a `for((` head counts. A sleep behind `nohup`, `nice -n`, `stdbuf`, `exec` counts.
 * Heads are normalized first: `!`/`if`/`else`/`elif`, a glued `(`, wrappers (`timeout`, `env`, `sudo`, ...) and
 * path prefixes (`/bin/sleep`) are stripped; a `sleep` right after a loop keyword counts as a sleep head.
 * ponytail: the check is whole-command (a loop head anywhere plus a sleep head anywhere), so
 * `for f in a; do echo $f; done; sleep 1` is denied; split the call. Backtick-substitution loops are not parsed.
 * @param {string} command @returns {boolean}
 */
export function commandIsSleepLoop(command) {
  const { segments, incomplete } = tokenizeShellCommand(command);
  if (incomplete) return /\b(?:while|until|for)\b/.test(command) && /\bsleep\b/.test(command);
  const heads = [];
  const SKIP = /^(?:do|then|\{|command|builtin|!|else|elif|if|\()$/;
  // Index past SKIP words, assignments and leading redirections (`2>/dev/null`, `> f`) at or after k.
  const skipPrefix = (words, k) => {
    for (;;) {
      const w = words[k];
      if (w === undefined) return k;
      const r = redirectionSkip(w);
      if (r) k += r;
      else if (SKIP.test(w) || /^[A-Za-z_]\w*=/.test(w) || (w === "-p" && words[k - 1] === "command") || (w === "--" && (/^(?:command|builtin)$/.test(words[k - 1]) || (words[k - 1] === "-p" && words[k - 2] === "command")))) k++;
      else return k;
    }
  };
  // Index of the normalized head word at or after k, and the head itself.
  const headAt = (words, k) => {
    k = skipPrefix(words, k);
    if (k >= words.length) return { j: k, head: undefined };
    const w = [words[k].replace(/^(?:do|then|else)(?=\()/, "").replace(/^\(+/, ""), ...words.slice(k + 1)]; // `do(sleep`: the keyword glued to a subshell
    const rest = stripLeadingWrappers(w.join(" "));
    let j = 0;
    for (let i = 0; i < w.length; i++) if (stripLeadingWrappers(w.slice(i).join(" ")) === rest) j = i;
    return { j: k + j, head: rest.split(/\s+/, 1)[0] };
  };
  const base = (w) => w.replace(/^[<>]?\(+/, "").replace(/^.*\//, "");
  const LOOP = /^(?:while|until|for)(?:$|\()/;
  const flat = (segs, text) => {
    for (const seg of segs) {
      const words = seg.words.map((w) => w.value);
      const { j, head } = headAt(words, 0);
      heads.push(LOOP.test(head ?? "") ? "while" : head);
      // The condition runs as a command: scan it like a body command (wrappers, `sh -c` and `eval` payloads).
      if (/^(?:while|until)$/.test(head ?? "") && j + 1 < words.length) flat([{ ...seg, words: seg.words.slice(j + 1) }], text);
      // A loop opened mid-segment: after a `{` (function body) or inside `<(` / `>(` (process substitution).
      words.forEach((w, i) => {
        const open = i > 0 && (words[i - 1] === "{" || /^[\w.-]+\(\)\{$/.test(words[i - 1])) && !seg.words[i - 1].single && !seg.words[i - 1].double && !seg.words[i - 1].ansi; // a quoted `{` is text
        if ((open || /^[<>]\(/.test(w)) && LOOP.test(w.replace(/^[<>]?\(+/, ""))) heads.push("while");
        if (open) heads.push(headAt(words, i).head); // a sleep inside a function body
        if (/^[<>]\(/.test(w) && !seg.words[i].single && !seg.words[i].double) heads.push(headAt([w.replace(/^[<>]\(+/, ""), ...words.slice(i + 1)], 0).head); // `<(sleep 5)`: the executable head
      });
      // A command after a `case` arm label (`a)`, `a|b)`, `*)`) is a head too.
      words.forEach((w, i) => {
        if (/^\(?[^\s()$`]*\)$/.test(w) && /(?<!\\)\)$/.test(seg.words[i].raw)) heads.push(headAt(words, i + 1).head);
      });
      const payloads = [];
      if (head === "eval") payloads.push(words.slice(j + 1 + +(words[j + 1] === "--")).join(" "));
      // A shell in command position (found by headAt through stripLeadingWrappers, so `echo bash -c '...'` stays text):
      // every argument, heredoc body, here-string and pipe producer feeding it is payload.
      if (SLEEP_LOOP_SHELLS.has(base(head ?? ""))) {
        for (const w of words.slice(j + 1)) payloads.push(w);
        for (const h of seg.heredocs) payloads.push(h.body);
        for (let cur = seg; cur; ) {
          const prev = segs[segs.indexOf(cur) - 1];
          if (!prev || !/(?:^|[^|])\|(?!\|)|\|&/.test(text?.slice(cur.start, cur.words[0].start) ?? "")) break;
          for (const w of prev.words) payloads.push(w.value);
          for (const h of prev.heredocs) payloads.push(h.body);
          cur = prev;
        }
      }
      // The payload's own heads join the outer list, so `while true; do sh -c 'sleep 5'; done` counts.
      for (const p of payloads) {
        const t = tokenizeShellCommand(p);
        if (!t.incomplete) flat(t.segments, p);
        else if (commandIsSleepLoop(p)) heads.push("while", "sleep");
      }
      for (const w of seg.words) for (const s of w.subs) flat(s.segments, text);
    }
  };
  flat(segments, command);
  return heads.some((h) => LOOP.test(h ?? "")) && heads.includes("sleep");
}

/**
 * Whether COMMAND contains a bare `&` backgrounding control operator — not `&&` (logical AND) and
 * not a redirection (`2>&1`, `>&2`, `&>file`, `&>>file`). A coarse whole-string check (no shell
 * parse): redirection forms are stripped first, then any surviving lone `&` (not immediately
 * preceded or followed by another `&`) counts.
 * @param {string} command @returns {boolean}
 */
function commandHasBareBackgroundOperator(command) {
  const withoutRedir = command
    .replace(/\d*>&\d*-?/g, " ") // 2>&1, 1>&2, >&2, >&-
    .replace(/&>>?/g, " "); // &>file, &>>file
  return /(?<!&)&(?!&)/.test(withoutRedir);
}

/**
 * The wait/probe helper FAMILY: the Copilot/CI wait tools that MUST run as a bounded FOREGROUND
 * probe — the `.mjs` helpers (`probe-copilot-review`, `wait-pr-checks`, `detect-copilot-loop-state`,
 * `run-watch-cycle`, `probe-ci-status` — the sanctioned `ci-status`/`watch-ci` CI-status wait,
 * skills/dev-loop/SKILL.md's "PR checks/status" entry), `gh run watch`, and the
 * `dev-loops`/`dev-loops-run` `watch-cycle`/`watch-ci`/`watch-initial`/`gate probe-copilot` CLI
 * verbs. A coarse ANYWHERE-in-the-string substring/family match (deliberately NOT exec-position
 * anchored) — see `commandContainsDetachedWaitTool`'s JSDoc for the fail-closed rationale.
 */
const WAIT_PROBE_FAMILY_RE = new RegExp(
  [
    "probe-copilot-review\\.mjs",
    "wait-pr-checks\\.mjs",
    "detect-copilot-loop-state\\.mjs",
    "run-watch-cycle\\.mjs",
    "probe-ci-status\\.mjs",
    "gh\\s+run\\s+watch",
    "watch-cycle",
    "watch-ci",
    "watch-initial",
    "probe-copilot",
    "wait-for-units",
    "wait-for-gate-units\\.mjs",
  ].join("|"),
  "i",
);

/**
 * COPILOT-FOLLOWUP-WAIT-TOOLS: a banned detached/polling wait. This is a UNION of three
 * independent deny conditions — NOT one big AND (an AND-condition here would inadvertently
 * narrow the unconditional detach-wrapper ban below to "detach AND family reference", wrongly
 * allowing a family-less `nohup node build.mjs &`):
 *
 *   (1) `nohup`/`disown`/`tmux new-session`/`screen -dm` anywhere in a command segment — denied
 *       UNCONDITIONALLY, with NO wait/probe-family requirement.
 *   (2) A `while`/`until`/`for` sleep-poll loop over `gh`/`loop-state` (`commandIsSleepPollLoop`), a bare
 *       file-marker poll (`commandIsFileMarkerPollLoop`), or any loop that sleeps (`commandIsSleepLoop`) —
 *       denied UNCONDITIONALLY — it IS the backgrounding signal.
 *   (3) OPTION-C, prevention-only scope: a bare `&` background (`commandHasBareBackgroundOperator`,
 *       including a `timeout …`/`env …`/`sh -c` wrapper of it) that ALSO references the wait/probe
 *       FAMILY anywhere in the command string (`WAIT_PROBE_FAMILY_RE`) — a coarse substring/family
 *       match, deliberately NOT exec-position anchored.
 *
 * Because (3)'s family match is coarse (anywhere in the string, not the executed token), NO wrapper
 * can hide the reference from it: `timeout N … &`, `env … &`, `sh -c '… &'`, or a node loader flag
 * (`node -r ./loader.mjs …/probe-copilot-review.mjs &`, `--require`/`--loader`/`--import`) all still
 * carry the family token in the backgrounded command text, so all are denied. This trades precision
 * for guaranteed coverage: a background command that merely MENTIONS a family name as an unrelated
 * argument (`echo "see probe-copilot-review.mjs" &`) is also denied — a benign false positive,
 * sanctioned by the issue's non-goals (this is a prevention gate, not an exec-position parser; a
 * denied benign command simply falls back to the sanctioned foreground path). The precise
 * exec-position parser this replaced (and the SubagentStop background-shell reaper it fed) is
 * deferred to a follow-up safety-net effort.
 *
 * Actor-independent at the decideBashGate call site: the coordinator/main agent — not only a
 * subagent — is the actor that leaves these orphaned under Claude Code (no async wake to join a
 * backgrounded wait), so the gate catches its backgrounding too.
 * @param {string} command @returns {boolean}
 */
export function commandContainsDetachedWaitTool(command) {
  const whole = command.trim();
  // Operators are read on the view with data heredoc bodies and inert quoted text blanked (`stripQuotedLiterals`, precise); the family name is matched on the raw text, so a quoted script path still counts.
  const view = stripQuotedLiterals(whole, true, true);

  // (1) Unconditional detach-wrapper ban — no wait/probe-family requirement.
  const hasDetachWrapper = shellSegments(view).some((segment) => {
    // `nohup`/`disown` only detach when they head a command (segment start, or right after a
    // shell operator) — a bare mention (`cat nohup.out`, `echo "nohup banned"`) is not a detach.
    if (/(?:^|[;&|])\s*(?:nohup|disown)\b/.test(segment)) return true;
    if (/^tmux\s+new-session\b/i.test(segment)) return true;
    if (/^screen\s+-dm/i.test(segment)) return true;
    return false;
  });
  if (hasDetachWrapper) {
    return true;
  }

  // (2) Unconditional sleep-poll-loop ban — a gh/loop-state poll, a bare file-marker poll, OR any loop that sleeps (commandIsSleepLoop).
  if (commandIsSleepPollLoop(whole) || commandIsFileMarkerPollLoop(whole) || commandIsSleepLoop(whole)) {
    return true;
  }

  // (3) OPTION-C: bare-`&` background AND a wait/probe family reference.
  if (!commandHasBareBackgroundOperator(view)) {
    return false;
  }
  return WAIT_PROBE_FAMILY_RE.test(whole);
}

/**
 * A `timeout [options] <duration>` shell wrapper in front of a sanctioned dev-loops command
 * (`dev-loops`, `dev-loops-run`, or a dev-loops `scripts/<family>/…` entrypoint). The wrapped head no longer starts
 * with `dev-loops-run`, so operator allow rules such as `Bash(dev-loops-run scripts/github/*)` stop
 * matching. Sanctioned wait tools bound themselves with `--timeout <seconds>` instead (issue 2755).
 * @param {string} command @returns {boolean}
 */
const TIMEOUT_DURATION = "(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?[smhd]?";
const TIMEOUT_WRAPPER_RE = new RegExp(
  `^${ENV_ASSIGNMENT_RUN}(?:(?:env|command|sudo|nice)\\s+(?:(?:-\\S+|[A-Za-z_]\\w*=\\S*)\\s+)*)*` +
    `(?:\\S*/)?g?timeout\\s+(?:-{1,2}[\\w-]+(?:=\\S+|\\s+(?:${TIMEOUT_DURATION}|[A-Za-z]+))?\\s+)*${TIMEOUT_DURATION}\\s+` +
    "(?:(?:node|bun)\\s+(?:-\\S+\\s+)*)?['\"]?(\\S+)",
);
const SANCTIONED_HEAD_RE = /^(?:\S*\/)?dev-loops(?:-run)?['"]?$/;
// The wrapped head is checked on one captured token, not in the big regex, so `\S*` stretches cannot backtrack.
// Only the dev-loops script families count; a consumer's own script does not.
const SANCTIONED_SCRIPT_RE = /(?:^|[/'"])scripts\/(?:github|loop|lib|docs|claude|projects)\/\S*\.mjs/;
function isSanctionedHead(token) {
  return SANCTIONED_HEAD_RE.test(token) || token.includes("cli/index.mjs") || SANCTIONED_SCRIPT_RE.test(token);
}
export function commandContainsTimeoutWrappedSanctionedTool(command) {
  return shellSegments(command).some((segment) => {
    const head = TIMEOUT_WRAPPER_RE.exec(segment)?.[1];
    return head !== undefined && isSanctionedHead(head);
  });
}

/** Wrapper binaries whose first argument is the real command to classify. */
const WRAPPER_BINARIES = new Set(["sudo", "env", "xargs", "time", "nice", "command", "nohup", "exec", "stdbuf", "setsid", "ionice", "busybox", "builtin"]);
// A bare wrapper flag (`-n`, `--user`) takes the next word as its argument, unless that word is itself the command.
const WRAPPER_FLAG_TARGETS = new Set([...WRAPPER_BINARIES, ...SLEEP_LOOP_SHELLS, "timeout", "gtimeout", "sleep"]);
// The decision-recorder scan also keeps a launcher word after a bare wrapper flag (`sudo -n node ...`). The shared set leaves it out so `sudo -u node node -e` still shifts the user name.
const LAUNCHER_FLAG_TARGETS = new Set([...WRAPPER_FLAG_TARGETS, "node", "bun", "dev-loops-run", "dev-loops"]);

/**
 * Strip prefixes that hide the real command head, fail-closed (over-report is
 * fine, under-report is the bug):
 *   - leading `NAME=value ` env-assignment tokens (any number)
 *   - leading wrapper binaries (`sudo`, `env`, `xargs`, ...) — recurse on the rest
 *   - a path-prefixed binary (`./x/gh`, `/usr/bin/python3`) → reduce head to its basename
 * Returns the segment with a bare, classifiable command head.
 */
export function stripLeadingWrappers(segment, flagTargets = WRAPPER_FLAG_TARGETS) {
  let s = segment.trim();
  // (a) strip leading env-assignment tokens: NAME=value. The value may be
  //   unquoted (`X=1`) or a single/double-quoted string that itself contains
  //   spaces (`X="a b"`); match the quoted form first so the space inside the
  //   quotes is not mistaken for the token separator (would under-report).
  const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+(?=\S)/;
  while (ENV_ASSIGN.test(s)) {
    s = s.replace(ENV_ASSIGN, "");
  }
  // (c) reduce a path-prefixed head to its basename so `.../gh` → `gh`
  s = s.replace(/^(\S*\/)([^/\s]+)/, "$2");
  // (d) strip `timeout [options] <duration>` (e.g. `timeout -k 5 60 gh ...`), then re-normalize
  const DURATION = String.raw`(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?[smhd]?`;
  const TIMEOUT_PREFIX = new RegExp(String.raw`^g?timeout\s+(?:-{1,2}[\w-]+(?:=\S+|\s+(?:${DURATION}|[A-Z]+))?\s+)*${DURATION}\s+(?=\S)`, "i");
  if (TIMEOUT_PREFIX.test(s)) return stripLeadingWrappers(s.replace(TIMEOUT_PREFIX, ""), flagTargets);
  // (b) strip a leading wrapper binary, then re-normalize the remainder
  const head = s.split(/\s+/, 1)[0];
  if (WRAPPER_BINARIES.has(head)) {
    const words = s.slice(head.length).trim().split(/\s+/).filter(Boolean);
    while (/^-/.test(words[0] ?? "")) {
      const bare = /^(?:-[A-Za-z]|--[\w-]+)$/.test(words[0]);
      words.shift();
      if (bare && words.length > 1 && !flagTargets.has(words[0].replace(/^.*\//, ""))) words.shift();
    }
    if (words.length > 0) return stripLeadingWrappers(words.join(" "), flagTargets);
  }
  return s;
}

/**
 * Whether the quoted words of segment S are inert text. A quoted word is inert only behind a text head or a repo script runner; any other head keeps its quoted words visible (origin/main's raw split), so `git bisect run 'x; node -e y'` is still seen.
 * The head must be the bare name (no path, no env prefix) and the command must define no function, since either can rebind the name to a program that runs its quoted words.
 * One structural rule: the command must be a single top-level segment (no `;`, `&&`, `||`, `|`, newline), so no earlier segment can rebind PATH, define a function, or source a file, and no later segment can run what this one writes. The first word is the head, so an assignment word (`PATH=x grep …`) is never a text head.
 */
function inertQuoteSegment(tok, s) {
  const [h = "", arg = ""] = s.words.filter((w) => !w.op).map((w) => w.value);
  return tok.segments.length === 1 && !s.pipedOut && writeTargets(s).length === 0 && !h.includes("/") && !s.words.some((w) => /\$\(|`|[<>]\(|\$\{[\s|]/.test(joinContinuations(w.raw))) && (/^(?:echo|printf|cat|tee|grep|rg|head|tail|wc|sort|test|dev-loops-run)$/.test(h) || (/^(?:node|bun)$/.test(h) && arg.startsWith("scripts/")));
}

// A redirection token (`2>&1`, `2>/dev/null`, `>out`, `&>x`) is not a command word. Returns how many tokens to skip: 0 (not a redirection), 1, or 2 (operator alone, its target is the next token). Read by the sleep-loop predicates, not by the inline-interpreter gate.
const REDIRECTION_RE = /^(?:\d*(?:>>?|<|>&)|&>>?)/;
const REDIRECTION_OPERATOR_ONLY_RE = /^(?:\d*(?:>>?|<|>&)|&>>?)$/;
const redirectionSkip = (t) => (!t.includes("<<") && REDIRECTION_RE.test(t) ? (REDIRECTION_OPERATOR_ONLY_RE.test(t) ? 2 : 1) : 0);

/** Interpreter heads covered by OPS-NO-INLINE-INTERPRETER (issue 2442 item 10). `deno` stays uncovered. */
const INTERPRETER_HEAD_RE = /^(?:node|bun|python3?|perl|ruby)$/;
/** Heads that run a file: a heredoc-written file run by one of them in the same command is denied. */
const FILE_RUNNER_HEAD_RE = /^(?:node|bun|python3?|perl|ruby|sh|bash|dash|ksh|zsh|\.|source)$/;
/** A path in its comparison form: lowercased (a case-insensitive file system), `//` and `/./` collapsed, no leading `./`. */
const normPath = (p) => {
  const out = [];
  for (const seg of p.toLowerCase().split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === ".." && out.length && out.at(-1) !== "..") out.pop();
    else out.push(seg);
  }
  return (p.startsWith("/") ? "/" : "") + out.join("/");
};
/** TEXT without its line continuations: a backslash-newline joins lines unless its backslash is itself escaped (an even run before it). */
const joinContinuations = (text) => text.replace(/(?<!\\)((?:\\\\)*)\\\n/g, "$1");
/** node and bun flags whose next word is the flag's value, never the script (the origin/main 99bb8b3ce lists). */
const NODE_VALUE_FLAGS = new Set(["-r", "--require", "--import", "--loader", "--experimental-loader", "--env-file", "--conditions", "-C", "--cwd", "--input-type", "--title", "--disable-warning", "--watch-path", "--redirect-warnings", "--env-file-if-exists", "--test-reporter", "--report-dir", "--diagnostic-dir", "--cpu-prof-dir", "--heap-prof-dir", "--snapshot-blob", "--test-reporter-destination", "--localstorage-file", "--openssl-config", "--icu-data-dir", "--tls-keylog", "--experimental-config-file", "--experimental-sea-config", "--trace-event-file-pattern"]);
const BUN_VALUE_FLAGS = new Set(["--cwd", "--env-file", "-r", "--preload", "--require", "--import", "-c", "--config", "--tsconfig-override", "--define", "-d", "--loader", "-l", "--port", "--conditions", "--console-depth"]);
/** node and bun long flags known to be boolean: the word after one is the script. Any other `--flag` takes a value (the refusing direction). */
const NODE_BOOLEAN_FLAGS = new Set(["--no-warnings", "--no-deprecation", "--trace-warnings", "--trace-deprecation", "--trace-uncaught", "--enable-source-maps", "--experimental-vm-modules", "--experimental-strip-types", "--experimental-transform-types", "--experimental-detect-module", "--experimental-require-module", "--experimental-websocket", "--experimental-sqlite", "--experimental-permission", "--permission", "--watch", "--expose-gc", "--abort-on-uncaught-exception", "--pending-deprecation", "--throw-deprecation", "--no-experimental-fetch"]);
const BUN_BOOLEAN_FLAGS = new Set(["--silent", "--bun", "--watch", "--hot", "--smol", "--no-install", "--if-present", "--no-clear-screen"]);
/** A word that is the script after an unlisted `--flag`: it has a script extension or is path-like. */
const SCRIPT_WORD_RE = /\.(?:[cm]?js|[cm]?ts)$|^\.|^[^/]+\//;
const PRELOAD_FLAG_RE = /^(?:-r|--require|--import|--loader|--experimental-loader|--preload)$/;

/**
 * Classify one interpreter flag word: "code" (inline code), "inplace" (in-place edit), "value" (the next word is
 * its value), "long" (an unlisted node/bun `--flag`: the next word is its value unless it reads as the script) or
 * null (a plain flag, a python `-m` included).
 */
function interpreterFlag(head, t) {
  if (head === "node" || head === "bun") {
    if (/^-[ep]|^--(?:eval|print)(?:=|$)/.test(t)) return "code";
    if ((head === "node" ? NODE_VALUE_FLAGS : BUN_VALUE_FLAGS).has(t)) return "value";
    return t.startsWith("--") && !t.includes("=") && !(head === "node" ? NODE_BOOLEAN_FLAGS : BUN_BOOLEAN_FLAGS).has(t) ? "long" : null;
  }
  if (head.startsWith("python")) return /^-[BEIOPRSUVbdhiqsuvx]*c/.test(t) ? "code" : /^-[BEIOPRSUVbdhiqsuvx]*[WXm]$|^--check-hash-based-pycs$/.test(t) ? "value" : null; // `-m x -c y` denies: the module word is the flag's value, and `-c` after it still reads as code (origin/main denied it)
  if (t.startsWith("--")) return null;
  // perl and ruby: walk the short-flag cluster; a letter that takes an argument ends it
  const argLetters = head === "perl" ? "IMmxdD" : "IrCEFxT";
  for (let k = 1; k < t.length; k++) {
    if (head === "perl" && ("CF".includes(t[k]) || (t[k] === "V" && t[k + 1] === ":"))) return null; // -C, -F and `-V:` take an attached value (`-Cio`, `-Fi`, `-V:intsize`): its letters are no `e`/`i` flags; a bare `-V` is a flag and the cluster goes on (`-Ve x`)
    if (head === "ruby" && t[k] === "W") { k += /^(?:\d+|:[\w-]+)?/.exec(t.slice(k + 1))[0].length; continue; } // `-W2`, `-W:no-deprecated`: the level or category ends, the cluster goes on (`-We`)
    if (head === "ruby" && t[k] === "K") { k++; continue; } // `-Ku`: one encoding letter, then the cluster goes on (`-Kue`)
    if (argLetters.includes(t[k])) return k === t.length - 1 && "IMmrCEF".includes(t[k]) ? "value" : null;
    if (t[k] === "e" || (head === "perl" && t[k] === "E")) return "code";
    if (t[k] === "i") return "inplace";
  }
  return null;
}

/**
 * The closed-list form of an interpreter command (ARGS are the words after the head; STDIN holds the source offsets of its
 * fd-0 heredoc and here-string redirects): "code", "inplace", "heredoc" (a stdin heredoc), "herestring" (a `<<<` stdin script and no
 * other form), "dash" (a `-` stdin script with no heredoc), "stdin" (no script: the interpreter reads stdin) or null (a script runs).
 * OUT receives the script word and, with `out.loaded`, the preload values.
 */
function interpreterForm(head, args, { heredoc = Infinity, herestring = Infinity }, out = {}) {
  let here = false; // a here-string came before the current word
  for (let k = 0; k < args.length; k++) {
    const { value: t, start } = args[k];
    if (heredoc < start) return "heredoc";
    here ||= herestring < start;
    if (t === "-") return heredoc < Infinity ? "heredoc" : "dash"; // later words are script arguments
    if (head === "bun" && t === "run") continue;
    if (!t.startsWith("-")) { out.script = args[k]; return here ? "herestring" : null; }
    if (t === "--") continue; // origin/main keeps scanning past `--`, so `node -- -e x` stays denied
    const attached = out.loaded && /^--(?:require|import|loader|experimental-loader|preload)=(.+)$/.exec(t);
    if (attached) out.loaded.push({ value: attached[1] }); // an attached preload value is code that runs too
    const flag = interpreterFlag(head, t);
    if (flag === "code" || flag === "inplace") return flag;
    const next = args[k + 1];
    if (flag === "value" && next) { if (out.loaded && PRELOAD_FLAG_RE.test(t)) out.loaded.push(next); k++; } // a preload flag value is code that runs
    // shortcut: a relative path value after an unlisted path-valued `--flag` reads as the script (allow), as on origin/main; list such a flag.
    if (flag === "long" && next && !next.value.startsWith("-") && !SCRIPT_WORD_RE.test(next.value)) k++;
  }
  return heredoc < Infinity ? "heredoc" : herestring < Infinity ? "herestring" : "stdin";
}

/** Whether `sed`/`gsed` ARGS edit in place (`-i`, `-i.bak`, a cluster holding `i`, `--in-place`). */
function sedInPlace(args) {
  for (let k = 0; k < args.length; k++) {
    const t = args[k].value;
    if (t === "--") return false;
    if (/^--in-place(?:=|$)/.test(t)) return true;
    if (/^--(?:expression|file|line-length)$/.test(t)) { k++; continue; }
    if (!/^-[^-]/.test(t)) continue;
    for (let j = 1; j < t.length; j++) {
      if (t[j] === "i") return true;
      if ("efl".includes(t[j])) { if (j === t.length - 1) k++; break; } // the rest of the word, or the next word, is the value
    }
  }
  return false;
}

/** Whether `awk`/`gawk` ARGS load the inplace extension (`-i inplace`, `-iinplace`, `--include=inplace`). */
function awkInPlace(args) {
  const INPLACE = /^inplace(?:\.awk)?$/;
  for (let k = 0; k < args.length; k++) {
    const t = args[k].value;
    if (/^(?:-i|--include=)inplace(?:\.awk)?$/.test(t) || ((t === "-i" || t === "--include") && INPLACE.test(args[k + 1]?.value ?? ""))) return true;
    if (/^(?:-[ifvFe]|--(?:include|file|assign|field-separator|source))$/.test(t)) { k++; continue; }
    if (/^--source=/.test(t)) continue;
    if (!t.startsWith("-") || t === "--") return false; // the program text: later words are operands
  }
  return false;
}

const DEVICE_TARGETS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"]);

/** A temp path: it has a `tmp/` segment, the last `tmp/` is not followed by `worktrees`, and it has no `..` and no variable. */
function isTempPath(path) {
  const at = path.lastIndexOf("tmp/");
  return at >= 0 && (at === 0 || path[at - 1] === "/") && !path.slice(at + 4).startsWith("worktrees") && !/(?:^|\/)\.\.(?:\/|$)/.test(path) && !path.includes("$");
}

/** The text of a parsed word: quotes and backslashes removed, every expansion read as `$`. Returns `{ value, start, quoted }`. */
function wordOf(word) {
  const text = (p) => (p.type === "Lit" ? p.value.replace(/\\(.)/gs, "$1") : p.type === "SglQuoted" ? p.value : p.type === "DblQuoted" ? p.parts.map(text).join("") : p.type === "ParamExp" ? `$${p.param?.value ?? ""}` : "$");
  const dynamic = (p) => (p.type === "DblQuoted" ? p.parts.some(dynamic) : p.type !== "Lit" && p.type !== "SglQuoted");
  // bash expands the head word before it looks the command up: ANSI-C quoting and unquoted `{ * ? [` (brace and pathname expansion) can spell any binary name
  // a brace needs a comma or `..` inside to expand, so a literal `{}` stays a name
  const bare = word.parts.map((p) => (p.type === "Lit" ? p.value.replace(/\\./gs, "") : "\0")).join("");
  const expandsToName = word.parts.some((p) => p.type === "SglQuoted" && p.dollar) || /[*?[]|\{[^}]*(?:,|\.\.)[^}]*\}/.test(bare);
  return { value: word.parts.map(text).join(""), start: word.start, procSubsts: word.parts.filter((p) => p.type === "ProcSubst"), quoted: word.parts.some((p) => p.type === "SglQuoted" || p.type === "DblQuoted"), expandsToName, dynamic: word.parts.some(dynamic) };
}

/** Whether WORDS is `env` with a split-string option (`-S`, a cluster holding `S`, `--split-string`): env runs its operand as a command line the gate cannot read, so it denies. */
function envSplitString(words) {
  let w = words;
  while (ENV_ASSIGNMENT_WORD_RE.test(w[0]?.value ?? "")) w = w.slice(1);
  if ((w[0]?.value ?? "").split("/").pop() !== "env") return false;
  for (let i = 1; i < w.length; i++) {
    const { value } = w[i];
    if (/^-[A-Za-z]*S/.test(value) || /^--split-string(=|$)/.test(value)) return true;
    if (/^(?:-[uCPa]|--(?:unset|chdir|argv0))$/.test(value)) i++; // the option's value is the next word
    else if (!value.startsWith("-")) return false;
  }
  return false;
}

const DURATION_WORD_RE = /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?[smhd]?$/i;
/** WORDS from the command head on: env assignments, `timeout [options] DURATION` and the `WRAPPER_BINARIES` with their flags are skipped (`stripLeadingWrappers` on a word list, so no quote ever pairs across words). */
function stripWordWrappers(words) {
  for (let w = words; ;) {
    while (ENV_ASSIGNMENT_WORD_RE.test(w[0]?.value ?? "")) w = w.slice(1);
    const head = (w[0]?.value ?? "").split("/").pop();
    let rest;
    if (/^g?timeout$/i.test(head)) {
      let i = 1;
      for (let v; (v = w[i]?.value) !== undefined && /^-{1,2}[\w-]+(?:=.*)?$/.test(v); i++) if (!v.includes("=") && DURATION_WORD_RE.test(w[i + 2]?.value ?? "") && !w[i + 1].value.startsWith("-")) i++; // an option value, when a duration follows it
      rest = DURATION_WORD_RE.test(w[i]?.value ?? "") ? w.slice(i + 1) : [];
    } else if (WRAPPER_BINARIES.has(head)) {
      if (envSplitString(w)) return w; // stop at the `env -S` word: `visit` denies it
      rest = w.slice(1);
      while (rest[0]?.value.startsWith("-")) {
        const bare = /^(?:-[A-Za-z]|--[\w-]+)$/.test(rest[0].value);
        rest = rest.slice(1);
        if (bare && rest.length > 1 && !rest[0].value.startsWith("-") && !WRAPPER_FLAG_TARGETS.has(rest[0].value.replace(/^.*\//, ""))) rest = rest.slice(1);
      }
    }
    if (!rest?.length) return w;
    w = rest;
  }
}

/** WORDS from the command head on by the `SHELL_EXEC_PREFIX` reading: env assignments, `command`, `exec` and `env` with its option forms (`env -i node`), in any case. */
function stripExecPrefix(words) {
  for (let w = words; ;) {
    while (ENV_ASSIGNMENT_WORD_RE.test(w[0]?.value ?? "")) w = w.slice(1);
    const head = (w[0]?.value ?? "").toLowerCase();
    if (head === "command" || head === "exec" || head === "builtin") { w = w.slice(1); continue; }
    if (head !== "env") return w;
    w = w.slice(1);
    for (let v; (v = w[0]?.value) !== undefined;) {
      if (ENV_ASSIGNMENT_WORD_RE.test(v) || /^(?:-i|--ignore-environment|--|-|-[uCS].+|--(?:unset|chdir|split-string)=.*)$/.test(v)) w = w.slice(1);
      else if (/^(?:-[uCS]|--(?:unset|chdir|split-string))$/.test(v)) w = w.slice(2);
      else break;
    }
  }
}

/** Index in TAIL (the words from the head on) of the first word the shell runs as command text: the words after `eval`, a `-c` cluster, `git -x`/`--exec`, or every argument of `watch`/`trap`. Text readers (`TEXT_CONSUMER_RE`) have none. */
function payloadStart(tail, head) {
  if (/^(?:watch|trap)$/.test(head)) return 1;
  if (TEXT_CONSUMER_RE.test(head)) return Infinity;
  const at = tail.findIndex((w) => w.value === "eval" || EXEC_FLAG_RE.test(w.value) || (head === "git" && /^(?:-x|--exec(?:=.*)?)$/.test(w.value)));
  return at < 0 ? Infinity : at + (tail[at].value.startsWith("--exec=") ? 0 : 1);
}

/** Heads whose quoted arguments are inert text when the command is one simple command (`inertQuoteSegment`'s list). */
const TEXT_HEAD_RE = /^(?:echo|printf|cat|tee|grep|rg|head|tail|wc|sort|test|dev-loops-run)$/;
const WRITE_REDIRECTS = ["RdrOut", "AppOut", "RdrInOut", "RdrClob", "AppClob", "RdrAll", "RdrAllClob", "AppAll"];

/**
 * One walk over every simple command of COMMAND's syntax tree (substitutions, process substitution, function bodies, `case` arms,
 * `coproc` and unquoted heredoc bodies included; a quoted-delimiter heredoc body is inert text). The command head is read from the
 * parsed word list after env assignments and wrappers. Returns `{ deny, ceiling, parseError }`:
 * deny when a closed-list form (issue 2442 item 10) sits in a simple command, or when the text does not parse;
 * with REPORT, ceiling when a form sits where the gate does not read: a pipe or `-`/here-string stdin into an interpreter, a payload word
 * (`-c`, `eval`, `watch`, a here-string), a heredoc body or quoted word that a non-inert command carries.
 * SKIP_FIRST ignores the first simple command (the first command of a quoted word is text, a later one follows a separator).
 */
function inspectShell(command, report = false, skipFirst = false) {
  const parsed = parseShell(command);
  if (parsed.error) {
    // every parse failure denies: bash runs the lines before a syntax error, so a text match on the head would fail open (ADR 0276)
    return { deny: true, ceiling: false, parseError: parsed.error.message };
  }
  const { redir: R, binCmd: B } = shellOperators();
  const out = { deny: false, ceiling: false, parseError: null };
  const pipedOut = new Set(); // statements that feed a pipe
  const pipeSource = new Map(); // a statement fed by a pipe -> its feeder
  const written = []; // lowercased paths that a cat/tee heredoc writes
  const ends = (s, side) => (s.cmd?.type === "BinaryCmd" ? ends(s.cmd[side], side) : s);
  const isHeredoc = (r) => r.op === R.Hdoc || r.op === R.DashHdoc;
  const isStdinText = (r) => isHeredoc(r) || r.op === R.WordHdoc; // a heredoc or here-string: the text a cat/tee writes
  const formIn = (text, skip) => inspectShell(text, false, skip).deny;
  const alone = parsed.file.stmts.length === 1 && parsed.file.stmts[0].cmd?.type === "CallExpr"; // the whole command is one simple command
  const runChecks = []; // write-then-run checks, run once the walk ends: a backgrounded or piped runner before the write runs after it
  // a `<(...)` holding a heredoc or here-string, among an interpreter's words, is text it runs as a script or preload (origin/main denied every such word)
  const procHeredoc = (w) => (w?.procSubsts ?? []).some((p) => { let hit = false; walkShell(p, (n) => { if (n.type === "Stmt" && (n.redirs ?? []).some(isStdinText)) hit = true; return !hit; }); return hit; });
  let depth = 0; // open substitutions
  let skipping = skipFirst;
  const visit = (node, stmt) => {
    const words = node.args.map(wordOf);
    const redirs = stmt.redirs ?? [];
    const stdin = {}; // any fd: `node --stack-size 2000<<EOF` reads `2000<<` as an fd redirect, which origin/main denied
    for (const r of redirs) { if (isHeredoc(r)) stdin.heredoc ??= r.start; else if (r.op === R.WordHdoc) stdin.herestring ??= r.start; }
    const tails = [stripWordWrappers(words), stripExecPrefix(words)].filter((t) => t.length);
    if (skipping) { skipping = false; return; }
    if (tails.some(envSplitString)) out.deny = true;
    for (const tail of tails) {
      // a head that bash expands first (ANSI-C quote, brace/glob) can name any binary: deny. A parameter expansion or substitution in the head is a reported ceiling.
      if (tail[0].expandsToName && tail[0].value !== "[") out.deny = true;
      if (tail[0].dynamic) out.ceiling = true;
      const head = tail[0].value.split("/").pop().toLowerCase();
      const args = tail.slice(1);
      const form = INTERPRETER_HEAD_RE.test(head) ? interpreterForm(head, args, stdin) : null;
      if (form === "code" || form === "inplace" || form === "heredoc" || (/^g?sed$/.test(head) && sedInPlace(args)) || (/^g?awk$/.test(head) && awkInPlace(args))) out.deny = true;
      if (form === "dash" || form === "herestring" || (form === "stdin" && pipeSource.has(stmt))) out.ceiling = true;
      // only the script word of a runner runs the file; a written file later in the args is data (`node s.mjs --body-file tmp/b.md`)
      const script = { loaded: [] };
      if (INTERPRETER_HEAD_RE.test(head)) { interpreterForm(head, args, stdin, script); if (args.some(procHeredoc) || redirs.some((r) => (r.op === R.RdrIn || r.op === R.RdrInOut) && (!r.n || r.n.value === "0") && procHeredoc(wordOf(r.word)))) out.deny = true; }
      else if (FILE_RUNNER_HEAD_RE.test(head)) { // sh/bash/zsh: skip `-o`/`-O`/`+o`/`+O` option values and `+x` words
        for (let k = 0; k < args.length; k++) {
          if (/^[-+][A-Za-z]*[oO]$/.test(args[k].value)) { k++; continue; } // a cluster ending in o (`-euo pipefail`) takes the next word as its value
          if (!/^[-+]/.test(args[k].value)) { script.script = args[k]; break; }
        }
      }
      // `sh < tmp/r.sh`, `node < tmp/r.mjs`: with no script word, a stdin redirect is the script, for every runner
      const stdinFile = redirs.find((r) => (r.op === R.RdrIn || r.op === R.RdrInOut) && (!r.n || r.n.value === "0"));
      if (FILE_RUNNER_HEAD_RE.test(head) && !script.script && stdinFile) script.script = wordOf(stdinFile.word);
      // compared when the command ends: bash expands the substitutions in its words first, so a heredoc write in one of them comes before the run
      const isWritten = (w) => !!w && written.includes(normPath(w.value));
      runChecks.push(() => { if (isWritten(tail[0]) || isWritten(script.script) || script.loaded.some(isWritten)) out.deny = true; });
      // a tee that receives a pipe from a cat heredoc segment is the heredoc write (other heads write their own output, not the heredoc)
      const feeder = pipeSource.get(stmt);
      const fed = head === "tee" && feeder?.cmd?.type === "CallExpr" && feeder.redirs.some(isStdinText) && feeder.cmd.args.some((a) => wordOf(a).value.split("/").pop().toLowerCase() === "cat");
      if (/^(?:cat|tee)$/.test(head) && (redirs.some(isStdinText) || fed)) {
        // a redirect of another fd than 1 (`2>err.log`) is no heredoc write; `>&2` duplicates a descriptor; only an exact device name is no file write
        const targets = [...redirs.filter((r) => WRITE_REDIRECTS.some((n) => r.op === R[n]) && (!r.n || r.n.value === "1")).map((r) => wordOf(r.word).value), ...(head === "tee" ? args.filter((a) => !a.value.startsWith("-")).map((a) => a.value) : [])]
          .filter((t) => t && !/^\d+$|^-$/.test(t)).map((t) => t.replace(/^\.\//, "")).filter((t) => !DEVICE_TARGETS.has(t));
        written.push(...targets.map(normPath));
        if (targets.some((t) => !isTempPath(t))) out.deny = true;
      }
    }
    if (!report || out.deny) return;
    // ceiling: text the gate does not read. A cat/tee heredoc of a one-statement command is data; every other body, payload word and quoted word is read again as shell.
    const head0 = (tails[0]?.[0].value ?? "").split("/").pop().toLowerCase();
    const dataHost = alone && depth === 0 && !pipedOut.has(stmt) && node.assigns.length === 0 && /^(?:\/bin\/|\/usr\/bin\/)?(?:cat|tee)$/.test(words[0]?.value);
    const heredocBody = (r) => (isHeredoc(r) && r.hdoc?.parts.every((p) => p.type === "Lit") ? r.hdoc.parts.map((p) => p.value).join("") : null);
    // a heredoc that never reaches its delimiter has no readable body (origin/main denied it as incomplete)
    const unterminated = (r) => isHeredoc(r) && (!r.hdoc || (r.hdoc.parts.length > 0 && !(r.hdoc.parts.at(-1).type === "Lit" && r.hdoc.parts.at(-1).value.endsWith("\n"))));
    // a body is data when a top-level `gh` takes it unpiped (a PR or issue comment body; bash expands only `$()`, backticks and `${}` in it, and the walk reads those); any other host may write then run it, so its body stays read as shell
    // shortcut: only `gh` is a data head, widen the head set when another body-taking CLI shows up as a ceiling false positive
    // body-taking subcommands only: any other `gh` subcommand (`gh alias set --shell`) can run its body as shell
    const ghData = /^(?:pr (?:comment|create|edit|review)|issue (?:comment|create|edit)|api)$/.test((tails[0] ?? []).slice(1).filter((w) => !w.value.startsWith("-")).slice(0, 2).map((w) => w.value).join(" ").replace(/^api .*/, "api"));
    const bodyIsShell = !(head0 === "gh" && ghData && depth === 0 && !pipedOut.has(stmt));
    // a shell that reads a here-string built by a substitution runs text the gate cannot see
    if (FILE_RUNNER_HEAD_RE.test(head0) && redirs.some((r) => r.op === R.WordHdoc && wordOf(r.word).dynamic)) out.ceiling = true;
    if (redirs.some(unterminated) || (!dataHost && bodyIsShell && redirs.some((r) => heredocBody(r) !== null && formIn(heredocBody(r), false)))) out.ceiling = true;
    const tail0 = tails[0] ?? [];
    const from = words.length - tail0.length + payloadStart(tail0, head0);
    const hereWords = TEXT_CONSUMER_RE.test(head0) ? [] : redirs.filter((r) => r.op === R.WordHdoc).map((r) => wordOf(r.word));
    if ([...words.slice(from), ...hereWords].some((w) => formIn(w.value, false))) out.ceiling = true;
    const inert = alone && depth === 0 && !pipedOut.has(stmt) && !pipeSource.has(stmt) && node.assigns.length === 0 && !redirs.some((r) => WRITE_REDIRECTS.some((n) => r.op === R[n])) && !words[0]?.value.includes("/") && (TEXT_HEAD_RE.test(words[0]?.value) || (/^(?:node|bun)$/.test(words[0]?.value) && words[1]?.value.startsWith("scripts/")));
    const quoted = [...words.slice(0, from), ...node.assigns.map((a) => ({ ...(a.value ? wordOf(a.value) : { value: "" }), quoted: true }))].filter((w) => w.quoted);
    if (!inert && quoted.some((w) => formIn(w.value, true))) out.ceiling = true;
  };
  walkShell(parsed.file, {
    enter(node, parent) {
      if (out.deny && !report) return false;
      if (node.type === "CmdSubst" || node.type === "ProcSubst") depth++;
      if (node.type === "BinaryCmd" && (node.op === B.Pipe || node.op === B.PipeAll)) { pipedOut.add(ends(node.x, "y")); pipeSource.set(ends(node.y, "x"), ends(node.x, "y")); }
      if (node.type === "CallExpr" && parent?.type === "Stmt") visit(node, parent);
      return true;
    },
    exit(node) {
      if (node.type === "CmdSubst" || node.type === "ProcSubst") depth--;
    },
  });
  for (const check of runChecks) check();
  return out;
}

/** `inspectShell` on COMMAND and, when it holds a backslash-newline, on the text with each one removed: bash joins `$\`+newline+`(` into a live substitution that the parser reads as text. */
function inspect(command, report = false) {
  const first = inspectShell(command, report);
  if (first.deny || !command.includes("\\\n")) return first;
  const joined = inspectShell(joinContinuations(command), report);
  return joined.deny ? joined : first;
}

/**
 * OPS-NO-INLINE-INTERPRETER: whether the gate denies COMMAND (`inspectShell`): a closed-list form in any simple command of its syntax tree.
 * Actor-independent. Ceiling cases are allowed; `inlineInterpreterVerdict` reports them for `check-retro-tooling`.
 * @param {string} command @returns {boolean}
 */
export function commandContainsInlineInterpreter(command) {
  return inspect(command).deny;
}

/**
 * The verdict for COMMAND: "deny" when the gate denies it, "ceiling" when the gate allows a form it does not read (reported after the fact), else "allow".
 * @param {string} command @returns {"deny"|"ceiling"|"allow"}
 */
export function inlineInterpreterVerdict(command) {
  const { deny, ceiling } = inspect(command, true);
  return deny ? "deny" : ceiling ? "ceiling" : "allow";
}

/** The parse error message when the gate denies COMMAND because it does not parse, else null. */
export function inlineInterpreterParseError(command) {
  const { deny, parseError } = inspectShell(command);
  return deny ? parseError : null;
}

/**
 * A package-manager `test`/`verify`/`build` script/task invocation, the `run` keyword optional
 * (`npm test`, `npm run test`, `bun run verify`, `yarn build`, `pnpm run build`, ...). Anchored on
 * the executable HEAD (env-assignment/wrapper/path/nice/timeout prefix tolerated via
 * `VERIFY_EXEC_PREFIX`) so a path that merely contains the word "test" (`cat test/foo.test.mjs`)
 * never matches — the head token must literally be one of these four package-manager binaries.
 *
 * Tolerates a run of binary flags between the binary and `run`/the script name (`bun --bun run
 * verify`), and a `:`-namespaced sub-script (`test:extension`, `test:core`, `verify:docs`, ...) —
 * the tail is `(?:[:\s]|$)` rather than `(?:\s|$)` so `npm run test:unit` / `yarn test:ci` match
 * while `npm run build-docs` (hyphen form, a genuinely different script name) still does not.
 */
const PACKAGE_MANAGER_VERIFY_RUN_RE = new RegExp(
  `^${VERIFY_EXEC_PREFIX}(?:bun|npm|yarn|pnpm)(?:\\s+--\\S+)*\\s+(?:run\\s+)?(?:test|verify|build)(?:[:\\s]|$)`,
  "i",
);

/**
 * `vitest` run directly (any args: `vitest`, `vitest run`, `vitest --coverage`), or via the
 * `npx`/`bunx` package-runner (`npx vitest run`, `bunx vitest`) or `bun`'s `x` subcommand
 * (`bun x vitest`).
 */
const VITEST_RE = new RegExp(`^${VERIFY_EXEC_PREFIX}(?:(?:npx|bunx)\\s+|bun\\s+x\\s+)?vitest(?:\\s|$)`, "i");

/**
 * COORDINATOR-VERIFY-BOUNDARY: whether `command` contains a known code-verification/
 * build entrypoint in ANY shell segment — `bun test`/`bun run verify`/`bun run build`, `vitest`,
 * `npm test`/`npm run test`/`npm run build`, and the `yarn`/`pnpm` `test`/`build` equivalents
 * (with or without the `run` keyword). PreToolUse gate use only: the dev-loop COORDINATOR must
 * delegate these to a fresh WORKER subagent instead of running them inline; a worker subagent may
 * run them freely (the actor scoping lives in `decideBashGate`, not here).
 *
 * Compact orchestration commands the coordinator MAY still run inline never match — their head
 * token is not a package-manager binary or `vitest` (`dev-loops queue list`, `gh pr checks --json
 * --jq`, `detect-checkpoint-evidence`, `git log --oneline -1`, `git status --short`).
 * @param {string} command @returns {boolean}
 */
export function commandContainsCodeVerificationEntrypoint(command) {
  return shellSegments(command).some((segment) => PACKAGE_MANAGER_VERIFY_RUN_RE.test(segment) || VITEST_RE.test(segment));
}

/**
 * Decision-recorder classification (OPERATOR-DECISION-RECORDER). Fails closed. A segment names the recorder when,
 * after quotes and backslashes are stripped and backslash-newline continuations are joined, it holds a word ending
 * in `record-operator-decision.mjs`, or the words `decision record` next to a launcher word (`dev-loops`,
 * `dev-loops-run`, or a `cli/index.mjs` entrypoint under any runner). `canonical` is true only for a raw segment
 * that starts byte for byte with `dev-loops-run cli/index.mjs decision record ` (single spaces, no continuation).
 * The `--repo-root` spelling is never canonical: its `permissions.ask` pattern is unverified in a live session.
 * Returns null when no segment names the recorder.
 * shortcut: a quoted `decision record` data word beside a launcher word counts as a mention, so a note that quotes
 * the command is denied too, unless the segment is a plain file command (`grep`, `git commit -m`) with no nested run; judging quotes would need the full tokenizer.
 * @param {string} command @returns {{canonical: boolean}|null}
 */
export function classifyDecisionRecorderCommand(command) {
  const continued = /\\\r?\n/.test(command);
  const segments = shellSegments(command.replace(/\\\r?\n/g, ""));
  let found = null;
  for (const segment of segments) {
    const stripped = [stripLeadingWrappers(segment), stripLeadingWrappers(segment, LAUNCHER_FLAG_TARGETS)];
    // Lowercase: a case-insensitive filesystem runs `Record-Operator-Decision.mjs` or `CLI/Index.mjs`. Only `canonical` below stays byte-exact.
    const words = segment.replace(/['"\\]/g, "").toLowerCase().split(/\s+/);
    // A file command (`git add`, `rg`) that only names the recorder source is no recorder spelling (ADR 0295: the path under a runner).
    // shortcut: an allow-list of plain file commands, not of runners, so `bash -c 'node ...'` and `xargs` stay denied as before; widen it when another plain file command is blocked.
    // A nested run keeps the segment a recorder spelling: command or process substitution, or a git exec option (`-x`, `--exec`, `bisect run`, `-c key=value`, `--pre`, `--extcmd`, `--ext-diff`, `submodule foreach`, `-O`, `--open-files-in-pager`, a `--*-filter` or `--*-cmd` option, `--upload-pack`, `--receive-pack`, `-u`, a `GIT_*=` or `*PAGER=` env prefix).
    const nestedRun = /\$\(|`|[<>]\(|\s-x\b|--exec\b|\bbisect\s+run\b|alias\.[^\s=]*=["']?!|\s-c\s+\S+=|--pre\b|--extcmd\b|--ext-diff\b|\bsubmodule\s+foreach\b|\s-O|--open-files-in-pager\b|--[\w-]*-filter\b|--[\w-]*-cmd\b|--(?:upload|receive)-pack\b|\s-u\b|^\s*(?:\w+=\S*\s+)*(?:GIT_\w*|\w*PAGER)=/i.test(segment);
    const fileCommand = !nestedRun && stripped.some((s) => /^(?:git|rg|grep|cat|ls|head|tail|wc|diff|stat)$/.test(s.split(/\s+/)[0].replace(/['"\\]/g, "").toLowerCase().replace(/^.*\//, "")));
    const script = !fileCommand && words.some((w) => w.endsWith("record-operator-decision.mjs"));
    const at = words.findIndex((w, i) => w === "decision" && words[i + 1] === "record");
    const cli = !fileCommand && at >= 0 && words.slice(0, at).some((w) => /(?:^|\/)(?:dev-loops(?:-run)?|index\.mjs)$/.test(w));
    if (!script && !cli && !stripped.some((s) => hasUnreadableLauncherWord(s.split(/\s+/)))) continue;
    const canonical = !script && !continued && segments.length === 1 && segment.startsWith("dev-loops-run cli/index.mjs decision record ");
    found = { canonical: found?.canonical !== false && canonical };
  }
  return found;
}

/**
 * Whether a `*`/`?` glob matches `target` or a `/`-suffix of it, in linear time (no backtracking RegExp, so no ReDoS).
 */
function globMatchesSuffix(glob, target) {
  const starts = [0, ...[...target].flatMap((c, i) => (c === "/" ? [i + 1] : []))];
  return starts.some((start) => {
    const gl = glob;
    const t = target.slice(start);
    let g = 0, i = 0, star = -1, mark = 0;
    while (i < t.length) {
      if (g < gl.length && (gl[g] === "?" || gl[g] === t[i])) { g++; i++; }
      else if (g < gl.length && gl[g] === "*") { star = g++; mark = i; }
      else if (star >= 0) { g = star + 1; i = ++mark; }
      else return false;
    }
    while (gl[g] === "*") g++;
    return g === gl.length;
  });
}

/**
 * Whether a `dev-loops-run`, `node`, `bun` or bare `dev-loops` segment has a script word, or namespace and action words after `cli/index.mjs`, that the
 * shell could expand to the recorder: a word outside `^[A-Za-z0-9_./-]+$` (`decision$IFS record`, `$'decision' record`,
 * `{decision,} record`) or a glob that matches the recorder script or the words `decision` and `record`
 * (`record-operator-*.mjs`). A glob that cannot match them (`scripts/*\/validate-decision-records.mjs`) stays allowed.
 */
function hasUnreadableLauncherWord(rawWords) {
  const raw = rawWords.map((w) => w.toLowerCase());
  // Only a segment head counts (callers strip env assignments and launch wrappers with stripLeadingWrappers), so quoted prose that mentions a launcher stays allowed.
  const at = 0;
  const head = raw[at];
  const isRunner = /(?:^|\/)(?:node|bun)$/.test(head);
  const isRun = /(?:^|\/)dev-loops-run$/.test(head);
  const isBare = /(?:^|\/)dev-loops$/.test(head);
  if (!isRunner && !isRun && !isBare) return false;
  let i = at + 1;
  if (isRun && raw[i] === "--repo-root") {
    // The value is one shell word: a quoted value spans to its closing quote, so a checkout path with a space stays one word.
    let end = i + 1;
    const quote = /^["']/.test(raw[end] ?? "") ? raw[end][0] : null;
    if (quote && !raw[end].includes(quote, 1)) {
      // The closing quote may sit inside a word (`"/a b"/r`); no closing word before the end is unreadable, so deny.
      while (end < raw.length - 1 && !raw[++end].includes(quote));
      if (!raw[end].includes(quote, end === i + 1 ? 1 : 0)) return true;
    }
    i = end + 1;
  }
  const hides = (w, target) => {
    if (w === undefined || /^[A-Za-z0-9_./-]+$/.test(w)) return false;
    if (!/^[A-Za-z0-9_./*?[\]-]+$/.test(w)) return true;
    // A word with many wildcards is not a plausible program argument, so it fails closed.
    if (w.replace(/[^*?]/g, "").length > 8) return true;
    // A bare `*.ext` glob has no literal stem, so it is data for the program, not the recorder.
    if (/^[*?]+\.[A-Za-z?*]+$/.test(w)) return false;
    // A bracket class could match the recorder word, so it fails closed.
    return w.includes("[") || globMatchesSuffix(w, target);
  };
  // Whether a word outside `^[A-Za-z0-9_./-]+$` could expand to `target`: a run of unreadable characters (`~`, `$E`) counts as `*`, and a `~`, `$HOME` or absolute prefix before a literal `cli/` or `scripts/` segment is dropped.
  const couldBe = (w, target) => {
    const s = w.replace(/^.*\/(?=(?:cli|scripts)\/)/, "").replace(/\$\{?[A-Za-z0-9_]+\}?/g, "*").replace(/[^A-Za-z0-9_./*?[\]-]+/g, "*");
    return s.includes("[") || globMatchesSuffix(s, target);
  };
  // A word that could expand to `cli/index.mjs` is the entrypoint (fail closed). Only a following `decision record` denies it.
  const isCli = (w) => !w.startsWith("-") && (w.endsWith("cli/index.mjs") || (!/^[A-Za-z0-9_./-]+$/.test(w) && couldBe(w, "cli/index.mjs")));
  // A word with a literal part that could expand to the recorder script. A bare `*.ext` glob or an all-unreadable word has no literal stem, so it is data.
  const hitsScript = (w) => !/^[A-Za-z0-9_./-]+$/.test(w) && /[A-Za-z0-9]/.test(w.replace(/\$\{?[A-Za-z0-9_]+\}?/g, "*")) && !/^[*?]+\.[A-Za-z?*]+$/.test(w) && couldBe(w, "scripts/github/record-operator-decision.mjs");
  if (isRunner) {
    // Scan to the first word that is a cli/index.mjs entrypoint or a glob or unreadable word, so runner flag values need no grammar. An inline-code flag, a `bun x` package binary or another script word ends the scan: what follows is data for that program.
    // Every candidate is checked, so an empty-expanding `$X` before a glob entrypoint hides nothing.
    for (let j = at + 1; j < raw.length; j++) {
      const w = raw[j];
      if (/^(?:-[ep]|--eval|--print)$/.test(w) || (w === "x" && raw[j - 1] === head)) break;
      if (hitsScript(w)) return true;
      if (isCli(w) && (hides(raw[j + 1], "decision") || hides(raw[j + 2], "record") || (raw[j + 1] === "decision" && raw[j + 2] === "record"))) return true;
      // A script word right after a flag is that flag's value (`--loader ./l.mjs`), so the scan goes on.
      if (/\.[cm]?[jt]s$/.test(w) && !/^-/.test(raw[j - 1])) break;
    }
    return false;
  }
  if (raw[i] === undefined) return false;
  if (isBare) return hides(raw[i], "decision") || (raw[i] === "decision" && hides(raw[i + 1], "record"));
  if (hides(raw[i], "scripts/github/record-operator-decision.mjs") || hitsScript(raw[i])) return true;
  return isCli(raw[i]) && (hides(raw[i + 1], "decision") || hides(raw[i + 2], "record") || (raw[i + 1] === "decision" && raw[i + 2] === "record"));
}
