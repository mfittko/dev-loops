#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { requireTokenValue } from "../_cli-primitives.mjs";

const USAGE = `Usage: resolve-pr-conflicts.mjs [--base <branch>] [--repo-root <dir>] [--no-verify] [--push] [--json]

Deterministic, conservative auto-resolve for a PR branch that is behind/CONFLICTING
with its base. Merges \`origin/<base>\` into the current branch and resolves ONLY the
safe additive case: a CHANGELOG.md conflict where both sides only ADD list/section
entries (keep BOTH sides, in order). ANY other conflicted path — or a non-additive
CHANGELOG edit — FAILS CLOSED, naming the conflicted paths. Never guesses.

After a clean merge (or an auto-resolved additive CHANGELOG) it runs \`npm run test:docs\`
(unless --no-verify) and, with --push, pushes the branch.

Options:
  --base <branch>     Base branch to merge from (default: derived from \`gh pr view\`
                      base, falling back to "main").
  --repo-root <dir>   Repo working tree to operate in (default: cwd).
  --no-verify         Skip \`npm run test:docs\` after resolving.
  --push              Push the resolved branch to origin after verify.
  --json              Emit machine-readable JSON on stdout.

Output (stdout, JSON with --json):
  { "ok": true, "action": "clean_merge"|"resolved",
    "base": "main", "resolvedFiles": ["CHANGELOG.md"], "pushed": false,
    "verified": true }
  ("clean_merge" covers an already-up-to-date branch; "resolved" is the
   auto-resolved additive-CHANGELOG case. "verified" is true when post-resolve
   verification ran; it is absent with --no-verify.)
Error output:
  { "ok": false, "error": "...", "conflictFiles": ["..."] }

Exit codes:
  0  Clean merge (incl. already up to date) or auto-resolved CHANGELOG
  1  Argument error, git failure, or UNRESOLVABLE conflict (fail closed)`.trim();

const parseError = buildParseError(USAGE);

const SAFE_RESOLVABLE_PATH = "CHANGELOG.md";

// Identity for merge/resolve commits so auto-resolve works on a clean runner
// (CI / consumer) where no ambient git user is configured. Per-command via -c
// so we never mutate the repo's config.
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
      default:
        throw parseError(`Unknown argument: ${token.rawName}`);
    }
  }
  return options;
}

function run(command, args, { cwd, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
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
 */
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
    // Keep both sides, in order.
    out.push(...ours, ...theirs);
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

export async function resolvePrConflicts(options, { env = process.env } = {}) {
  const cwd = options.repoRoot;

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

  // diff3 conflict style so conflict hunks carry the merge BASE — the additive
  // CHANGELOG resolver needs it to tell a true insertion from a modify/delete.
  const merge = await run("git", [...BOT_IDENTITY, "-c", "merge.conflictStyle=diff3", "merge", "--no-edit", `origin/${base}`], { cwd, env });
  if (merge.code === 0) {
    const result = { ok: true, action: "clean_merge", base, resolvedFiles: [], pushed: false };
    await afterResolve(result, options, { cwd, env });
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
  const commit = await run("git", [...BOT_IDENTITY, "commit", "--no-edit"], { cwd, env });
  if (commit.code !== 0) {
    await abortMerge({ cwd, env });
    throw new Error(`git commit (merge) failed: ${commit.stderr.trim() || `exit ${commit.code}`}`);
  }

  const result = { ok: true, action: "resolved", base, resolvedFiles: [SAFE_RESOLVABLE_PATH], pushed: false };
  await afterResolve(result, options, { cwd, env });
  return result;
}

async function afterResolve(result, options, { cwd, env }) {
  if (options.verify) {
    const verify = await run("npm", ["run", "test:docs"], { cwd, env });
    if (verify.code !== 0) {
      const err = new Error(`Post-resolve verification (npm run test:docs) failed: ${verify.stderr.trim() || verify.stdout.trim() || `exit ${verify.code}`}`);
      err.verifyFailed = true;
      throw err;
    }
    result.verified = true;
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
      stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      stdout.write(`${result.action} (base ${result.base}${result.resolvedFiles.length ? `, resolved ${result.resolvedFiles.join(", ")}` : ""}${result.pushed ? ", pushed" : ""})\n`);
    }
    return 0;
  } catch (error) {
    const payload = { ok: false, error: error instanceof Error ? error.message : String(error) };
    if (Array.isArray(error?.conflictFiles)) {
      payload.conflictFiles = error.conflictFiles;
    }
    stderr.write(`${JSON.stringify(payload)}\n`);
    return 1;
  }
}

if (isDirectCliRun(import.meta.url)) {
  runCli(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
