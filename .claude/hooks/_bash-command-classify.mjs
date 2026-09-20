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
 */
const SHELL_SEGMENT_SEPARATOR = /\s*(?:&&|\|\||;|\||&|\n|\r)\s*/;

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
 * Whether a single shell JOB's command HEAD invokes a wait/probe helper — the Copilot/CI wait
 * tools that MUST run as a bounded FOREGROUND probe (`probe-copilot-review.mjs` /
 * `wait-pr-checks.mjs` with an explicit timeout; `detect-copilot-loop-state.mjs`;
 * `run-watch-cycle.mjs`; `gh run watch`; `dev-loops loop watch-*` / `gate probe-copilot`; and the
 * Claude plugin launcher forms of the same, `dev-loops-run cli/index.mjs loop watch-*` / `gate
 * probe-copilot` and `dev-loops-run <path>/<wait-script>.mjs`).
 * Anchored at the command head (after an env-assignment/wrapper/binary-path prefix), so a job
 * that merely MENTIONS the basename as an argument — `grep probe-copilot-review.mjs docs`,
 * `echo … wait-pr-checks.mjs` — does NOT match (only a real invocation does). A `.mjs` helper
 * must be run by `node`/`bun`/`deno` or invoked directly as the head; the CLI forms anchor on
 * their own verb.
 * @param {string} job @returns {boolean}
 */
function jobHeadInvokesWaitProbe(job) {
  const head = job.trim().replace(new RegExp(`^${SHELL_EXEC_PREFIX}`), "");
  if (!head) return false;
  const WAIT_SCRIPT = /(?:probe-copilot-review|wait-pr-checks|detect-copilot-loop-state|run-watch-cycle)\.mjs\b/i;
  // `node`/`bun`/`deno … <path>/<wait-script>.mjs …`
  if (/^(?:node|bun|deno)\b/i.test(head) && WAIT_SCRIPT.test(head)) return true;
  // A wait script invoked directly as the command head (a bare `probe-copilot-review.mjs` path).
  if (new RegExp(`^(?:\\S*/)?${WAIT_SCRIPT.source}`, "i").test(head)) return true;
  // `gh run watch …`
  if (/^(?:\S*\/)?gh\s+run\s+watch\b/i.test(head)) return true;
  // `dev-loops loop watch-cycle|watch-ci|watch-initial` / `dev-loops gate probe-copilot`
  if (/^(?:\S*\/)?dev-loops\s+(?:loop\s+watch-(?:cycle|ci|initial)|gate\s+probe-copilot)\b/i.test(head)) return true;
  // The Claude plugin launcher form of the same CLI verbs: `dev-loops-run cli/index.mjs loop
  // watch-cycle|watch-ci|watch-initial` / `dev-loops-run cli/index.mjs gate probe-copilot`.
  if (
    /^(?:\S*\/)?dev-loops-run\s+(?:\S*\/)?cli\/index\.mjs\s+(?:loop\s+watch-(?:cycle|ci|initial)|gate\s+probe-copilot)\b/i.test(
      head,
    )
  ) {
    return true;
  }
  // The launcher invoking a wait/probe script directly: `dev-loops-run <path>/<wait-script>.mjs …`.
  if (/^(?:\S*\/)?dev-loops-run\b/i.test(head) && WAIT_SCRIPT.test(head)) return true;
  return false;
}

/**
 * Whether the command launches a wait/probe helper in the BACKGROUND — a bare `&` control
 * operator (not `&&`, not a redirection like `2>&1`/`>&2`/`&>file`) terminating a PIPELINE any of
 * whose stage heads invokes that helper. A `|`-joined pipeline is one job for backgrounding
 * purposes: `probe-copilot-review.mjs … | tee log &` backgrounds the WHOLE pipeline (the probe
 * included), not just the trailing `tee` stage the `&` textually follows, so every `|`-stage head
 * in the accumulated pipeline is checked, not only the one immediately before the `&`.
 * Segment/job-head-anchored (not a whole-string basename scan), so a background `&` on an
 * UNRELATED pipeline that merely mentions the filename is NOT denied; only backgrounding the
 * helper's own pipeline is. These helpers are bounded foreground probes by contract; backgrounding
 * one (directly or via a piped stage) recreates the orphaned-wait defect under the wake-less
 * Claude harness.
 * ponytail: redirection stripping is a fixed set (`N>&M`, `&>`/`&>>`), not a full shell parse —
 * enough to tell a background `&` from a redirection `&`; the job split keys off the same set of
 * control operators the rest of this module uses.
 * @param {string} command @returns {boolean}
 */
function commandBackgroundsWaitProbe(command) {
  const withoutRedir = command
    .replace(/\d*>&\d*-?/g, " ") // 2>&1, 1>&2, >&2, >&-
    .replace(/&>>?/g, " "); // &>file, &>>file
  // Tokenize into jobs + the control operator following each; `&&` is matched before a lone `&`.
  const parts = withoutRedir.split(/(&&|\|\||;|\||&|\n|\r)/);
  let pipelineStages = [];
  for (let i = 0; i < parts.length; i += 2) {
    // parts[i] is a job; parts[i+1] is the operator terminating it (undefined at end-of-string).
    pipelineStages.push(parts[i]);
    const op = parts[i + 1];
    if (op === "|") continue; // still inside the same pipeline; accumulate the next stage
    // A lone `&` operator backgrounds the WHOLE accumulated pipeline — check every stage head.
    if (op === "&" && pipelineStages.some((stage) => jobHeadInvokesWaitProbe(stage))) return true;
    pipelineStages = [];
  }
  return false;
}

/**
 * Whether COMMAND is (or contains) a sleep-poll loop over `gh`/`loop-state` — a `while`/`until`/
 * `for` loop whose body contains both a `sleep` and a `gh` or `loop-state` call. Checked on the
 * WHOLE command (not per-segment): the loop body is `;`-delimited, so a per-segment split would
 * separate the loop head from its `sleep`/`gh` body calls and miss the pattern. `gh` must be a
 * standalone token (not `grep gh-notes`), and `loop-state` must sit at a command-head position
 * (not a substring inside `grep loop-state x`). Shared by `commandContainsDetachedWaitTool` (the
 * PreToolUse gate, over the shell text about to run) and `commandInvokesWaitProbeHelper` (the
 * SubagentStop reaper's ownership signature, over a live process's `ps` command line).
 * @param {string} command @returns {boolean}
 */
export function commandIsSleepPollLoop(command) {
  const whole = command.trim();
  return (
    /(?:while|until|for)\b/i.test(whole) &&
    /\bsleep\b/.test(whole) &&
    /\bgh(?=\s|$)|(?:^|[;&|(])\s*loop-state(?=\s|$)/.test(whole)
  );
}

/**
 * Whether COMMAND itself IS an invocation of a Copilot/CI wait/probe helper — the reusable
 * signature the SubagentStop reaper (`discoverOwnBackgroundShells`) uses to decide which
 * process-group leader it may own and reap: a `jobHeadInvokesWaitProbe` match (a `.mjs` helper,
 * `gh run watch`, `dev-loops`/`dev-loops-run` watch-cycle/probe-copilot) OR a sleep-poll loop
 * (`commandIsSleepPollLoop`). Unlike `commandContainsDetachedWaitTool`, this takes no `&`/backgrounding
 * operator into account — it classifies an already-running process's command line, not shell
 * syntax about to execute.
 * @param {string} command @returns {boolean}
 */
export function commandInvokesWaitProbeHelper(command) {
  return jobHeadInvokesWaitProbe(command) || commandIsSleepPollLoop(command);
}

/**
 * COPILOT-FOLLOWUP-WAIT-TOOLS: a banned detached/polling wait — `nohup`, `disown`, `tmux new-session`,
 * `screen -dm`, a `while`/`until`/`for` loop whose body contains both a `sleep` and a gh or
 * loop-state call, OR a bare-`&` backgrounded wait/probe helper. Actor-independent at the
 * decideBashGate call site: the coordinator/main agent is the actor that leaves these orphaned
 * under Claude Code, so the gate catches its backgrounding too, not only a subagent's — the
 * sanctioned wait is always the bounded FOREGROUND probe.
 * @param {string} command @returns {boolean}
 */
export function commandContainsDetachedWaitTool(command) {
  const whole = command.trim();
  if (commandIsSleepPollLoop(whole)) {
    return true;
  }
  // A wait/probe helper launched with a bare `&` — the orphaned-background-shell form.
  if (commandBackgroundsWaitProbe(whole)) {
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
 * heredoc fed to node/python (`node - <<EOF`, `python3 - <<EOF`). Sanctioned output parsing uses
 * `--jq`/`--silent`, never an inline interpreter. Actor-independent (bars both coordinator and
 * agent flows). Script-path invocations (running a `.mjs` file, `python3 script.py`) never match.
 * @param {string} command @returns {boolean}
 */
export function commandContainsInlineInterpreter(command) {
  return shellSegments(command).some((segment) => {
    const s = segment.trim();
    if (interpreterRegex("node").test(s)) {
      const code = s.replace(interpreterRegex("node"), "").trim();
      // Heredoc fed straight to node where node is the command head (`node - <<EOF`, `node <<EOF`),
      // so `grep node <<EOF` (interpreter is grep) does not false-positive as an inline interpreter.
      if (/^(?:-\s*)?<</i.test(code)) return true;
      const tokens = code.split(/\s+/).filter(Boolean);
      // Node value-taking flags (short + long) each consume the following token. Consuming them lets
      // a value-taking flag BEFORE the interpreter flag (`node --require ./setup.js -e "..."`) route
      // on to `-e`/`--eval`/`-p` instead of breaking the scan at the flag's value.
      const NODE_VALUE_FLAGS = new Set(["-r", "--require", "--import", "--loader", "--experimental-loader", "--env-file", "--conditions", "-C", "--cwd"]);
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        // `-e`/`-p` may be directly attached to the code (`node -e"console.log(1)"`), which a
        // prefix match catches; break at the first non-flag token so a later `-e` on a script path
        // is a script argument.
        if (t === "-e" || t.startsWith("-e") || t === "--eval" || t.startsWith("--eval=") || t === "-p" || t.startsWith("-p")) return true;
        if (!t.startsWith("-")) break; // script path reached — a later `-e` is a script argument
        if (NODE_VALUE_FLAGS.has(t)) { i += 1; continue; } // skip the flag's value token
      }
    }
    if (interpreterRegex("python3?").test(s)) {
      const code = s.replace(interpreterRegex("python3?"), "").trim();
      // Heredoc fed straight to python where python is the command head (`python3 - <<EOF`).
      if (/^(?:-\s*)?<</i.test(code)) return true;
      const tokens = code.split(/\s+/).filter(Boolean);
      for (const t of tokens) {
        if (t === "-c" || t.startsWith("-c")) return true;
        if (!t.startsWith("-")) break; // script path reached — a later `-c` is a script argument
      }
    }
    return false;
  });
}
