#!/usr/bin/env node
import { formatCliError } from "../_core-helpers.mjs";
import {
  DEFAULT_USAGE_SUFFIX,
  FORBIDDEN_PROSE_PATTERNS,
  loadTreeFromInput,
  parseCheckerCliArgs,
  writeCheckerOutput,
  isDirectCliRun,
} from "./_refine-helpers.mjs";

const USAGE = `Usage:
  prose-linkage-detector.mjs --input <path> [--json]
Fail when issue bodies use prose linkage (` + "`Child of #`, `Parent: #`, `Depends on: #`, `sub-issue of #`" + `)
instead of GitHub sub-issue API links.${"\n"}${DEFAULT_USAGE_SUFFIX}`;

export function runProseLinkageDetector(tree) {
  const errors = [];
  const parentByChild = new Map();

  for (const edge of tree.edges) {
    if (!parentByChild.has(edge.child)) {
      parentByChild.set(edge.child, new Set());
    }
    parentByChild.get(edge.child).add(edge.parent);
  }

  for (const issue of tree.issues) {
    for (const pattern of FORBIDDEN_PROSE_PATTERNS) {
      if (pattern.test(issue.body)) {
        errors.push({
          code: "forbidden_prose_linkage",
          issue: issue.number,
          message: `Issue body contains forbidden prose linkage pattern: ${pattern.source}`,
        });
      }
    }

    for (const child of issue.children) {
      const childIssue = tree.byNumber.get(child);
      if (!childIssue) {
        errors.push({
          code: "missing_child_issue",
          issue: issue.number,
          message: `Sub-issue link references #${child}, but that issue is missing from the tree payload.`,
        });
        continue;
      }
      const parentSet = parentByChild.get(child) ?? new Set();
      if (!parentSet.has(issue.number)) {
        errors.push({
          code: "missing_sub_issue_link",
          issue: issue.number,
          message: `Expected API sub-issue link #${issue.number} -> #${child} is missing.`,
        });
      }

      if (Number.isInteger(childIssue.parentNumber) && childIssue.parentNumber !== issue.number) {
        errors.push({
          code: "parent_mismatch",
          issue: child,
          message: `Child issue #${child} declares parent #${childIssue.parentNumber}, not #${issue.number}.`,
        });
      }
    }
  }

  return {
    checker: "prose-linkage-detector",
    ok: errors.length === 0,
    errors,
  };
}

export async function runCli(argv = process.argv.slice(2), { stdout = process.stdout } = {}) {
  const options = parseCheckerCliArgs(argv, USAGE, "prose-linkage-detector");
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return { ok: true, help: true };
  }
  const tree = await loadTreeFromInput(options.input);
  const result = runProseLinkageDetector(tree);
  process.exitCode = writeCheckerOutput(result, { stdout, json: options.json, jq: options.jq, silent: options.silent });
  return result;
}

if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  });
}
