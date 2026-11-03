/**
 * Pure classification of shell command strings for the dev-loop gate boundary.
 *
 * Shared by the Pi extension (`extension/post-merge-update.ts`, which re-exports these so its
 * behavior is unchanged) and the Claude Code PreToolUse Bash hook. Keeping one source of truth
 * means the `gh pr ready` / merge detection is identical across harnesses.
 *
 * Pure and side-effect free.
 */

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
 * (`gh issue create --body "while … sleep … done"` must not be flagged). The `s` (dotAll) flag lets
 * `.` match a newline too, so a MULTI-LINE quoted `--body` (a real issue body commonly spans lines) is
 * stripped in full, not just its first line.
 * A quoted string that itself contains a command substitution (`$(...)`) or a backtick (`` `...` ``)
 * is executable code, not inert data — its inner command runs regardless of the surrounding quotes.
 * Blanking it would hide a real poll loop such as `while [ "$(gh pr view 5)" != MERGED ]; do sleep 5;
 * done` that the gh/loop-state ban already denies, so such a quoted literal is PRESERVED (fail-closed
 * direction) ahead of the `-c`/`--command`/`eval` exemption check below.
 *
 * The `-c`-cluster/`--command`/`eval` exemption is intentionally coarse in the fail-closed direction:
 * it looks only for a `c` anywhere in a preceding short-flag cluster (or `--command`/`eval`), not for
 * a shell-interpreter anchor. A non-shell command carrying `-c` (e.g. `grep -ci '<loop text>'`,
 * `wc -c`) may therefore have its quoted argument preserved too and get over-denied — an accepted
 * benign false positive, because tightening the exemption to a shell-interpreter anchor would risk a
 * fail-open (missing a real `sh -c` poll loop), the worse direction.
 *
 * When `hasQuotePairingHazard(command)` is true the function returns the command unchanged (fail
 * closed); otherwise it blanks the quote spans from `tokenizeShellCommand`. Text from an unterminated quote,
 * `$(` or heredoc onward is left as raw executable text (deny direction). Accepted ceiling: a
 * deliberately quoted structural keyword (e.g. `"sleep"`) placed inside a real UNQUOTED loop is
 * blanked like any other quoted literal and can therefore evade the ban.
 * @param {string} command @returns {string}
 */
function stripQuotedLiterals(command) {
  const { spans, incompleteAt } = tokenizeShellCommand(command);
  if (hasQuotePairingHazard(command)) return command;
  const limit = incompleteAt < 0 ? command.length : incompleteAt;
  let out = "";
  let pos = 0;
  for (const { start, end } of [...spans].sort((a, b) => a.start - b.start)) {
    if (start < pos || start >= limit) continue; // nested in a span already handled, or in the unterminated tail (kept as a guard: a backtick span can start past the opener without a quote)
    const kept =
      /\$\(|`/.test(command.slice(start + 1, end - 1)) || // executable code in quotes: preserve (fail-closed)
      /(?:^|\s)(?:-[A-Za-z]*c[A-Za-z]*(?:\s+--)?|--command|eval)\s*$/.test(command.slice(0, start)); // -c/eval payload: real shell syntax
    out += command.slice(pos, start) + (kept ? command.slice(start, end) : " ");
    pos = end;
  }
  return out + command.slice(pos);
}

/**
 * The stripper stays strictly fail-closed against the frozen differential oracle: where the old regex mispaired
 * quotes, `stripQuotedLiterals` blanks nothing, and a caller that would read the unblanked text as more permissive
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
            h.body = command.slice(bodyStart, Math.max(bodyStart, lineStart - 1));
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
      else if (c === "|" && next === "&") { endSeg(); i += 2; }
      else if (c === ";" || (c === "|" && !(word && command[i - 1] === ">")) || (c === "&" && !redirectChar && next !== ">")) { endSeg(); i++; }
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

const SLEEP_WRAPPERS = new Set(["nohup", "nice", "stdbuf", "exec", "busybox", "env", "time", "sudo", "xargs", "timeout", "command", "ionice", "setsid"]);
const SLEEP_LOOP_SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

/**
 * Whether COMMAND holds a `while`/`until`/`for` loop whose body runs `sleep`, whatever the loop condition.
 * Reads tokenizer segments, so quoted literals and heredoc bodies never count; `eval` and `sh|bash|zsh -c`
 * payloads are checked again as shell. An incomplete parse fails closed on raw text.
 * A `sh|bash|zsh|dash|ksh [flags] -c` payload is found at any word position, so `env -i`, `nice -n` and `xargs -I{}` wrappers do not hide it.
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
  const SKIP = /^(?:do|then|\{|command|!|else|elif|if|\()$/;
  // Index of the normalized head word at or after k, and the head itself.
  const headAt = (words, k) => {
    while (k < words.length && (SKIP.test(words[k]) || /^[A-Za-z_]\w*=/.test(words[k]))) k++;
    if (k >= words.length) return { j: k, head: undefined };
    const w = [words[k].replace(/^\(+/, ""), ...words.slice(k + 1)];
    const rest = stripLeadingWrappers(w.join(" "));
    let j = 0;
    for (let i = 0; i < w.length; i++) if (stripLeadingWrappers(w.slice(i).join(" ")) === rest) j = i;
    return { j: k + j, head: rest.split(/\s+/, 1)[0] };
  };
  const base = (w) => w.replace(/^[<>]?\(+/, "").replace(/^.*\//, "");
  const LOOP = /^(?:while|until|for)\b/;
  const flat = (segs) => {
    for (const seg of segs) {
      const words = seg.words.map((w) => w.value);
      const { j, head } = headAt(words, 0);
      heads.push(LOOP.test(head ?? "") ? "while" : head);
      if (/^(?:while|until)$/.test(head ?? "")) heads.push(headAt(words, j + 1).head);
      // A loop opened mid-segment: after a `{` (function body) or inside `<(` / `>(` (process substitution).
      words.forEach((w, i) => {
        if (((i > 0 && words[i - 1] === "{") || /^[<>]\(/.test(w)) && LOOP.test(w.replace(/^[<>]?\(+/, ""))) heads.push("while");
      });
      // A sleep behind a wrapper that takes flags (`nice -n 10 sleep`, `stdbuf -o0 sleep`) or detaches (`nohup`, `exec`).
      let k = 0;
      while (k < words.length && (SKIP.test(words[k]) || /^[A-Za-z_]\w*=/.test(words[k]))) k++;
      // Sleep counts only as the command word: after the wrapper, flags (a one-letter flag takes one argument), numbers and nested wrappers are skipped.
      if (k < words.length && SLEEP_WRAPPERS.has(base(words[k]))) {
        let m = k + 1;
        while (m < words.length && base(words[m]) !== "sleep") {
          const x = words[m];
          if (/^-[a-zA-Z]$/.test(x) && m + 1 < words.length && base(words[m + 1]) !== "sleep") m++;
          else if (!/^-/.test(x) && !/^\d+[smhd]?$/.test(x) && !/^[A-Za-z_]\w*=/.test(x) && !SLEEP_WRAPPERS.has(base(x))) break;
          m++;
        }
        if (m < words.length && base(words[m]) === "sleep") heads.push("sleep");
      }
      const payloads = [];
      if (head === "eval") payloads.push(words.slice(j + 1).join(" "));
      // A `<shell> [flags] -c <payload>` anywhere in the segment, whatever wrapper (`env -i`, `nice -n`, `xargs -I{}`) precedes it.
      words.forEach((w, i) => {
        if (!SLEEP_LOOP_SHELLS.has(base(w))) return;
        // First later `-c` word, so a shell option with an argument (`bash -o pipefail -c`) does not hide the payload.
        const c = words.findIndex((x, n) => n > i && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(x));
        if (c > 0 && words[c + 1] !== undefined) payloads.push(words[c + 1]);
      });
      if (payloads.some((p) => commandIsSleepLoop(p))) heads.push("while", "sleep");
      for (const w of seg.words) for (const s of w.subs) flat(s.segments);
    }
  };
  flat(segments);
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

  // (1) Unconditional detach-wrapper ban — no wait/probe-family requirement.
  const hasDetachWrapper = shellSegments(command).some((segment) => {
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
  if (!commandHasBareBackgroundOperator(whole)) {
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
const WRAPPER_BINARIES = new Set(["sudo", "env", "xargs", "time", "nice", "command"]);

/**
 * Strip prefixes that hide the real command head, fail-closed (over-report is
 * fine, under-report is the bug):
 *   - leading `NAME=value ` env-assignment tokens (any number)
 *   - leading wrapper binaries (`sudo`, `env`, `xargs`, ...) — recurse on the rest
 *   - a path-prefixed binary (`./x/gh`, `/usr/bin/python3`) → reduce head to its basename
 * Returns the segment with a bare, classifiable command head.
 */
export function stripLeadingWrappers(segment) {
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
  if (TIMEOUT_PREFIX.test(s)) return stripLeadingWrappers(s.replace(TIMEOUT_PREFIX, ""));
  // (b) strip a leading wrapper binary, then re-normalize the remainder
  const head = s.split(/\s+/, 1)[0];
  if (WRAPPER_BINARIES.has(head)) {
    const rest = s.slice(head.length).trim();
    if (rest.length > 0) return stripLeadingWrappers(rest);
  }
  return s;
}

/** Build a `node`/`python`/`python3` command-head matcher (env/wrapper/path prefix tolerated). */
function interpreterRegex(bin) {
  return new RegExp(`^${SHELL_EXEC_PREFIX}${bin}(?:\\s|$)`, "i");
}

// Bare `-` stdin script, or a heredoc token (`<<EOF`, `-<<EOF`, or one attached to a flag: `-I<<EOF`).
const isStdinScriptToken = (t) => /^-[)`"]*$/.test(t) || t.startsWith("<<") || (t.startsWith("-") && t.includes("<<")) || (REDIRECTION_RE.test(t) && t.includes("<<"));
// A redirection token (`2>&1`, `2>/dev/null`, `>out`, `&>x`) between flags and the heredoc is not the script path. Returns how many tokens to skip: 0 (not a redirection), 1, or 2 (operator alone, its target is the next token).
const REDIRECTION_RE = /^(?:\d*(?:>>?|<|>&)|&>>?)/;
const REDIRECTION_OPERATOR_ONLY_RE = /^(?:\d*(?:>>?|<|>&)|&>>?)$/;
const redirectionSkip = (t) => (!t.includes("<<") && REDIRECTION_RE.test(t) ? (REDIRECTION_OPERATOR_ONLY_RE.test(t) ? 2 : 1) : 0);
const QUOTE_AWARE_TOKEN_RE = /(?:\\.|\$'(?:\\.|[^'\\])*'|[^\s'"\\]|'[^']*'|"(?:\\.|[^"\\])*")+/g; // `\\.` first: an escaped character never opens or closes a quoted span
// The shell removes quotes and backslash escapes before the interpreter sees an argument, so `'-e'`, `"--eval"` and `\-e` are the flags `-e`/`--eval`. Normalize each token the same way before any flag or stdin check.
const unshellToken = (t) => t.replace(/\\(.)|\$'((?:\\.|[^'\\])*)'|'([^']*)'|"((?:\\.|[^"\\])*)"/g, (_m, a, d, b, c) => a ?? d?.replace(/\\(.)/g, "$1") ?? b ?? c.replace(/\\(.)/g, "$1")); // `$'...'` is ANSI-C quoting: one word, backslash escapes unescaped
const unshellTokens = (code) => (code.match(QUOTE_AWARE_TOKEN_RE) ?? []).map(unshellToken);
const SCRIPT_EXT_RE = /\.(?:[cm]?js|[cm]?ts)$/;
// Closed allow-list of known boolean node flags: the token after one is the script, not a value. Any unlisted `--flag` is treated as value-taking (the refusing direction), so a new value-taking flag can never slip through as boolean.
const NODE_BOOLEAN_FLAGS = new Set(["--no-warnings", "--no-deprecation", "--trace-warnings", "--trace-deprecation", "--trace-uncaught", "--enable-source-maps", "--experimental-vm-modules", "--experimental-strip-types", "--experimental-transform-types", "--experimental-detect-module", "--experimental-require-module", "--experimental-websocket", "--experimental-sqlite", "--experimental-permission", "--permission", "--watch", "--expose-gc", "--abort-on-uncaught-exception", "--pending-deprecation", "--throw-deprecation", "--no-experimental-fetch"]);

/**
 * Blank literal shell text with same-length spaces so offsets in `out` index the input: comments,
 * backslash-escaped characters and single-quoted/ANSI-C (`$'...'`, where a backslash escapes the
 * next character) spans. `quoted[i]` is true when char i sits in a quote or comment outside any `$(...)` (a literal context); `open` is
 * true when a single quote is left unclosed.
 * @param {string} text @returns {{ out: string, quoted: boolean[], open: boolean }}
 */
function scanShellText(text) {
  const out = [];
  const quoted = [];
  let quote = "";
  let subDepth = 0; // open `$(` count inside the current double quotes: a live command context
  const emit = (ch, q) => { out.push(ch); quoted.push(q); };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote === "'" || quote === "$'") {
      if (c === "\\" && quote === "$'") { emit(" ", true); if (i + 1 < text.length) emit(" ", true); i++; }
      else if (c === "'") { quote = ""; emit("'", true); }
      else emit(" ", true);
    } else if (c === "#" && quote === "" && (i === 0 || /[\s;&|(]/.test(text[i - 1]))) { // an unquoted `#` at word start is a comment up to the end of the line
      for (; i < text.length && text[i] !== "\n"; i++) emit(" ", true);
      i--;
    } else if (c === "\\") { emit(" ", true); if (i + 1 < text.length) emit(" ", true); i++; }
    else if (c === "'" && quote === "") { quote = out[out.length - 1] === "$" ? "$'" : "'"; emit("'", true); }
    else {
      if (c === '"') { quote = quote === '"' ? "" : '"'; subDepth = 0; }
      else if (quote === '"') subDepth += c === "(" && text[i - 1] === "$" ? 1 : c === ")" && subDepth > 0 ? -1 : 0;
      emit(c, c === '"' || (quote === '"' && subDepth === 0));
    }
  }
  return { out: out.join(""), quoted, open: quote === "'" || quote === "$'" };
}

/**
 * OPS-NO-INLINE-INTERPRETER: an inline interpreter — `node -e`/`--eval`/`-p`, `python3 -c`, or a
 * heredoc fed to node/python (`node - <<EOF`, `python3 - <<EOF`). Sanctioned output parsing uses
 * `--jq`/`--silent`, never an inline interpreter. Actor-independent (bars both coordinator and
 * agent flows). Script-path invocations (running a `.mjs` file, `python3 script.py`) never match.
 * @param {string} command @returns {boolean}
 */
export function commandContainsInlineInterpreter(command) {
  // Malformed input (unterminated quote, `$(` or heredoc) fails closed. Checked on the whole command only: the recursive substitution slices below are cut mid-construct on purpose.
  return tokenizeShellCommand(command).incomplete || scanInlineInterpreter(command);
}

export function scanInlineInterpreter(command) {
  // Token-level, not a shell parser: text after each `$(` and inside backtick pairs is checked as a command too.
  // Literal text is blanked for this scan only (the per-segment check below keeps the raw text): quoted-delimiter heredoc bodies, single-quoted spans outside double quotes, and backslash-escaped characters.
  // ponytail: ceiling: nested quote context inside `$(...)`, process substitution `<(...)` and subshell `(...)` are not covered; wrapper options (`sudo -u x`, `nice -n 5`, `xargs -I{}`) are not skipped by stripLeadingWrappers (pre-existing).
  // An unquoted-delimiter heredoc body keeps `$(` live but its quotes and `#` are literal: blank them so apostrophes never pair.
  // The delimiter is any unquoted shell word. A heredoc operator these regexes do not consume (a second heredoc on one line, an unusual delimiter) fails closed below.
  // A heredoc operator counts as consumed only when it is unquoted and outside a comment (`echo "<<'EOF'"` and `# <<'EOF'` are literal text): any other `<<` fails closed below.
  // Quote state is scanned over the text already emitted (earlier heredoc bodies removed), so a quote character inside an earlier body never desynchronizes a later operator.
  const replaceUnquoted = (text, re, onMatch) => {
    let out = "";
    let last = 0;
    for (const m of text.matchAll(re)) {
      out += text.slice(last, m.index);
      out += scanShellText(`${out}<`).quoted[out.length] ? m[0] : (consumed++, onMatch(m));
      last = m.index + m[0].length;
    }
    return out + text.slice(last);
  };
  let consumed = 0;
  // One left-to-right pass handles both forms, so a quote character in an earlier unquoted-delimiter body never desynchronizes the quote state of a later operator.
  // Bash closes `<<` on an unindented delimiter line; `<<-` strips leading tabs only. Each form has its own alternatives (groups 1-6 for `<<-`, 7-12 for `<<`; quoted head/quote/delimiter, then unquoted head/delimiter/body).
  const heredocForm = (g, op, ind) => `((?<!<)<<${op}\\s*(['"])([^\\s'"<>|;&()\\\\]+)\\${g + 2}[^\\n]*\\n)(?:[\\s\\S]*?\\n)??${ind}\\${g + 3}(?=\\)|\\n|$)|((?<!<)<<${op}\\s*([^\\s'"<>|;&()\\\\]+)[^\\n]*\\n)([\\s\\S]*?)(?=(?:(?<=\\n)|\\n)${ind}\\${g + 5}(?:\\)|\\n|$))`;
  const blank = (s) => s.replace(/['"#]/g, " ");
  const noHeredoc = replaceUnquoted(command, new RegExp(`${heredocForm(0, "-", "\\t*")}|${heredocForm(6, "(?!-)", "")}`, "g"), (m) => m[1] ?? (m[4] === undefined ? m[7] ?? m[10] + blank(m[12]) : m[4] + blank(m[6]))); // quoted: body optional, an empty body closes on the first terminator line
  // An operator with no later newline has no body to hide, so a single-line mention (quoted text, arithmetic) keeps the blanked scan. ponytail: a multi-line command that quotes `<<` still fails closed.
  const heredocOperators = (noHeredoc.match(/(?<!<)<<(?!<)(?=[^\n]*\n)/g) ?? []).length;
  // `unquoted` has the same length as `base`, so offsets found in it slice `base` (the text with quotes intact).
  let base = noHeredoc;
  const scanned = scanShellText(noHeredoc);
  let unquoted = scanned.out;
  if (heredocOperators > consumed) base = unquoted = command; // an unconsumed heredoc operator (nested/second heredoc): fail closed, scan the raw text
  else if (scanned.open) unquoted = noHeredoc; // unclosed single quote (nested quote context): fail closed, scan the unblanked text
  const starts = [];
  for (let i = unquoted.indexOf("$("); i !== -1; i = unquoted.indexOf("$(", i + 2)) starts.push(i + 2);
  const ticks = [];
  for (let i = unquoted.indexOf("`"); i !== -1; i = unquoted.indexOf("`", i + 1)) ticks.push(i);
  const subs = [
    ...starts.map((s, k) => base.slice(s, k + 1 < starts.length ? starts[k + 1] - 2 : undefined)),
    ...ticks.filter((_, k) => k % 2 === 0).map((t, k) => base.slice(t + 1, ticks[2 * k + 1]).replace(/\\([`$\\])/g, "$1")), // bash unescapes \` \$ \\ in a backtick body
  ];
  if (subs.some((sub) => scanInlineInterpreter(sub))) return true;
  // The raw head keeps the env-option forms; the stripped head adds sudo/xargs/timeout.
  return shellSegments(command).flatMap((segment) => [segment, stripLeadingWrappers(segment)]).some((s) => {
    if (interpreterRegex("node").test(s)) {
      const code = s.replace(interpreterRegex("node"), "").trim();
      const tokens = unshellTokens(code); // quote-aware: a quoted option value with spaces stays one token
      // ponytail: closed list of value flags. an unlisted `--long value` flag fails closed: a non-flag token that follows a `--flag` (not `--`, no `=`) is skipped as its value and the scan continues, unless it ends in a script extension (.js/.mjs/.cjs/.ts/.mts/.cts) and so is the script. A relative path-like token (starts with `.` or has a non-leading `/`) is the script, not a value. Path-valued flags (--report-dir, --diagnostic-dir, --cpu-prof-dir, ...) are on the closed list so a relative value is skipped. Ceiling: a relative path value after an UNLISTED path-valued long flag is read as the script (fail-open); a bare extensionless name or absolute path after a boolean long flag is still read as a value.
      // Node value-taking flags (short + long) each consume the following token. Consuming them lets
      // a value-taking flag BEFORE the interpreter flag (`node --require ./setup.js -e "..."`) route
      // on to `-e`/`--eval`/`-p` instead of breaking the scan at the flag's value.
      const NODE_VALUE_FLAGS = new Set(["-r", "--require", "--import", "--loader", "--experimental-loader", "--env-file", "--conditions", "-C", "--cwd", "--input-type", "--title", "--disable-warning", "--watch-path", "--redirect-warnings", "--env-file-if-exists", "--test-reporter", "--report-dir", "--diagnostic-dir", "--cpu-prof-dir", "--heap-prof-dir", "--snapshot-blob", "--test-reporter-destination", "--localstorage-file", "--openssl-config", "--icu-data-dir", "--tls-keylog", "--experimental-config-file", "--experimental-sea-config", "--trace-event-file-pattern"]);
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (isStdinScriptToken(t)) return true;
        // `-e`/`-p` may be directly attached to the code (`node -e"console.log(1)"`), which a
        // prefix match catches; break at the first non-flag token so a later `-e` on a script path
        // is a script argument.
        if (t === "-e" || t.startsWith("-e") || t === "--eval" || t.startsWith("--eval=") || t === "-p" || t.startsWith("-p")) return true;
        const skip = redirectionSkip(t);
        if (skip) { if (skip === 2 && tokens[i + 1]?.includes("<<")) return true; i += skip - 1; continue; }
        if (!t.startsWith("-")) {
          const prev = tokens[i - 1];
          if (prev?.startsWith("--") && prev !== "--" && !prev.includes("=") && !NODE_BOOLEAN_FLAGS.has(prev) &&!SCRIPT_EXT_RE.test(stripSurroundingQuotes(t.split("<<")[0])) && !/^\.|^[^/]+\//.test(t)) { if (t.includes("<<")) return true; continue; } // unlisted `--flag value`: skip the value token and keep scanning, so chained unlisted value flags still reach `-`/heredoc
          break; // script path reached — a later `-e` is a script argument
        }
        if (NODE_VALUE_FLAGS.has(t)) { if (tokens[i + 1]?.includes("<<")) return true; i += 1; continue; } // skip the flag's value token
      }
    }
    if (interpreterRegex("python3?").test(s)) {
      const code = s.replace(interpreterRegex("python3?"), "").trim();
      const tokens = unshellTokens(code); // quote-aware: a quoted option value with spaces stays one token
      const PYTHON_VALUE_FLAGS = new Set(["-W", "-X", "--check-hash-based-pycs"]);
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (isStdinScriptToken(t)) return true;
        if (t === "-c" || t.startsWith("-c") || /^-[BEIOPRSUVbdhiqsuvx]+c/.test(t)) return true; // boolean-flag cluster ending in c (-Ic, -IEc); -W/-X value flags are not in the set
        const skip = redirectionSkip(t);
        if (skip) { if (skip === 2 && tokens[i + 1]?.includes("<<")) return true; i += skip - 1; continue; }
        if (!t.startsWith("-")) break; // script path reached — a later `-c` is a script argument
        if (PYTHON_VALUE_FLAGS.has(t) || /^-[A-Za-z]*[WX]$/.test(t)) { if (tokens[i + 1]?.includes("<<")) return true; i += 1; continue; } // skip the flag's value token
      }
    }
    if (interpreterRegex("bun").test(s)) {
      const tokens = unshellTokens(s.replace(interpreterRegex("bun"), "").trim());
      const BUN_VALUE_FLAGS = new Set(["--cwd", "--env-file", "-r", "--preload", "--require", "--import", "-c", "--config", "--tsconfig-override", "--define", "-d", "--loader", "-l", "--port", "--conditions"]);
      const BUN_BOOLEAN_FLAGS = new Set(["--silent", "--bun", "--watch", "--hot", "--smol", "--no-install", "--if-present", "--no-clear-screen"]); // the token after one is the script/subcommand, not a value
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (isStdinScriptToken(t)) return true;
        if (/^(?:-e|-p|--eval|--print)(?:=|$)/.test(t) || /^-[ep]./.test(t)) return true;
        const skip = redirectionSkip(t);
        if (skip) { if (skip === 2 && tokens[i + 1]?.includes("<<")) return true; i += skip - 1; continue; }
        if (!t.startsWith("-")) {
          const prev = tokens[i - 1];
          if (t === "run") continue; // `bun run` takes the same flags: keep scanning so `-e`/`-p`/`--bun -` after it are caught
          // ponytail: unlisted `--flag value` fails closed like node: skip the value token unless it is a script or path-like.
          if (prev?.startsWith("--") && prev !== "--" && !prev.includes("=") && !BUN_BOOLEAN_FLAGS.has(prev) && !SCRIPT_EXT_RE.test(stripSurroundingQuotes(t.split("<<")[0])) && !/^\.|^[^/]+\//.test(t)) { if (t.includes("<<")) return true; continue; }
          break; // subcommand or script path reached (`bun run x`, `bun test`)
        }
        if (BUN_VALUE_FLAGS.has(t)) { if (tokens[i + 1]?.includes("<<")) return true; i += 1; continue; }
      }
    }
    return false;
  });
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
