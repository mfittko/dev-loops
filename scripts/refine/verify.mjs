#!/usr/bin/env node
import { buildParseError, formatCliError } from "../_core-helpers.mjs";
import { parseArgs } from "node:util";
import { parsePositiveInteger, requireTokenValue } from "../_cli-primitives.mjs";
import { detectRepoSlug, parseRepoSlug } from "@dev-loops/core/github/repo-slug";

import { isDirectCliRun, loadTreeFromInput, loadTreeOnline } from "./_refine-helpers.mjs";
import { runProseLinkageDetector } from "./prose-linkage-detector.mjs";
import { runScopeBoundaryCrossChecker } from "./scope-boundary-cross-checker.mjs";
import { runRefinementCompletenessChecker } from "./refinement-completeness-checker.mjs";
import { runTreeIntegrityValidator } from "./tree-integrity-validator.mjs";

const USAGE = `Usage:
  dev-loops refine verify --issue <number> [--repo <owner/name>] [--json]
  dev-loops refine verify --input <path> [--json]
Run epic-tree refinement verification with four checkers:
  1) prose-linkage-detector
  2) scope-boundary-cross-checker
  3) refinement-completeness-checker
  4) tree-integrity-validator

Required (exactly one mode):
  --issue <number>          Online mode: fetch tree via GitHub sub-issues API (use --repo or git remote)
  --input <path>            Offline mode: validate local tree JSON snapshot

Optional:
  --repo <owner/name>       Repository slug for online mode
  --json                    Machine-readable JSON output (default: human-readable summary)
  --help                    Show this help`.trim();

const parseError = buildParseError(USAGE);

export function parseRefineVerifyCliArgs(argv) {
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      issue: { type: "string" },
      repo: { type: "string" },
      input: { type: "string" },
      json: { type: "boolean" },
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  const options = {
    help: false,
    issue: undefined,
    repo: undefined,
    input: undefined,
    json: false,
  };

  for (const token of tokens) {
    if (token.kind === "positional") {
      throw parseError(`Unknown argument: ${token.value}`);
    }
    if (token.kind !== "option") {
      continue;
    }
    if (token.name === "help") {
      options.help = true;
      return options;
    }
    if (token.name === "issue") {
      options.issue = parsePositiveInteger(requireTokenValue(token, parseError), "Issue number", parseError);
      continue;
    }
    if (token.name === "repo") {
      options.repo = requireTokenValue(token, parseError, { flagPattern: /^-/u });
      continue;
    }
    if (token.name === "input") {
      options.input = requireTokenValue(token, parseError, { flagPattern: /^-/u });
      continue;
    }
    if (token.name === "json") {
      options.json = true;
      continue;
    }
    throw parseError(`Unknown argument: ${token.rawName}`);
  }

  const hasIssueMode = options.issue !== undefined;
  const hasInputMode = typeof options.input === "string";
  if (hasIssueMode === hasInputMode) {
    throw parseError("Specify exactly one of --issue <number> or --input <path>");
  }

  if (options.repo !== undefined && !hasIssueMode) {
    throw parseError("--repo is only valid with --issue mode");
  }

  if (typeof options.repo === "string") {
    try { parseRepoSlug(options.repo, { errorMessage: "--repo must match <owner/name>" }); } catch (err) { throw parseError(err.message); }
  }

  return options;
}

function runAllCheckers(tree) {
  const checks = [
    runProseLinkageDetector(tree),
    runScopeBoundaryCrossChecker(tree),
    runRefinementCompletenessChecker(tree),
    runTreeIntegrityValidator(tree),
  ];

  const errors = checks.flatMap((check) => check.errors.map((error) => ({ checker: check.checker, ...error })));

  return {
    ok: checks.every((check) => check.ok),
    checks,
    errors,
  };
}

function writeHumanOutput(result, tree, { stdout = process.stdout }) {
  const lines = [
    `refine verify: ${result.ok ? "PASS" : "FAIL"}`,
    `mode: ${tree.mode}`,
    `root issue: #${tree.rootIssueNumber}`,
  ];
  if (tree.repo) {
    lines.push(`repo: ${tree.repo}`);
  }
  for (const check of result.checks) {
    lines.push(`${check.checker}: ${check.ok ? "PASS" : "FAIL"}`);
    for (const error of check.errors) {
      const issuePart = Number.isInteger(error.issue) ? ` (#${error.issue})` : "";
      lines.push(`  - [${error.code}]${issuePart} ${error.message}`);
    }
  }
  if (result.errors.length === 0) {
    lines.push("No checker errors.");
  }
  stdout.write(`${lines.join("\n")}\n`);
}

export async function runCli(
  argv = process.argv.slice(2),
  { stdout = process.stdout, cwd = process.cwd(), ghCommand = "gh", env = process.env } = {},
) {
  const options = parseRefineVerifyCliArgs(argv);
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return { ok: true, help: true };
  }

  let resolvedRepo = options.repo;
  if (options.issue !== undefined && typeof resolvedRepo !== "string") {
    try {
      resolvedRepo = detectRepoSlug(cwd);
    if (!resolvedRepo) {
      throw parseError("Unable to detect repository slug. Pass --repo <owner/name>.");
    }
    } catch (err) {
      throw parseError(err.message);
    }
  }

  const tree = options.input
    ? await loadTreeFromInput(options.input)
    : await loadTreeOnline({ issue: options.issue, repo: resolvedRepo, cwd, ghCommand, env });


  const result = runAllCheckers(tree);

  const payload = {
    ok: result.ok,
    mode: tree.mode,
    repo: tree.repo,
    rootIssue: tree.rootIssueNumber,
    checkers: result.checks,
    errors: result.errors,
  };

  if (options.json) {
    stdout.write(`${JSON.stringify(payload)}\n`);
  } else {
    writeHumanOutput(result, tree, { stdout });
  }

  if (!result.ok) {
    process.exitCode = 1;
  }
  return payload;
}

if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  });
}
