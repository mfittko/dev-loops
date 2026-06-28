#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { buildParseError, formatCliError } from "../_core-helpers.mjs";
import { requireTokenValue, runChild } from "../_cli-primitives.mjs";
import { validatePlanFile } from "./validate-plan-file.mjs";
import { extractSection, isDirectCliRun } from "./_refine-helpers.mjs";
import { PLAN_FILE_REFINEMENT_SECTIONS } from "@dev-loops/core/loop/plan-file-intake-contract";
import {
  evaluatePromoteEligibility,
  buildPromotionPrBody,
  readLinkedPrNumber,
  writeLinkedPrNumber,
  PLAN_FILE_PROMOTE_ACTION,
} from "@dev-loops/core/loop/plan-file-promote-contract";

const CREATE_PR_PATH = fileURLToPath(new URL("../github/create-pr.mjs", import.meta.url));

const USAGE = `Usage:
  promote-plan.mjs --plan-file <path> [--base <branch>] [--branch <name>] [--json]
PR-FIRST promotion of a refined plan file. When the plan is in P3's ready
state (plan_refined_ready_for_promotion), commit the plan doc to a branch and
open EXACTLY ONE draft PR via the canonical create-pr.mjs wrapper. NO GitHub
issue is ever created: the committed plan doc is the spec-of-record and the PR
body links it and carries the full Acceptance criteria + Definition of done.
The PR number is written back into the plan doc's front-matter (prNumber:),
forming the bidirectional plan<->PR link. The opened draft PR enters the
existing loop unchanged via \`loop startup --pr <n>\`.

Fail-closed: unless the plan is in the ready state this makes ZERO GitHub
mutation and exits 1. Idempotent: a plan already linked to a PR (prNumber in
front-matter) opens nothing and reports the existing PR.

Required:
  --plan-file <path>  Path to the refined plan file to promote
Optional:
  --base <branch>     Base branch for the PR (default: main)
  --branch <name>     Branch name to commit the plan on (default: derived from the plan path)
  --json              Machine-readable JSON output
  --help              Show this help
Exit codes:
  0  Promotion succeeded (or idempotent no-op for an already-linked plan)
  1  Argument error, or fail-closed (plan not ready / git / PR-create failure); no issue ever created`.trim();

const parseError = buildParseError(USAGE);

export function parsePromotePlanCliArgs(argv) {
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      "plan-file": { type: "string" },
      base: { type: "string" },
      branch: { type: "string" },
      json: { type: "boolean" },
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  const options = { help: false, planFile: undefined, base: "main", branch: undefined, json: false };
  for (const token of tokens) {
    if (token.kind === "positional") {
      throw parseError(`Unknown argument: ${token.value}`);
    }
    if (token.kind !== "option") continue;
    if (token.name === "help") {
      options.help = true;
      return options;
    }
    if (token.name === "plan-file") {
      options.planFile = requireTokenValue(token, parseError, { flagPattern: /^-/u });
      continue;
    }
    if (token.name === "base") {
      options.base = requireTokenValue(token, parseError, { flagPattern: /^-/u });
      continue;
    }
    if (token.name === "branch") {
      options.branch = requireTokenValue(token, parseError, { flagPattern: /^-/u });
      continue;
    }
    if (token.name === "json") {
      options.json = true;
      continue;
    }
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (typeof options.planFile !== "string" || options.planFile.trim().length === 0) {
    throw parseError("promote-plan requires --plan-file <path>");
  }
  return options;
}

/** Resolve a path through realpath, falling back to the input when it cannot. */
function safeRealpath(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Derive a stable branch name from the plan-doc path when --branch is absent. */
function defaultBranchName(planPath) {
  const base = path.basename(planPath).replace(/\.[^.]+$/u, "");
  const slug = base.replace(/[^a-zA-Z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "").toLowerCase() || "plan";
  return `promote-plan/${slug}`;
}

/**
 * Parse the PR number from `gh pr create` stdout, which prints the PR URL.
 * Only the `/pull/<n>` form is trusted; anything else fails closed via the
 * caller's `pr_number_unparseable` path rather than guessing from a trailing
 * number (which could mis-bind an unrelated PR from stdout noise).
 */
function parsePrNumberFromGhOutput(text) {
  const match = /\/pull\/(\d+)\b/u.exec(String(text ?? ""));
  return match ? Number.parseInt(match[1], 10) : null;
}

function emit(stdout, json, summary, humanLines) {
  if (json) {
    stdout.write(`${JSON.stringify(summary)}\n`);
  } else {
    stdout.write(`${humanLines.join("\n")}\n`);
  }
}

export async function runCli(argv = process.argv.slice(2), {
  stdout = process.stdout,
  runChildFn = runChild,
  env = process.env,
} = {}) {
  const options = parsePromotePlanCliArgs(argv);
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return { ok: true, help: true };
  }

  const planPath = path.resolve(options.planFile);
  const markdownText = await readFile(planPath, "utf8");

  // Compute the section-presence facts with the P1 surfaces and read the
  // existing plan->PR link from front-matter, then hand them to the pure
  // eligibility decision. The decision owns the ready-state gate; this script
  // owns all I/O (git + create-pr + write-back).
  const [acHeading, dodHeading] = PLAN_FILE_REFINEMENT_SECTIONS;
  const existingPrNumber = readLinkedPrNumber(markdownText);
  const decision = evaluatePromoteEligibility({
    baseSectionsValid: validatePlanFile(markdownText).ok,
    hasAcceptanceCriteria: Boolean(extractSection(markdownText, acHeading)),
    hasDefinitionOfDone: Boolean(extractSection(markdownText, dodHeading)),
    existingPrNumber,
  });

  if (!decision.ok) {
    // Fail closed: no git, no gh, no issue — surface the reason and stop.
    const summary = { ok: false, reason: decision.reason, planFileIntakeState: decision.planFileIntakeState ?? null };
    emit(stdout, options.json, summary, [`promote-plan: FAIL (${decision.reason})`]);
    process.exitCode = 1;
    return summary;
  }

  // Idempotent no-op: plan already linked to a PR. Open nothing, report it.
  if (decision.action === PLAN_FILE_PROMOTE_ACTION.ALREADY_PROMOTED) {
    const summary = {
      ok: true,
      action: PLAN_FILE_PROMOTE_ACTION.ALREADY_PROMOTED,
      planFile: planPath,
      prNumber: decision.existingPrNumber,
    };
    emit(stdout, options.json, summary, [
      "promote-plan: PASS (already promoted)",
      `  plan: ${planPath}`,
      `  pr: #${decision.existingPrNumber} (existing; opened nothing)`,
    ]);
    return summary;
  }

  // --- Promote path: commit the plan doc, open exactly one draft PR. ---
  const repoRoot = (await runChildFn("git", ["rev-parse", "--show-toplevel"], env)).stdout.trim();
  // Normalize both sides through realpath so a /var -> /private/var (or similar)
  // symlink between the resolved plan path and git's toplevel does not yield a
  // spurious `../..` relative path.
  const realRoot = repoRoot ? safeRealpath(repoRoot) : null;
  // Normalize to POSIX separators so the repo-relative path is identical on
  // Windows and stays linkable in the commit messages and PR body.
  const planDocRelPath = (realRoot ? path.relative(realRoot, safeRealpath(planPath)) : path.basename(planPath))
    .split(path.sep)
    .join("/");
  const acceptanceCriteria = extractSection(markdownText, acHeading);
  const definitionOfDone = extractSection(markdownText, dodHeading);
  const prBody = buildPromotionPrBody({
    planDocPath: planDocRelPath,
    acceptanceCriteria,
    definitionOfDone,
  });

  const branch = options.branch && options.branch.trim().length > 0
    ? options.branch.trim()
    : defaultBranchName(planPath);

  const fail = (reason, detail) => {
    const summary = { ok: false, reason, detail: detail ?? null, planFile: planPath };
    emit(stdout, options.json, summary, [`promote-plan: FAIL (${reason})${detail ? `: ${detail}` : ""}`]);
    process.exitCode = 1;
    return summary;
  };

  // Non-destructive branch selection: reuse an existing branch (never `-B`,
  // which resets the ref and would discard unrelated commits on a same-named
  // branch), else create it. Keeps reruns idempotent without rewriting history.
  const branchExists =
    (await runChildFn("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], env)).code === 0;
  const checkout = await runChildFn(
    "git",
    ["checkout", ...(branchExists ? [branch] : ["-b", branch])],
    env,
  );
  if (checkout.code !== 0) {
    return fail("git_checkout_failed", checkout.stderr.trim());
  }

  // Stage and commit the plan doc as the spec-of-record. The commit is made
  // re-runnable: if a prior partial run already committed the plan (plan at
  // HEAD, no PR), there is nothing to stage, so we skip the commit instead of
  // failing `git_commit_failed` and continue on to push + pr-create. This lets
  // a partial state (plan committed, no prNumber) recover on a plain re-run.
  const add = await runChildFn("git", ["add", "--", planPath], env);
  if (add.code !== 0) {
    return fail("git_add_failed", add.stderr.trim());
  }
  // `git diff --cached --quiet` exits 0 when the index matches HEAD (nothing to
  // commit), 1 when there are staged changes, and >1 (e.g. 128) on a real git
  // error. Treat the codes explicitly: only 1 means "commit"; an error code must
  // fail closed rather than be misread as staged (which would attempt a commit
  // and surface a misleading git_commit_failed).
  const diff = await runChildFn("git", ["diff", "--cached", "--quiet"], env);
  if (diff.code !== 0 && diff.code !== 1) {
    return fail("git_diff_failed", `git diff --cached --quiet exited ${diff.code}${diff.stderr.trim() ? `: ${diff.stderr.trim()}` : ""}`);
  }
  const hasStaged = diff.code === 1;
  if (hasStaged) {
    const commit = await runChildFn(
      "git",
      ["commit", "-m", `docs(plan): promote ${planDocRelPath}`],
      env,
    );
    if (commit.code !== 0) {
      return fail("git_commit_failed", commit.stderr.trim());
    }
  }

  // Push the head branch to the remote BEFORE opening the PR. A fresh local
  // branch absent on the remote makes `gh pr create --head <branch>` fail, which
  // would commit the plan but open no PR — the unrecoverable partial state this
  // fix targets. Pushing first guarantees the head ref exists for gh.
  const push = await runChildFn("git", ["push", "-u", "origin", branch], env);
  if (push.code !== 0) {
    return fail("git_push_failed", push.stderr.trim() || push.stdout.trim());
  }

  // Open EXACTLY ONE draft PR via the canonical wrapper (never raw gh).
  // create-pr.mjs injects --draft and --assignee @me; the PR body is passed via
  // --body so it links the plan doc and carries the full AC + DoD.
  const prCreate = await runChildFn(
    process.execPath,
    [
      CREATE_PR_PATH,
      "--base", options.base,
      "--head", branch,
      "--title", `Promote plan: ${planDocRelPath}`,
      "--body", prBody,
    ],
    env,
  );
  if (prCreate.code !== 0) {
    // No PR was opened, but the plan is committed and the branch is pushed —
    // a recoverable partial state. Mirror the post-PR-open recovery hints: keep
    // it fail-closed (exit 1, reason pr_create_failed) while telling the
    // operator that a plain re-run recovers, since the commit step is
    // idempotent (skips when nothing is staged) and the push is idempotent too.
    const detail = prCreate.stderr.trim() || prCreate.stdout.trim();
    const summary = {
      ok: false,
      reason: "pr_create_failed",
      detail: detail || null,
      planFile: planPath,
      branch,
      recovery: `gh pr create failed, so no PR was opened, but the plan is committed and branch ${branch} is pushed. Re-run promote-plan to recover: the commit step is idempotent (skips when nothing is staged) and the push is idempotent, so a clean re-run will retry opening the PR.`,
    };
    emit(stdout, options.json, summary, [
      `promote-plan: FAIL (pr_create_failed)${detail ? `: ${detail}` : ""}`,
      `  branch: ${branch} (committed and pushed; no PR opened — re-run promote-plan to recover, it is idempotent and will retry opening the PR)`,
    ]);
    process.exitCode = 1;
    return summary;
  }
  const prNumber = parsePrNumberFromGhOutput(prCreate.stdout);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    // create-pr returned success, so the draft PR IS open — this is a
    // post-mutation failure, not a clean fail-closed. Surface a recovery hint
    // (the PR number could not be parsed from gh's output) referencing the head
    // branch so the operator can find the open PR and link it manually.
    const summary = {
      ok: false,
      reason: "pr_number_unparseable",
      detail: prCreate.stdout.trim() || null,
      planFile: planPath,
      branch,
      recovery: `A draft PR was opened on branch ${branch} but its number could not be parsed from gh output. Find it with: gh pr list --head "${branch}" --json number,url. Then record the link with: node scripts/refine/promote-plan.mjs is idempotent only once the front-matter prNumber is set, so add it manually (prNumber: <n>) and commit ${planDocRelPath}.`,
    };
    emit(stdout, options.json, summary, [
      `promote-plan: FAIL (pr_number_unparseable)`,
      `  branch: ${branch} (a draft PR is open; its number could not be parsed — recover via 'gh pr list --head "${branch}"')`,
    ]);
    process.exitCode = 1;
    return summary;
  }

  // Write the PR number back into the plan's front-matter (the plan->PR link),
  // then commit the link so the committed plan doc records its PR. The PR is
  // ALREADY open here, so a write-back failure is NOT a clean fail-closed: the
  // tracker artifact exists. Surface it with the open PR number and a recovery
  // hint instead of reporting success — otherwise the uncommitted link leaves a
  // partial state that defeats idempotency (a re-run sees no prNumber, re-enters
  // promote, and gh rejects the already-open head).
  const failAfterPrOpen = (reason, detail) => {
    const summary = {
      ok: false,
      reason,
      detail: detail ?? null,
      planFile: planPath,
      branch,
      prNumber,
      recovery: `PR #${prNumber} is open but the plan->PR link commit failed. ${planDocRelPath} now carries prNumber: ${prNumber} in its front-matter; record the link with: git add -- "${planDocRelPath}" && git commit -m "docs(plan): link to PR #${prNumber}" && git push.`,
    };
    emit(stdout, options.json, summary, [
      `promote-plan: FAIL (${reason})${detail ? `: ${detail}` : ""}`,
      `  pr: #${prNumber} (open; plan->PR link NOT committed — recover manually)`,
    ]);
    process.exitCode = 1;
    return summary;
  };
  const linkedMarkdown = writeLinkedPrNumber(markdownText, prNumber);
  await writeFile(planPath, linkedMarkdown, "utf8");
  const linkAdd = await runChildFn("git", ["add", "--", planPath], env);
  if (linkAdd.code !== 0) {
    return failAfterPrOpen("git_link_add_failed", linkAdd.stderr.trim());
  }
  const linkCommit = await runChildFn(
    "git",
    ["commit", "-m", `docs(plan): link ${planDocRelPath} to PR #${prNumber}`],
    env,
  );
  if (linkCommit.code !== 0) {
    return failAfterPrOpen("git_link_commit_failed", linkCommit.stderr.trim());
  }

  const summary = {
    ok: true,
    action: PLAN_FILE_PROMOTE_ACTION.PROMOTE,
    planFile: planPath,
    planDocPath: planDocRelPath,
    branch,
    prNumber,
  };
  emit(stdout, options.json, summary, [
    "promote-plan: PASS",
    `  plan: ${planPath}`,
    `  branch: ${branch}`,
    `  pr: #${prNumber} (draft; no issue created)`,
  ]);
  return summary;
}

if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  });
}
