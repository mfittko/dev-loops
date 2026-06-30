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
    .split(/\s*(?:&&|\|\||;|\|)\s*/)
    .some((segment) => segmentIsGhPrMerge(segment) || isGitMergeCompletionCommand(segment));
}

/** @param {string} command @returns {string} */
export function firstShellSegment(command) {
  return command.trim().split(/\s*(?:&&|\|\||;|\|)\s*/)[0]?.trim() ?? "";
}

/** Split a compound shell command into its individual segments. */
function shellSegments(command) {
  return command.trim().split(/\s*(?:&&|\|\||;|\|)\s*/).map((s) => s.trim()).filter(Boolean);
}

/** Build the `^gh pr <verb>` prefix matcher for a `gh pr <verb>` subcommand. */
function ghPrVerbRegex(verb) {
  return new RegExp(`^gh\\s+pr\\s+${verb}(?:\\s|$)`, "i");
}

/**
 * Return the first segment in the command that is a `gh pr <verb>` call (ignoring --help/-h),
 * or null. Scans ALL segments so compound commands (`echo ok && gh pr merge 1`) are caught.
 */
function findGhPrVerbSegment(command, verb) {
  const re = ghPrVerbRegex(verb);
  for (const segment of shellSegments(command)) {
    if (!re.test(segment)) continue;
    const remainder = segment.replace(re, "").trim();
    if (!remainder) return segment;
    const args = remainder.split(/\s+/).map((a) => a.toLowerCase());
    if (!args.includes("--help") && !args.includes("-h")) return segment;
  }
  return null;
}

/** Generic `gh pr <verb>` detector that scans ALL shell segments. */
function isGhPrVerbCommand(command, verb) {
  return findGhPrVerbSegment(command, verb) !== null;
}

/** Generic positional PR-number extractor for `gh pr <verb>` — finds the verb segment first. */
function extractPrNumberFromGhPrVerb(command, verb) {
  const segment = findGhPrVerbSegment(command, verb);
  if (!segment) return null;
  const re = ghPrVerbRegex(verb);
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

/** Generic `--repo`/`-R` extractor for `gh pr <verb>` — finds the verb segment first. */
function extractRepoFlagFromGhPrVerb(command, verb) {
  const segment = findGhPrVerbSegment(command, verb);
  if (!segment) return null;
  const re = ghPrVerbRegex(verb);
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
        return tokens[i + 1];
      }
    }
    const repoEqMatch = token.match(/^(?:--repo|-R)=(.+)$/i);
    if (repoEqMatch) {
      return repoEqMatch[1];
    }
  }
  return null;
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
 * Whether `command` contains a `gh pr merge` invocation in any shell segment, ignoring `--help`/`-h`.
 * Used by the PreToolUse gate to block a direct merge that bypasses the dev-loop's pre-merge
 * gate-evidence check — the loop normally runs `detect-checkpoint-evidence` before merging, but
 * a hand-run `gh pr merge` would otherwise skip it.
 * @param {string} command @returns {boolean}
 */
export function isGhPrMergeCommand(command) {
  return isGhPrVerbCommand(command, "merge");
}

/** @param {string} command @returns {number|null} */
export function extractPrNumberFromGhPrMerge(command) {
  return extractPrNumberFromGhPrVerb(command, "merge");
}

/** @param {string} command @returns {string|null} */
export function extractRepoFlagFromGhPrMerge(command) {
  return extractRepoFlagFromGhPrVerb(command, "merge");
}
