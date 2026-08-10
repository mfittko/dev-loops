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

function hasDuplicateChildChecklist(issue) {
  const childSet = new Set(issue.children);
  if (childSet.size === 0) {
    return false;
  }

  const referencedChildren = new Set();
  let hasCheckedChildItem = false;

  for (const line of issue.body.split(/\r?\n/gu)) {
    const listItemMatch = /^\s*[-*]\s+(.*)$/u.exec(line);
    if (!listItemMatch) {
      continue;
    }
    const content = listItemMatch[1];

    // Skip scope-boundary prose — it states ownership boundaries ("does NOT own
    // Y (#NNN)"), not a duplicated child checklist. Without this, a conforming
    // boundary bullet with any bare (unparenthesized) child refs would
    // false-positive as a duplicated checklist.
    if (/\bdoes\s+not\s+own\b/iu.test(content)) {
      continue;
    }

    const checkedMatch = /^\[[xX]\]\s*#(\d+)/u.exec(content);
    if (checkedMatch && childSet.has(Number(checkedMatch[1]))) {
      hasCheckedChildItem = true;
    }

    const stripped = content.replace(/\([^)]*\)/gu, "");
    for (const ref of stripped.matchAll(/#(\d+)/gu)) {
      const num = Number(ref[1]);
      if (childSet.has(num)) {
        referencedChildren.add(num);
      }
    }
  }

  return hasCheckedChildItem || referencedChildren.size >= 2;
}

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

    if (hasDuplicateChildChecklist(issue)) {
      errors.push({
        code: "duplicate_child_checklist",
        issue: issue.number,
        message: `Parent body #${issue.number} duplicates the child checklist (list items reference two or more of its own sub-issues, or carry a checked child item). Forbidden by SUBISSUE-LEAN-BODY-NO-DUPLICATE.`,
      });
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
