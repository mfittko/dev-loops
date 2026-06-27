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

/** Parse the PR number from `gh pr create` stdout (the printed PR URL). */
function parsePrNumberFromGhOutput(text) {
  const match = /\/pull\/(\d+)\b/u.exec(String(text ?? ""));
  if (match) return Number.parseInt(match[1], 10);
  // Fallback: a bare number on its own line (some gh configs print just the URL tail).
  const bare = /(?:^|\s)#?(\d+)\s*$/u.exec(String(text ?? "").trim());
  return bare ? Number.parseInt(bare[1], 10) : null;
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
    hasAcceptanceCriteria: extractSection(markdownText, acHeading) ? true : false,
    hasDefinitionOfDone: extractSection(markdownText, dodHeading) ? true : false,
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
  const planDocRelPath = realRoot ? path.relative(realRoot, safeRealpath(planPath)) : path.basename(planPath);
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

  // Create/switch to the branch (idempotent: -B resets/creates).
  const checkout = await runChildFn("git", ["checkout", "-B", branch], env);
  if (checkout.code !== 0) {
    return fail("git_checkout_failed", checkout.stderr.trim());
  }

  // Stage and commit the plan doc as the spec-of-record.
  const add = await runChildFn("git", ["add", planPath], env);
  if (add.code !== 0) {
    return fail("git_add_failed", add.stderr.trim());
  }
  const commit = await runChildFn(
    "git",
    ["commit", "-m", `docs(plan): promote ${planDocRelPath}`],
    env,
  );
  if (commit.code !== 0) {
    return fail("git_commit_failed", commit.stderr.trim());
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
    return fail("pr_create_failed", prCreate.stderr.trim() || prCreate.stdout.trim());
  }
  const prNumber = parsePrNumberFromGhOutput(prCreate.stdout);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return fail("pr_number_unparseable", prCreate.stdout.trim());
  }

  // Write the PR number back into the plan's front-matter (the plan->PR link),
  // then commit the link so the committed plan doc records its PR.
  const linkedMarkdown = writeLinkedPrNumber(markdownText, prNumber);
  await writeFile(planPath, linkedMarkdown, "utf8");
  await runChildFn("git", ["add", planPath], env);
  await runChildFn(
    "git",
    ["commit", "-m", `docs(plan): link ${planDocRelPath} to PR #${prNumber}`],
    env,
  );

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
