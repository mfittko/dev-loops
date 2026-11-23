#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { spawnRecorded } from "@dev-loops/core/github/gh-call-log";
import { takeGhSlot } from "@dev-loops/core/github/gh-throttle";
import { withSecondaryLimitBackoff } from "@dev-loops/core/github/gh";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { resolveTargetedValidation } from "@dev-loops/core/loop/validation-classify";
import { commandEnv, readBaseValidation } from "./resolve-validation.mjs";
import { checkFixPushAuthority } from "./check-fix-push-authority.mjs";
import { requireTokenValue } from "../_cli-primitives.mjs";
import { defaultInstallDeps, refreshDepsIfChanged } from "./_worktree-deps.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";

const USAGE = `Usage: resolve-pr-conflicts.mjs [--base <branch>] [--repo-root <dir>] [--no-verify] [--push] [--json]

Deterministic, conservative auto-resolve for a PR branch that is behind/CONFLICTING
with its base. Merges \`origin/<base>\` into the current branch and resolves ONLY the
safe additive case: a CHANGELOG.md conflict where both sides only ADD list/section
entries (keep BOTH sides, in order). ANY other conflicted path — or a non-additive
CHANGELOG edit — FAILS CLOSED, naming the conflicted paths. Never guesses.

After an auto-resolved additive CHANGELOG it runs the commands that the default-branch
\`validation.paths\` in \`.devloops\` select for the resolved files (unless --no-verify)
and, with --push, pushes the branch. The selected commands run deduplicated and sorted
(as resolveTargetedValidation returns them), not in config order. A failed command or an unreadable base config resets
the branch to its pre-merge head and fails closed. A clean merge runs no command.

Options:
  --base <branch>     Base branch to merge from (default: derived from \`gh pr view\`
                      base, falling back to "main").
  --repo-root <dir>   Repo working tree to operate in (default: cwd).
  --no-verify         Skip the post-resolve verification commands.
  --push              Push the resolved branch to origin after verify.
  --json              Emit machine-readable JSON on stdout.

Output (stdout, JSON with --json):
  { "ok": true, "action": "clean_merge"|"resolved",
    "base": "main", "resolvedFiles": ["CHANGELOG.md"], "pushed": false,
    "verified": true, "deps"?: { "ok": bool, "ran": bool, "reason"?, "exitCode"?, "stampWritten"? } }
  ("clean_merge" covers an already-up-to-date branch; "resolved" is the
   auto-resolved additive-CHANGELOG case. "verified" is true when every base
   \`validation.paths\` command for the resolved files passed, and false when none applies
   (a clean merge, or a resolved file with no mapped command); it is absent with --no-verify. "deps" is present only when the
   dependency install ran, that is when the fingerprint of bun.lock and the workspace
   package.json files differs from the stamp or no stamp exists.)
Error output:
  { "ok": false, "error": "...", "conflictFiles": ["..."] }

${JQ_OUTPUT_USAGE}
(--jq/--silent apply to the JSON error output always, and to the success output
with --json; the default non-JSON success summary is unaffected.)

Exit codes:
  0  Clean merge (incl. already up to date) or auto-resolved CHANGELOG
  1  Argument error, git failure, or UNRESOLVABLE conflict (fail closed)
  2  Invalid --jq filter`.trim();

const parseError = buildParseError(USAGE);

const SAFE_RESOLVABLE_PATH = "CHANGELOG.md";

// Fallback identity for merge/resolve commits, applied only when the effective
// `user.email` is empty (clean CI / consumer runner). An ambient identity is
// kept: forcing the bot makes GitHub mark signed commits unverified.
// Per-command via -c so we never mutate the repo's config.
const BOT_IDENTITY = [
  "-c", "user.name=dev-loops[bot]",
  "-c", "user.email=dev-loops[bot]@users.noreply.github.com",
];

export function parseResolvePrConflictsCliArgs(argv) {
  const options = {
    help: false,
    base: null,
    repoRoot: process.cwd(),
    verify: true,
    push: false,
    json: false,
  };
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      base: { type: "string" },
      "repo-root": { type: "string" },
      "no-verify": { type: "boolean" },
      push: { type: "boolean" },
      json: { type: "boolean" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  for (const token of tokens) {
    if (token.kind === "positional") throw parseError(`Unknown argument: ${token.value}`);
    if (token.kind !== "option") continue;
    switch (token.name) {
      case "help":
        options.help = true;
        return options;
      case "base": {
        const value = requireTokenValue(token, parseError, { flagPattern: /^-/u }).trim();
        options.base = value.length > 0 ? value : null;
        break;
      }
      case "repo-root": {
        const value = requireTokenValue(token, parseError, { flagPattern: /^-/u }).trim();
        options.repoRoot = value.length > 0 ? value : process.cwd();
        break;
      }
      case "no-verify":
        options.verify = false;
        break;
      case "push":
        options.push = true;
        break;
      case "json":
        options.json = true;
        break;
      default: {
        if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) break;
        throw parseError(`Unknown argument: ${token.rawName}`);
      }
    }
  }
  return options;
}

function run(command, args, { cwd, env = process.env } = {}) {
  const attempt = async () => {
    if (command === "gh") await takeGhSlot({ env, cwd });
    return spawnChild(command, args, { cwd, env });
  };
  return command === "gh" ? withSecondaryLimitBackoff(attempt) : attempt();
}
function spawnChild(command, args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const child = spawnRecorded(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => { resolve({ code, stdout, stderr }); });
  });
}

async function listUnmergedFiles({ cwd, env }) {
  const result = await run("git", ["diff", "--name-only", "--diff-filter=U"], { cwd, env });
  if (result.code !== 0) {
    return [];
  }
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
}

/**
 * Decide whether a single conflicted file is the safe additive CHANGELOG case
 * and, if so, produce the merged content (keep BOTH sides, in order).
 *
 * Requires diff3-style conflict markers so each hunk carries its merge BASE:
 *
 *   <<<<<<< ours
 *   ...ours...
 *   ||||||| base
 *   ...base...
 *   =======
 *   ...theirs...
 *   >>>>>>> theirs
 *
 * STRUCTURAL additivity (not lexical): a hunk is safe to keep-both ONLY when its
 * BASE section is EMPTY — a true insertion on both sides at a spot where base had
 * nothing. A non-empty base means a shared line was MODIFIED or DELETED on at
 * least one side → fail closed (a lexical "looks like a list item" check cannot
 * tell an add from a modify, which silently duplicates/resurrects entries).
 *
 * Keep-both order: ours block then theirs block, preserving each side's order.
 *
 * Same-named `### <Type>` subsections (e.g. both sides add a `### Fixed` block)
 * are MERGED under a single heading via `mergeKeepBothSubsections` so keep-both
 * never emits two consecutive same-named headings (a structurally wrong
 * changelog). Distinct subsections stay separate; item order is preserved.
 */

/**
 * Merge two kept-both conflict blocks, deduping same-named `### <Type>`
 * subsections. Lines before the first `### ` heading are preamble (kept as-is,
 * ours then theirs). Each `### ` heading opens a subsection; a heading that
 * repeats (matched by trimmed text) has its items appended to the first
 * occurrence's body — trimming the seam blanks — instead of opening a second
 * same-named heading. Blocks with no `### ` heading collapse to plain
 * ours-then-theirs concatenation (unchanged behavior).
 */
export function mergeKeepBothSubsections(ours, theirs) {
  const splitSubsections = (lines) => {
    const preamble = [];
    const sections = [];
    let current = null;
    for (const line of lines) {
      if (/^###\s/.test(line)) {
        current = { heading: line, body: [] };
        sections.push(current);
      } else if (current) {
        current.body.push(line);
      } else {
        preamble.push(line);
      }
    }
    return { preamble, sections };
  };

  const a = splitSubsections(ours);
  const b = splitSubsections(theirs);
  const out = [...a.preamble, ...b.preamble];
  const merged = [];
  const byHeading = new Map();
  for (const section of [...a.sections, ...b.sections]) {
    const key = section.heading.trim();
    const existing = byHeading.get(key);
    if (existing) {
      while (existing.body.length > 0 && existing.body[existing.body.length - 1].trim() === "") {
        existing.body.pop();
      }
      let start = 0;
      while (start < section.body.length && section.body[start].trim() === "") {
        start += 1;
      }
      existing.body.push(...section.body.slice(start));
    } else {
      const copy = { heading: section.heading, body: [...section.body] };
      byHeading.set(key, copy);
      merged.push(copy);
    }
  }
  for (const section of merged) {
    out.push(section.heading, ...section.body);
  }
  return out;
}

export function resolveAdditiveChangelog(content) {
  const lines = content.split("\n");
  const out = [];
  let i = 0;
  let resolvedAnyHunk = false;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.startsWith("<<<<<<<")) {
      out.push(line);
      i += 1;
      continue;
    }
    // Conflict hunk: <<<<<<< ours ... ||||||| base ... ======= ... >>>>>>> theirs
    const ours = [];
    const base = [];
    const theirs = [];
    i += 1; // skip <<<<<<<
    while (i < lines.length && !lines[i].startsWith("|||||||") && !lines[i].startsWith("=======")) {
      ours.push(lines[i]);
      i += 1;
    }
    if (i >= lines.length) {
      return { safe: false, reason: "malformed conflict markers (no ======= separator)" };
    }
    if (!lines[i].startsWith("|||||||")) {
      // No base section ⇒ not diff3 style; we cannot tell add from modify.
      return { safe: false, reason: "missing diff3 base section (||||||| marker)" };
    }
    i += 1; // skip |||||||
    while (i < lines.length && !lines[i].startsWith("=======")) {
      base.push(lines[i]);
      i += 1;
    }
    if (i >= lines.length) {
      return { safe: false, reason: "malformed conflict markers (no ======= separator)" };
    }
    i += 1; // skip =======
    while (i < lines.length && !lines[i].startsWith(">>>>>>>")) {
      theirs.push(lines[i]);
      i += 1;
    }
    if (i >= lines.length) {
      return { safe: false, reason: "malformed conflict markers (no >>>>>>> terminator)" };
    }
    i += 1; // skip >>>>>>>

    // Additive ⇔ base had no line here (both sides inserted). Any non-empty base
    // section is a modify/delete of a shared line → fail closed.
    if (base.some((b) => b.trim().length > 0)) {
      return { safe: false, reason: "CHANGELOG conflict modifies or deletes a shared line (non-empty merge base)" };
    }
    // Keep both sides, in order — merging any same-named `### <Type>`
    // subsection so keep-both never emits two consecutive same-named headings.
    out.push(...mergeKeepBothSubsections(ours, theirs));
    resolvedAnyHunk = true;
  }

  if (!resolvedAnyHunk) {
    return { safe: false, reason: "no conflict hunks found in CHANGELOG.md" };
  }
  return { safe: true, content: out.join("\n") };
}

async function abortMerge({ cwd, env }) {
  await run("git", ["merge", "--abort"], { cwd, env });
}

export async function resolvePrConflicts(options, { env = process.env, runVerification = run, installDeps = defaultInstallDeps, readBase = readBaseValidation } = {}) {
  const cwd = options.repoRoot;
  const headResult = await run("git", ["rev-parse", "HEAD"], { cwd, env });
  const preMergeHead = headResult.stdout.trim();
  if (headResult.code !== 0 || !preMergeHead) {
    throw new Error(`git rev-parse HEAD failed: ${headResult.stderr.trim() || `exit ${headResult.code}`}`);
  }

  // Resolve base branch: explicit flag, else `gh pr view`, else "main".
  let base = options.base;
  if (!base) {
    const view = await run("gh", ["pr", "view", "--json", "baseRefName"], { cwd, env });
    if (view.code === 0) {
      try {
        const parsed = JSON.parse(view.stdout);
        if (typeof parsed?.baseRefName === "string" && parsed.baseRefName.trim().length > 0) {
          base = parsed.baseRefName.trim();
        }
      } catch {
        // fall through to default
      }
    }
    if (!base) {
      base = "main";
    }
  }

  const fetch = await run("git", ["fetch", "origin", base], { cwd, env });
  if (fetch.code !== 0) {
    throw new Error(`git fetch origin ${base} failed: ${fetch.stderr.trim() || `exit ${fetch.code}`}`);
  }

  // A base merge inside an open fix sequence is a foreign commit that stalls the delta review (PRE-PUSH-DELTA-PUSH-AUTHORITY); an up-to-date branch merges nothing, so it is exempt.
  const upToDate = (await run("git", ["merge-base", "--is-ancestor", `origin/${base}`, "HEAD"], { cwd, env })).code === 0;
  if (!upToDate) {
    const branch = (await run("git", ["symbolic-ref", "--short", "-q", "HEAD"], { cwd, env })).stdout.trim();
    const authority = checkFixPushAuthority(cwd, [{ sha: preMergeHead, ...(branch ? { remoteRef: `refs/heads/${branch}` } : {}) }]);
    if (!authority.ok) {
      throw new Error(`base_merge_inside_sequence: ${authority.reason} A fix commit ends the sequence with the delta review and the full-phase push, or with the authenticated head_moved closure; then rerun resolve-pr-conflicts.mjs.`);
    }
  }

  const userEmail = await run("git", ["config", "user.email"], { cwd, env });
  const identity = userEmail.stdout.trim() ? [] : BOT_IDENTITY;

  // diff3 conflict style so conflict hunks carry the merge BASE — the additive
  // CHANGELOG resolver needs it to tell a true insertion from a modify/delete.
  const merge = await run("git", [...identity, "-c", "merge.conflictStyle=diff3", "merge", "--no-edit", `origin/${base}`], { cwd, env });
  if (merge.code === 0) {
    const result = { ok: true, action: "clean_merge", base, resolvedFiles: [], pushed: false };
    await afterResolve(result, options, { cwd, env, runVerification, installDeps, readBase, preMergeHead });
    return result;
  }

  // Merge failed — inspect conflicts.
  const conflictFiles = await listUnmergedFiles({ cwd, env });
  if (conflictFiles.length === 0) {
    await abortMerge({ cwd, env });
    throw new Error(`git merge origin/${base} failed without resolvable conflicts: ${merge.stderr.trim() || `exit ${merge.code}`}`);
  }

  // Fail closed on ANY conflicted path other than the single safe CHANGELOG case.
  const nonSafe = conflictFiles.filter((file) => file !== SAFE_RESOLVABLE_PATH);
  if (nonSafe.length > 0) {
    await abortMerge({ cwd, env });
    const err = new Error(
      `Unresolvable merge conflict: only additive ${SAFE_RESOLVABLE_PATH} conflicts are auto-resolved. `
      + `Conflicting paths: ${conflictFiles.join(", ")}. Resolve manually.`,
    );
    err.conflictFiles = conflictFiles;
    throw err;
  }

  // Sole conflict is CHANGELOG.md — attempt the safe additive resolution.
  const changelogPath = path.join(cwd, SAFE_RESOLVABLE_PATH);
  const content = await readFile(changelogPath, "utf8");
  const resolution = resolveAdditiveChangelog(content);
  if (!resolution.safe) {
    await abortMerge({ cwd, env });
    const err = new Error(
      `Unresolvable ${SAFE_RESOLVABLE_PATH} conflict (${resolution.reason}); not purely additive, so it fails closed. `
      + `Conflicting paths: ${SAFE_RESOLVABLE_PATH}. Resolve manually.`,
    );
    err.conflictFiles = [SAFE_RESOLVABLE_PATH];
    throw err;
  }

  await writeFile(changelogPath, resolution.content, "utf8");
  const add = await run("git", ["add", SAFE_RESOLVABLE_PATH], { cwd, env });
  if (add.code !== 0) {
    await abortMerge({ cwd, env });
    throw new Error(`git add ${SAFE_RESOLVABLE_PATH} failed: ${add.stderr.trim() || `exit ${add.code}`}`);
  }
  const commit = await run("git", [...identity, "commit", "--no-edit"], { cwd, env });
  if (commit.code !== 0) {
    await abortMerge({ cwd, env });
    throw new Error(`git commit (merge) failed: ${commit.stderr.trim() || `exit ${commit.code}`}`);
  }

  const result = { ok: true, action: "resolved", base, resolvedFiles: [SAFE_RESOLVABLE_PATH], pushed: false };
  await afterResolve(result, options, { cwd, env, runVerification, installDeps, readBase, preMergeHead });
  return result;
}

async function afterResolve(result, options, { cwd, env, runVerification, installDeps, readBase, preMergeHead }) {
  // The merge may have pulled in a new dependency; install before verification or a later commit hook runs against stale node_modules.
  let root = cwd;
  try {
    root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || cwd;
  } catch {
    // not a git checkout: keep cwd
  }
  const deps = refreshDepsIfChanged(root, installDeps);
  if (deps.ran) result.deps = deps;
  if (options.verify) {
    result.verified = false;
    // Git authored a clean merge; current-head CI stays its validation authority.
    if (result.resolvedFiles.length > 0) {
      const failVerify = async (message) => {
        // Drop the unverified merge commit so a re-run repeats the merge and the verification.
        const reset = await run("git", ["reset", "--keep", preMergeHead], { cwd, env });
        let full = message;
        if (reset.code !== 0) {
          const current = (await run("git", ["rev-parse", "HEAD"], { cwd, env })).stdout.trim();
          full = `${message}; ${reset.stderr.trim() || `git reset exit ${reset.code}`}; rollback failed; HEAD left at ${current}`;
        }
        const err = new Error(full);
        err.verifyFailed = true;
        throw err;
      };
      try {
        const base = readBase(root);
        if (base.reason) await failVerify(`Post-resolve verification refused: ${base.reason}`);
        // Only the base block runs; the checkout's own validation block is never read.
        // A full-repository profile (unmapped file) runs nothing here.
        const selected = resolveTargetedValidation(result.resolvedFiles, base.validation.paths);
        if (selected.profile === "targeted") {
          for (const command of selected.commands) {
            const verify = await runVerification("sh", ["-c", command], { cwd: root, env: commandEnv(env) });
            if (verify.code !== 0) await failVerify(`Post-resolve verification (${command}) failed: ${verify.stderr.trim() || verify.stdout.trim() || `exit ${verify.code}`}`);
          }
          result.verified = true;
        }
      } catch (error) {
        // A thrown base read or spawn error must still drop the unverified merge commit.
        if (error.verifyFailed) throw error;
        await failVerify(`Post-resolve verification error: ${error.message}`);
      }
    }
  }
  if (options.push) {
    const push = await run("git", ["push"], { cwd, env });
    if (push.code !== 0) {
      throw new Error(`git push failed: ${push.stderr.trim() || `exit ${push.code}`}`);
    }
    result.pushed = true;
  }
}

export async function runCli(argv, { stdout = process.stdout, stderr = process.stderr, env = process.env } = {}) {
  let options;
  try {
    options = parseResolvePrConflictsCliArgs(argv);
  } catch (error) {
    stderr.write(`${formatCliError(error)}\n`);
    return 1;
  }
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }
  try {
    const result = await resolvePrConflicts(options, { env });
    if (options.json) {
      return emitResult(result, { jq: options.jq, silent: options.silent, stdout, stderr });
    }
    stdout.write(`${result.action} (base ${result.base}${result.resolvedFiles.length ? `, resolved ${result.resolvedFiles.join(", ")}` : ""}${result.pushed ? ", pushed" : ""})\n`);
    return 0;
  } catch (error) {
    const payload = { ok: false, error: error instanceof Error ? error.message : String(error) };
    if (Array.isArray(error?.conflictFiles)) {
      payload.conflictFiles = error.conflictFiles;
    }
    return emitResult(payload, { jq: options.jq, silent: options.silent, stdout: stderr, stderr });
  }
}

if (isDirectCliRun(import.meta.url)) {
  runCli(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
