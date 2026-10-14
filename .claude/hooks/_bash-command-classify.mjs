// GENERATED from packages/core/src/loop/bash-command-classify.mjs by scripts/claude/generate-claude-assets.mjs — do not edit; edit the source and regenerate.
import { posix } from "node:path";

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

// Validation needs shell words, while the mutation and read/search guards keep their own boundaries.
// Read literal substitutions and shell-owned stdin programs; never evaluate variables or scripts.
function quotedHeredoc(command, index, bodyNewline) {
  const header = command.slice(index).match(/^<<(-?)[ \t]*(?:'([^']+)'|"([^"]+)"|\\([\w]+))/);
  if (!header) return null;
  const start = bodyNewline ?? command.indexOf("\n", index + header[0].length);
  if (start < 0) return null;
  const delimiter = header[2] ?? header[3] ?? header[4];
  let end = start + 1;
  while (end < command.length) {
    const newline = command.indexOf("\n", end);
    const lineEnd = newline < 0 ? command.length : newline;
    const line = command.slice(end, lineEnd);
    if ((header[1] ? line.replace(/^\t+/, "") : line) === delimiter) return { start, end: lineEnd, body: command.slice(start + 1, end) };
    end = lineEnd + 1;
  }
  return { start, end: command.length, body: command.slice(start + 1) };
}

function literalShellProgram(words) {
  if (!/^(?:ba|z|da|k)?sh$/.test(words[0] ?? "")) return { program: null, stdin: false };
  let index = 1, command = false, stdin = false;
  for (; index < words.length; index += 1) {
    const option = words[index];
    if (option === "--" || option === "-") { index += 1; break; }
    if (!/^[+-]/.test(option)) break;
    if (option.startsWith("--")) {
      if (option === "--command") command = true;
      if (option === "--rcfile" || option === "--init-file") index += 1;
      continue;
    }
    // Shell short options cluster; o/O take the next word even within a cluster.
    for (const flag of option.slice(1)) {
      if (option[0] === "-" && flag === "c") command = true;
      if (option[0] === "-" && flag === "s") stdin = true;
      if (flag === "o" || flag === "O") index += 1;
    }
  }
  return { program: command ? words[index] ?? null : null, stdin: !command && (stdin || index >= words.length || /^\/dev\/(?:stdin|fd\/0)$/.test(words[index])) };
}

function shellConsumesStdin(header) {
  // Inspect command ownership without recursively reading its stdin payload again.
  return normalizedVerificationSegments(header, 0, false).some(({ text }) => {
    const words = text.match(new RegExp(PACKAGE_MANAGER_WORD, "g")) ?? [];
    return literalShellProgram(words).stdin || /^(?:source|\.)\s+\/dev\/(?:stdin|fd\/0)(?:\s|$)/.test(text);
  });
}

function substitutionEnd(command, start, backtick) {
  const quotes = [null];
  const heredocs = [];
  for (let i = start; i < command.length; i += 1) {
    const char = command[i], next = command[i + 1], quote = quotes.at(-1);
    if (char === "\n" && heredocs.length) {
      let cursor = i;
      for (const index of heredocs.splice(0)) cursor = quotedHeredoc(command, index, cursor).end;
      i = cursor;
      continue;
    }
    if (char === "\\" && quote !== "'") { i += 1; continue; }
    if (backtick && char === "`") return i;
    if (char === "$" && next === "(" && quote !== "'") { quotes.push(null); i += 1; continue; }
    if (quote) { if (char === quote) quotes[quotes.length - 1] = null; continue; }
    if (char === "'" || char === '"') { quotes[quotes.length - 1] = char; continue; }
    if (char === "<" && next === "<" && quotedHeredoc(command, i)) { heredocs.push(i); i += 1; }
    if (!backtick && char === "(") quotes.push(null);
    if (!backtick && char === ")") { quotes.pop(); if (quotes.length === 0) return i; }
  }
  return -1;
}

function validationShellSegments(command, depth = 0, inspectStdin = true) {
  const segments = [];
  const heredocs = [], bodySpans = [], statements = [];
  let statement = [], stage = { start: 0, inputs: [] }, nesting = 0, pipeline = false;
  statement.push(stage);
  statements.push(statement);
  const endStage = (end, pipe) => {
    stage.end = end;
    stage = { start: end + (pipe?.length ?? 1), inputs: [] };
    if (!pipe) { statement = []; statements.push(statement); }
    statement.push(stage);
  };
  let words = [], word = "", started = false, quote = null, uncertain = false, redirectTarget = false;
  let input = null;
  const finishWord = () => {
    if (started) {
      if (!redirectTarget) {
        if (!words.length && /^(?:if|while|until|for|select|case)$/.test(word)) nesting += 1;
        if (!words.length && /^(?:fi|done|esac)$/.test(word)) nesting = Math.max(0, nesting - 1);
        pipeline = false;
      }
      const option = word.match(/^((?:--?[\w-]+|[A-Za-z_]\w*)=)([\s\S]*)$/);
      if (!redirectTarget) words.push(/^[\w./:@=+-]+$/.test(word) ? word : option ? option[1] + JSON.stringify(option[2]) : JSON.stringify(word));
      if (input?.hereString) input.body = word;
      redirectTarget = false;
      input = null;
    }
    word = "";
    started = false;
  };
  const finishSegment = () => {
    finishWord();
    if (words.length) segments.push({ text: words.join(" "), uncertain });
    words = [];
    uncertain = false;
    redirectTarget = false;
  };
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i], next = command[i + 1];
    if (char === "\n" && heredocs.length) {
      finishSegment();
      const continued = pipeline;
      let cursor = i;
      for (const pending of heredocs.splice(0)) {
        const body = quotedHeredoc(command, pending.index, cursor);
        Object.assign(pending, body);
        bodySpans.push(body);
        cursor = body.end;
      }
      if (!nesting && !continued) endStage(i);
      i = cursor;
      if (!continued && !nesting) stage.start = i + 1;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      if (next === "\n") { i += 1; continue; }
      if (next === undefined) { uncertain = true; continue; }
      if (quote !== '"' || /[$`"\\]/.test(next)) { word += next; started = true; i += 1; continue; }
      word += char;
      continue;
    }
    if (quote !== "'" && ((char === "$" && next === "(") || char === "`")) {
      const start = i + (char === "`" ? 1 : 2);
      const end = substitutionEnd(command, start, char === "`");
      uncertain = true;
      // shortcut: inspect eight literal levels; recognized deeper execution fails closed.
      if (end !== -1 && depth < 8) {
        segments.push(...validationShellSegments(command.slice(start, end), depth + 1, inspectStdin));
        word += "$substitution";
        started = true;
        i = end;
        continue;
      }
      if (end !== -1) { segments.push({ text: "<opaque-shell-program>", fullValidation: true }); i = end; continue; }
    }
    if (quote) {
      if (char === quote) quote = null;
      else {
        if (quote === '"' && /[$`]/.test(char)) uncertain = true;
        word += char;
      }
      continue;
    }
    if (char === "'" || char === '"') { quote = char; started = true; continue; }
    if ((char === "<" || char === ">") && next === "(") uncertain = true;
    else if (char === "<" || char === ">" || (char === "&" && next === ">")) {
      const operator = command.slice(i).match(/^(?:&>>?|<<<|<<-?|[<>](?:[>&]|<)?)/)[0];
      const fd = /^\d+$/.test(word) ? word : null;
      if (fd !== null) { word = ""; started = false; }
      else finishWord();
      input = null;
      if (operator.startsWith("<") && (fd === null || fd === "0")) {
        input = { index: i, hereString: operator === "<<<" };
        stage.inputs.push(input);
      }
      if (/^<<-?$/.test(operator)) {
        if (quotedHeredoc(command, i)) heredocs.push(input ?? { index: i });
        else uncertain = true;
      }
      redirectTarget = true;
      i += operator.length - 1;
      continue;
    }
    // Unquoted parentheses delimit command positions (groups, function bodies and case arms).
    if (/[()]/.test(char)) { finishSegment(); nesting = Math.max(0, nesting + (char === "(" ? 1 : -1)); continue; }
    if (/[{}!]/.test(char) && !started) { if (char === "{") nesting += 1; if (char === "}") nesting = Math.max(0, nesting - 1); words.push(char); continue; }
    if (char === "}") { finishWord(); nesting = Math.max(0, nesting - 1); words.push(char); continue; }
    if (/[;&|\n\r]/.test(char)) {
      const operator = char === "|" && (next === "|" || next === "&") ? char + next : char === "&" && next === "&" ? "&&" : char;
      finishSegment();
      const pipe = operator === "|" || operator === "|&";
      if (!nesting && !(char === "\n" && pipeline)) endStage(i, pipe ? operator : null);
      if (pipe) pipeline = true;
      i += operator.length - 1;
      continue;
    }
    if (/\s/.test(char)) { finishWord(); continue; }
    if (/[$`*?\[\]<>]/.test(char)) uncertain = true;
    word += char;
    started = true;
  }
  if (quote) uncertain = true;
  finishSegment();
  stage.end ??= command.length;
  if (inspectStdin) for (const stages of statements) for (let index = 0; index < stages.length; index += 1) {
    const program = stages[index].inputs.at(-1);
    if (program?.body === undefined) continue;
    for (let target = index; target < stages.length; target += 1) {
      if (target > index && stages[target].inputs.length) break; // A downstream stdin redirect replaces the pipe.
      const owner = stages[target];
      const header = bodySpans.reduce((text, body) => text.replace(command.slice(body.start, body.end + 1), "\n"), command.slice(owner.start, owner.end));
      if (!shellConsumesStdin(header)) continue;
      segments.push(...(depth < 8 && !program.body.startsWith("$") ? validationShellSegments(program.body, depth + 1) : [{ text: "<opaque-shell-program>", fullValidation: true }]));
      break;
    }
  }
  return segments;
}

function verificationWrapperLaunches(text) {
  const words = text.match(new RegExp(PACKAGE_MANAGER_WORD, "g")) ?? [];
  const wrapper = words[0]?.split("/").at(-1);
  if (!["time", "nohup", "command", "exec", "builtin", "nice", "timeout", "env"].includes(wrapper)) return [text];
  const commandStart = words.findIndex((word, index) => index > 0 && !word.startsWith("-"));
  if (wrapper === "command" && words.slice(1, commandStart < 0 ? undefined : commandStart).some((word) => /^-[vV]+$/.test(word))) return [text];
  const positions = [1], launches = [];
  for (let i of positions) {
    while (i < words.length && words[i].startsWith("-")) {
      if (words[i] === "--") { i += 1; break; }
      if (wrapper === "env" && /^(?:-S|--split-string)(?:=|$)/.test(words[i])) {
        const value = words[i].includes("=") ? words[i].slice(words[i].indexOf("=") + 1) : words[++i];
        if (value) launches.push([value.startsWith('"') ? JSON.parse(value) : value, ...words.slice(i + 1)].join(" "));
        i = words.length;
        break;
      }
      if ((wrapper === "env" && /^(?:-u|-C|--unset|--chdir)$/.test(words[i])) || (wrapper === "nice" && words[i] === "-n")) { i += 2; continue; }
      // Unknown options may consume a value; retain both literal interpretations.
      if (!words[i].includes("=") && words[i + 1] && !words[i + 1].startsWith("-")) positions.push(i + 2);
      i += 1;
    }
    if (wrapper === "timeout") i += 1; // The duration precedes the executable, after wrapper options.
    if (wrapper === "env") while (/^[A-Za-z_]\w*=/.test(words[i] ?? "")) i += 1;
    if (i < words.length) launches.push(words.slice(i).join(" "));
  }
  return launches;
}

function normalizedVerificationSegments(command, depth = 0, inspectStdin = true) {
  if (typeof command !== "string") return [];
  const prefix = new RegExp(`^${VERIFY_EXEC_PREFIX.replaceAll("[A-Za-z_][A-Za-z0-9_]*=\\S*", `[A-Za-z_][A-Za-z0-9_]*=${PACKAGE_MANAGER_WORD}`)}`, "i");
  const controlPrefix = /^(?:(?:if|then|elif|else|do|while|until)(?:\s+|$)|coproc(?:\s+\w+(?=\s*\{))?(?:\s+|$)|function\s+[^\s{]+\s*\{\s*|[!({]\s*)/;
  return validationShellSegments(command, depth, inspectStdin).flatMap(({ text, uncertain, fullValidation }) => {
    if (fullValidation) return [{ text, fullValidation }];
    const pending = [text], normalized = [];
    for (const original of pending) {
      let candidate = original;
      const stripped = candidate.replace(controlPrefix, "");
      const launches = verificationWrapperLaunches(stripped);
      if (launches.length !== 1 || launches[0] !== stripped) { pending.push(...launches); continue; }
      candidate = stripped.replace(prefix, "");
      if (candidate !== original) { pending.push(candidate); continue; }
      const words = candidate.match(new RegExp(PACKAGE_MANAGER_WORD, "g")) ?? [];
      const payload = literalShellProgram(words).program;
      const decode = (word) => word.startsWith('"') ? JSON.parse(word) : word;
      const program = payload ? decode(payload) : words[0] === "eval" ? words.slice(words[1] === "--" ? 2 : 1).map(decode).join(" ") : null;
      // shortcut: eight literal shell levels; refuse recognized executable text beyond that bound.
      if (program && (depth >= 8 || program.startsWith("$"))) { normalized.push({ text: "<opaque-shell-program>", fullValidation: true }); continue; }
      if (program) {
        normalized.push(...normalizedVerificationSegments(program, depth + 1, inspectStdin).map((segment) => ({ ...segment, uncertain: uncertain || segment.uncertain })));
        continue;
      }
      normalized.push({ text: candidate.replace(/(?:\s*[)}])+\s*$/, ""), uncertain });
    }
    return normalized;
  });
}

/** Normalize literal validation words without granting shell execution or read/search admission. */
export function verificationCommandSegments(command) {
  return normalizedVerificationSegments(command).map(({ text }) => text);
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
      const repoFlag = /(?:^|\s)(?:--repo|-R)(?:=|\s+)(\S+)/.exec(stripQuotedLiterals(segment));
      if (repoFlag && explicitRepoProvenForeign(repoFlag[1], managedSlug)) return false;
      const flags = stripQuotedLiterals(segment.replace(re, " "));
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
    if (/(?:^|\s)--input(?:=|\s)/.test(stripQuotedLiterals(segment))) return true;
    // gh defaults to POST when a field is present, so only an explicit GET/HEAD makes a body field a read.
    if (/(?:^|\s)(?:--method|-X|-m)(?:=|\s*)["']?(?:GET|HEAD)\b/i.test(stripQuotedLiterals(segment))) return false;
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
 * Blank the CONTENTS of quoted string literals ('...' and "...") to a space, EXCEPT a quote that is
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
 * ponytail: blanks balanced quote pairs only, with the command-substitution/backtick preserve rule
 * and the `-c`-cluster/`--command`/`eval` exemption above — no full shell tokenizer (mismatched/
 * partial quotes and other exec-wrapper flags stay out of scope). Accepted ceiling: a deliberately
 * quoted structural keyword (e.g. `"sleep"`) placed inside a real UNQUOTED loop is blanked like any
 * other quoted literal and can therefore evade the ban — accepted as a deliberate-evasion class, not
 * a natural shape a genuine poll loop takes.
 * @param {string} command @returns {string}
 */
function stripQuotedLiterals(command) {
  return command.replace(/(['"])((?:(?!\1).)*)\1/gs, (match, _quote, inner, offset, full) => {
    // A quoted string containing a command substitution ($()) or backtick is executable code, not
    // inert data — its command runs regardless of the surrounding quotes. Blanking it would hide a
    // real poll loop such as `while [ "$(gh pr view 5)" != MERGED ]; do sleep 5; done` that the
    // gh/loop-state ban already denied. Preserve it (fail-closed direction).
    if (/\$\(|`/.test(inner)) {
      return match;
    }
    const before = full.slice(0, offset);
    if (/(?:^|\s)(?:-[A-Za-z]*c[A-Za-z]*(?:\s+--)?|--command|eval)\s*$/.test(before)) {
      return match; // executable -c/eval payload — leave the real shell syntax intact
    }
    return " ";
  });
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
 *   (2) A `while`/`until`/`for` sleep-poll loop over `gh`/`loop-state` (`commandIsSleepPollLoop`) —
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

  // (2) Unconditional sleep-poll-loop ban — a gh/loop-state poll OR a bare file-marker poll.
  if (commandIsSleepPollLoop(whole) || commandIsFileMarkerPollLoop(whole)) {
    return true;
  }

  // (3) OPTION-C: bare-`&` background AND a wait/probe family reference.
  if (!commandHasBareBackgroundOperator(whole)) {
    return false;
  }
  return WAIT_PROBE_FAMILY_RE.test(whole);
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

const COMPONENT_SUITES = new Set(["test:core", "test:scripts", "test:assets", "test:extension", "test:dev-loop", "test:pack", "test:docs", "test:workflows"]);
const FULL_SUITES = ["test:all", "test:docs", "test:workflows"];
const EXACT_TEST_FILE = /^[\w./-]+\.(?:test|spec)\.[cm]?[jt]sx?$/;
const RUNNER_VALUE_FLAGS = new Set(["--timeout", "--test-name-pattern", "--test-reporter", "--test-reporter-destination", "--reporter", "--test-timeout", "--test-concurrency", "--test-shard", "--max-workers", "--filter"]);
// Quoted parts and escapes keep whitespace inside an option value, never a command word.
const PACKAGE_MANAGER_WORD = String.raw`(?:[^\s'"\\]|\\[\s\S]|"(?:\\[\s\S]|[^"\\])*"|'[^']*')+`;
const PACKAGE_MANAGER_OPTIONS = String.raw`(?:\s+(?:(?:--prefix|--dir|--cwd|--loglevel|--workspace|--filter|--cache|--registry|--userconfig|--config|--modules-folder|--use-yarnrc|-w|-C)\s+${PACKAGE_MANAGER_WORD}|--?[\w-]+=${PACKAGE_MANAGER_WORD}|(?:--silent|--quiet|--verbose|--bun|--if-present|--ignore-scripts|--offline|--frozen-lockfile|--recursive|-[sqrd]+)(?=\s|$)))*`;
const PACKAGE_EXEC_OPTIONS = String.raw`(?:\s+(?:(?:--package|-p)\s+${PACKAGE_MANAGER_WORD}|--?[\w-]+=${PACKAGE_MANAGER_WORD}|(?:--yes|--no|--bun|--quiet|--silent|-[ynqs]+)(?=\s|$)))*`;
const PACKAGE_RUNNER_PREFIX = `(?:(?:npx|bunx)${PACKAGE_EXEC_OPTIONS}\\s+(?:--\\s+)?|(?:npm|pnpm|yarn)${PACKAGE_MANAGER_OPTIONS}\\s+(?:exec|dlx)${PACKAGE_EXEC_OPTIONS}\\s+(?:--\\s+)?|(?:bun|pnpm|yarn)${PACKAGE_MANAGER_OPTIONS}\\s+(?:run${PACKAGE_MANAGER_OPTIONS}\\s+)?|bun\\s+x${PACKAGE_EXEC_OPTIONS}\\s+)`;
const VITEST_LAUNCH = new RegExp(`^${PACKAGE_RUNNER_PREFIX}?vitest(?:@[^\\s]+)?(?:\\s+(.*))?$`, "i");
const OTHER_PACKAGE_RUNNER_COMMAND = new RegExp(`^${PACKAGE_RUNNER_PREFIX}(?!vitest(?:@|\\s|$))[\\w./][\\w./-]*(?:\\s|$)`, "i");
export const FULL_VALIDATION_REMEDY = "Full validation boundary: developers and fixers run targeted checks only. Request full evidence through `dev-loops gate resolve-validation` (in this repo: `dev-loops-run cli/index.mjs gate resolve-validation`).";
const VALIDATION_SCRIPT = String.raw`(?:test(?::[\w-]+)*|verify(?::[\w-]+)*|build(?::[\w-]+)*|assets:check|schema:check)`;
// npm/pnpm aliases and install-and-test commands all run the test script.
const RUN_WORD = String.raw`(?:run-script|run|rum|urn)`;
const TEST_ALIAS_WORD = String.raw`(?:t|tst|it|install-test|cit|install-ci-test|clean-install-test|sit)`;
const TEST_ALIAS = new RegExp(`^(?:npm|pnpm)${PACKAGE_MANAGER_OPTIONS}\\s+${TEST_ALIAS_WORD}(?:\\s|$)`, "i");
const PACKAGE_MANAGER_RUN = new RegExp(`^(?:bun|npm|pnpm|yarn)${PACKAGE_MANAGER_OPTIONS}\\s+(?:${RUN_WORD}${PACKAGE_MANAGER_OPTIONS}\\s+)?(${VALIDATION_SCRIPT})(?:\\s|$)`, "i");
const PACKAGE_MANAGER_COMMAND = new RegExp(`^(?:bun|npm|pnpm|yarn)${PACKAGE_MANAGER_OPTIONS}\\s+(?:${RUN_WORD}${PACKAGE_MANAGER_OPTIONS}\\s+)?(?!${RUN_WORD}(?:\\s|$))[\\w:][\\w:-]*(?:\\s|$)`, "i");
// An opaque value-taking option before a recognizable validation script cannot grant worker execution.
const OPAQUE_PACKAGE_MANAGER_OPTIONS = String.raw`(?:\s+-${PACKAGE_MANAGER_WORD}(?:\s+${PACKAGE_MANAGER_WORD})?)*`;
const OPAQUE_VITEST_LAUNCH = new RegExp(`^(?:(?:npx|bunx)${OPAQUE_PACKAGE_MANAGER_OPTIONS}\\s+|(?:npm|pnpm|yarn)${OPAQUE_PACKAGE_MANAGER_OPTIONS}\\s+(?:exec|dlx)${OPAQUE_PACKAGE_MANAGER_OPTIONS}\\s+|(?:bun|pnpm|yarn)${OPAQUE_PACKAGE_MANAGER_OPTIONS}\\s+(?:(?:run|x)${OPAQUE_PACKAGE_MANAGER_OPTIONS}\\s+)?)vitest(?:@[^\\s]+)?(?:\\s|$)`, "i");
const OPAQUE_PACKAGE_MANAGER_RUN = new RegExp(`^(?:(?:bun|npm|pnpm|yarn)${OPAQUE_PACKAGE_MANAGER_OPTIONS}\\s+(?:${RUN_WORD}${OPAQUE_PACKAGE_MANAGER_OPTIONS}\\s+)?${VALIDATION_SCRIPT}|(?:npm|pnpm)${OPAQUE_PACKAGE_MANAGER_OPTIONS}\\s+${TEST_ALIAS_WORD})(?:\\s|$)`, "i");
const RUNTIME_VALUE_FLAGS = new Set([
  "-r", "--require", "--preload", "--import", "-l", "--loader", "--experimental-loader", "--env-file", "--env-file-if-exists", "--conditions", "-C", "--cwd", "-c", "--config",
  "--title", "--redirect-warnings", "--port", "--max-old-space-size", "--inspect-port", "--diagnostic-dir", "--openssl-config", "--icu-data-dir", "--input-type", "--stack-trace-limit",
  "--cpu-prof-name", "--cpu-prof-dir", "--cpu-prof-interval", "--heap-prof-name", "--heap-prof-dir", "--heap-prof-interval", "--elide-lines", "-F", "--filter", "--shell", "--install",
  "--watch-kill-signal", "--fetch-preconnect", "--max-http-header-size", "--dns-result-order", "--disable-warning", "--unhandled-rejections", "--console-depth", "--user-agent",
  "--cron-title", "--cron-period", "--main-fields", "--extension-order", "--tsconfig-override", "-d", "--define", "--drop", "--feature", "--jsx-factory", "--jsx-fragment", "--jsx-import-source", "--jsx-runtime",
]);
const RUNTIME_BOOLEAN_FLAGS = new Set(["--bun", "-b", "--silent", "--no-warnings", "--trace-warnings", "--no-deprecation", "--trace-deprecation", "--watch", "--hot", "--expose-gc", "--preserve-symlinks", "--preserve-symlinks-main"]);

// Unknown prefix flags may consume a value; preserve both interpretations until an entrypoint.
function runtimeLaunches(segment) {
  const words = segment.match(new RegExp(PACKAGE_MANAGER_WORD, "g")) ?? [];
  const runtime = words[0];
  if (runtime === "dev-loops-run") return [`node ${words.slice(words[1] === "--repo-root" ? 3 : 1).join(" ")}`];
  if (runtime !== "bun" && runtime !== "node") return [segment];
  const prefixes = [{ i: 1, ran: false }];
  const launches = [];
  for (let { i, ran } of prefixes) {
    while (i < words.length) {
      const word = words[i];
      if (runtime === "bun" && word === "run" && !ran) { ran = true; i += 1; continue; }
      if (word === "--") { i += 1; break; }
      if (!word.startsWith("-") || word === "--test" || (runtime === "node" && /^--run(?:=|$)/.test(word))) break;
      if (RUNTIME_VALUE_FLAGS.has(word)) { i += 2; continue; }
      if (!word.includes("=") && !RUNTIME_BOOLEAN_FLAGS.has(word) && words[i + 1] && !words[i + 1].startsWith("-")) prefixes.push({ i: i + 2, ran });
      i += 1;
    }
    launches.push([runtime, ...(ran ? ["run"] : []), ...words.slice(i)].join(" "));
  }
  return launches;
}

function hasOnlyExactTestSelectors(args = "") {
  const words = args.trim().split(/\s+/).filter(Boolean);
  let selectors = 0;
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (word.startsWith("-")) {
      if (RUNNER_VALUE_FLAGS.has(word) && !words[++i]) return false;
      continue;
    }
    if (!EXACT_TEST_FILE.test(word)) return false;
    selectors += 1;
  }
  return selectors > 0;
}

/** Classify a shell command's validation reach, including compound commands. */
export function classifyValidationCommand(command) {
  if (/(?:^|[;&|\n])\s*\.\/scripts\/verify\.mjs(?:\s|$)/.test(command)) return "full-repository";
  const suites = new Set();
  let targeted = false;
  for (const { text: segment, uncertain, fullValidation } of normalizedVerificationSegments(command)) {
    if (fullValidation) return "full-repository";
    if (uncertain && /^(?:bun|npm|pnpm|yarn|node|vitest|npx|bunx|dev-loops-run)(?:\s|$)/i.test(segment)) return "full-repository";
    for (const launch of runtimeLaunches(segment)) {
      const scriptPath = launch.match(/^(?:(?:bun(?:\s+run)?|node)\s+)?([\w./-]+\.mjs)(?:\s|$)/)?.[1];
      const normalizedPath = scriptPath ? posix.normalize(scriptPath) : "";
      if (normalizedPath === "verify.mjs" || /(?:^|\/)scripts\/verify\.mjs$/.test(normalizedPath)) return "full-repository";
      const bunTest = launch.match(/^bun\s+test(?:\s+(.*))?$/i);
      if (bunTest) {
        if (!hasOnlyExactTestSelectors(bunTest[1])) return "full-repository";
        targeted = true;
        continue;
      }
      if (TEST_ALIAS.test(segment)) return "full-repository";
      const packageRun = segment.match(PACKAGE_MANAGER_RUN) ?? launch.match(PACKAGE_MANAGER_RUN)
        ?? launch.match(new RegExp(`^node\\s+--run(?:=|\\s+)(${VALIDATION_SCRIPT})(?:\\s|$)`, "i"));
      if (packageRun) {
        const name = packageRun[1].toLowerCase();
        if (["test", "verify"].includes(name)) return "full-repository";
        suites.add(name);
        targeted = true;
        continue;
      }
      if (!PACKAGE_MANAGER_COMMAND.test(segment) && OPAQUE_PACKAGE_MANAGER_RUN.test(segment)) return "full-repository";
      const runner = launch.match(/^(?:(?:bun(?:\s+run)?|node)\s+)?(?:[\w./-]+\/)?run-bun-test\.mjs(?:\s+(.*))?$/);
      if (runner) {
        const args = runner[1] ?? "";
        if (/(?:^|\s)[\w./-]+\.(?:test|spec)\.[cm]?[jt]sx?(?:\s|$)/.test(args) && !hasOnlyExactTestSelectors(args)) return "full-repository";
        if (/(?:^|\s)--all(?:\s|$)/.test(args) || !hasOnlyExactTestSelectors(args)) suites.add("test:all");
        targeted = true;
        continue;
      }
      const direct = launch.match(/^node\s+--test(?:\s+(.*))?$/i) ?? launch.match(VITEST_LAUNCH);
      if (!direct && !OTHER_PACKAGE_RUNNER_COMMAND.test(launch) && OPAQUE_VITEST_LAUNCH.test(launch)) return "full-repository";
      if (direct) {
        if (!hasOnlyExactTestSelectors((direct[1] ?? "").replace(/^run(?:\s|$)/, ""))) return "full-repository";
        targeted = true;
      }
    }
  }
  if (FULL_SUITES.every((suite) => suites.has(suite)) || [...COMPONENT_SUITES].every((suite) => suites.has(suite))) return "full-repository";
  return targeted ? "targeted" : "non-validation";
}


// Read and search programs. Test and build runners (bun, npm, node, vitest, make) are absent.
const READ_PROGRAMS = new Set(['cat', 'head', 'tail', 'wc', 'ls', 'grep', 'rg', 'stat', 'file', 'diff', 'jq', 'find']);
const READ_GIT_SUBCOMMANDS = new Set(['diff', 'log', 'show', 'status', 'ls-files', 'grep', 'blame', 'rev-parse', 'cat-file']);
// Shell-inert commands only: no chaining, redirection, substitution or newlines.
// Quotes and glob characters are denied too: the shell would strip or expand them into flags the gate never saw.
const SHELL_ACTIVE_RE = /[;&|<>`$\n\r(){}\\'"*?[\]]/;

// The reviewer contract's mandated sentinel and bound-escape scripts, and its `cd <worktree> && ...` prefix.
const REVIEWER_SCRIPT_RE = /^dev-loops-run scripts\/github\/(?:verify-fresh-review-context|emit-reviewer-blocked)\.mjs(?: .*)?$/;
const CD_PREFIX_RE = /^cd (?:"[\w./-]+"|[\w./-]+) && /;
const GIT_C_RE = /^git -C (?:"[\w./-]+"|[\w./-]+) /;
// Flags that make an allowed program execute another program or write a file. Git accepts unique prefixes, so match prefixes.
const EXEC_FLAG_RE = /^(?:-[^-\s]*O|--op|--out|--ext|--tex)/;
const RG_PRE_RE = /^--pre(?:-glob)?(?:=|$)/;
const FIND_EXEC_RE = /^-(?:exec|execdir|ok|okdir|delete|fprint\w*|fls)$/;

// A word is fully unquoted, fully single-quoted or fully double-quoted. Returns null for anything else.
// An unquoted `|` alone is the pipe token. Double quotes may not hold `$`, a backtick, `\` or `!`.
function tokenize(command) {
  const words = [];
  let i = 0;
  while (i < command.length) {
    if (/[ \t]/.test(command[i])) {
      i += 1;
      continue;
    }
    const quote = command[i] === "'" || command[i] === '"' ? command[i] : null;
    let value;
    if (quote) {
      const end = command.indexOf(quote, i + 1);
      if (end === -1) return null;
      value = command.slice(i + 1, end);
      if (/[\n\r]/.test(value) || (quote === '"' && /[$`\\!]/.test(value))) return null;
      i = end + 1;
      if (i < command.length && !/[ \t]/.test(command[i])) return null;
    } else {
      let end = i;
      while (end < command.length && !/[ \t]/.test(command[end])) end += 1;
      value = command.slice(i, end);
      if (value !== '|' && SHELL_ACTIVE_RE.test(value)) return null;
      i = end;
    }
    words.push({ value, quoted: quote !== null });
  }
  return words;
}

const CUT_RE = /^-c\d+-\d+$/;

export function isReadSearchCommand(rawCommand) {
  // Strip the mandated `cd <path> && ` and `git -C <path> ` forms first; their paths allow safe characters only.
  const command = rawCommand.trim().replace(CD_PREFIX_RE, '').replace(GIT_C_RE, 'git ');
  if (/[\n\r]/.test(command)) return false;
  const words = tokenize(command);
  if (!words) return false;
  if (REVIEWER_SCRIPT_RE.test(command) && words.every((w) => w.quoted || w.value !== '|')) return true;
  const pipe = words.findIndex((w) => !w.quoted && w.value === '|');
  let readWords = words;
  if (pipe !== -1) {
    // One bounded pipe, to `cut -c<N>-<M>` only.
    const rest = words.slice(pipe + 1);
    if (rest.length !== 2 || rest.some((w) => w.quoted || w.value === '|')) return false;
    if (rest[0].value !== 'cut' || !CUT_RE.test(rest[1].value)) return false;
    readWords = words.slice(0, pipe);
  }
  if (readWords.length === 0 || readWords.some((w) => w.quoted && w.value.startsWith('-'))) return false;
  let tokens = readWords;
  const program = tokens[0];
  if (program.quoted) return false;
  if (program.value === 'git') {
    tokens = tokens.slice(1);
    if (!tokens[0] || tokens[0].quoted || !READ_GIT_SUBCOMMANDS.has(tokens[0].value)) return false;
  } else if (!READ_PROGRAMS.has(program.value)) {
    return false;
  }
  const args = tokens.slice(1).map((w) => w.value);
  if (args.some((t) => EXEC_FLAG_RE.test(t))) return false;
  if (program.value === 'rg' && args.some((t) => RG_PRE_RE.test(t) || /^--host/.test(t))) return false;
  if (program.value === 'file' && args.some((t) => /^-[^-\s]*C/.test(t) || /^--comp/.test(t))) return false;
  if (program.value === 'find' && args.some((t) => FIND_EXEC_RE.test(t))) return false;
  return true;
}

// Read-only commands the review contract mandates (agents/review.agent.md): delta bounds, PR description, angle roles.
const REVIEW_API_ENDPOINT_RE = /^repos\/[\w.-]+\/[\w.-]+\/pulls\/\d+\/(?:reviews|commits)$/;
const REVIEW_PLAIN_VALUE_RE = /^[\w./:=,@#-]+$/;
const REVIEW_RESOLVE_ROLE_RE = /^dev-loops-run cli\/index\.mjs gate resolve-role(?: [\w./:=,@-]+)*$/;

// Accepts one flag set; `valued` flags consume the next word. Returns the positional words, or null on any other flag.
function reviewFlagArgs(words, { bare, valued, getValue = new Set() }) {
  const positional = [];
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    if (bare.has(w)) continue;
    if (valued.has(w)) {
      if (i + 1 >= words.length || (getValue.has(w) && words[i + 1].toUpperCase() !== 'GET')) return null;
      i += 1;
      continue;
    }
    if (w.startsWith('-')) return null;
    positional.push(w);
  }
  return positional;
}

/** Read-only reviewer forms; Pi supplies its installed CLI path to admit the contract's Node helper. */
export function isReviewerContractCommand(rawCommand, trustedCliPath = null) {
  const command = rawCommand.trim();
  if (SHELL_ACTIVE_RE.test(command)) return false;
  if (REVIEW_RESOLVE_ROLE_RE.test(command)) return true;
  const words = command.split(/\s+/);
  if (trustedCliPath && words[0] === 'node' && words[1] === trustedCliPath) {
    return REVIEW_RESOLVE_ROLE_RE.test(['dev-loops-run', 'cli/index.mjs', ...words.slice(2)].join(' '));
  }
  if (words[0] !== 'gh' || words.slice(1).some((w) => !REVIEW_PLAIN_VALUE_RE.test(w) && !w.startsWith('-'))) return false;
  if (words[1] === 'api') {
    const positional = reviewFlagArgs(words.slice(2), { bare: new Set(['--paginate']), valued: new Set(['--jq', '-q', '-X', '--method']), getValue: new Set(['-X', '--method']) });
    return positional?.length === 1 && REVIEW_API_ENDPOINT_RE.test(positional[0]);
  }
  if (words[1] === 'pr' && words[2] === 'view') {
    const positional = reviewFlagArgs(words.slice(3), { bare: new Set(['--comments', '-c']), valued: new Set(['--json', '--jq', '-q', '--repo', '-R']) });
    return positional !== null && positional.length <= 1;
  }
  return false;
}
