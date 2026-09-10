#!/usr/bin/env node
import { formatCliError } from "../_core-helpers.mjs";
import {
  DEFAULT_USAGE_SUFFIX,
  loadTreeFromInput,
  parseCheckerCliArgs,
  writeCheckerOutput,
  isDirectCliRun,
} from "./_refine-helpers.mjs";

const MAX_DEPTH = 3;

const USAGE = `Usage:
  tree-integrity-validator.mjs --input <path> [--json]
Validate sub-issue tree integrity: parent links, orphaned issues, cycles, and depth <= ${MAX_DEPTH}.${"\n"}${DEFAULT_USAGE_SUFFIX}`;

function detectCycles(tree, startIssue) {
  const cycles = [];
  const visiting = new Set();
  const visited = new Set();

  function dfs(nodeNumber, path = []) {
    if (visiting.has(nodeNumber)) {
      const cycleStart = path.indexOf(nodeNumber);
      const cyclePath = cycleStart >= 0 ? path.slice(cycleStart).concat(nodeNumber) : [...path, nodeNumber];
      cycles.push(cyclePath);
      return;
    }
    if (visited.has(nodeNumber)) {
      return;
    }

    visiting.add(nodeNumber);
    const issue = tree.byNumber.get(nodeNumber);
    if (issue) {
      for (const child of issue.children) {
        dfs(child, [...path, nodeNumber]);
      }
    }
    visiting.delete(nodeNumber);
    visited.add(nodeNumber);
  }

  dfs(startIssue);
  return cycles;
}

function collectReachableIssues(tree) {
  const reachable = new Set();
  const queue = [tree.rootIssueNumber];
  while (queue.length > 0) {
    const current = queue.shift();
    if (reachable.has(current)) {
      continue;
    }
    reachable.add(current);
    const issue = tree.byNumber.get(current);
    if (!issue) {
      continue;
    }
    for (const child of issue.children) {
      queue.push(child);
    }
  }
  return reachable;
}

function detectDepthViolations(tree) {
  const violations = [];
  const queue = [{ number: tree.rootIssueNumber, depth: 1 }];
  const seen = new Map();
  while (queue.length > 0) {
    const current = queue.shift();
    const existingDepth = seen.get(current.number);
    if (existingDepth !== undefined && existingDepth <= current.depth) {
      continue;
    }
    seen.set(current.number, current.depth);

    if (current.depth > MAX_DEPTH) {
      violations.push({ issue: current.number, depth: current.depth });
    }

    const issue = tree.byNumber.get(current.number);
    if (!issue) {
      continue;
    }
    for (const child of issue.children) {
      queue.push({ number: child, depth: current.depth + 1 });
    }
  }
  return violations;
}

export function runTreeIntegrityValidator(tree) {
  const errors = [];
  const parentsByChild = new Map();

  for (const edge of tree.edges) {
    if (!parentsByChild.has(edge.child)) {
      parentsByChild.set(edge.child, new Set());
    }
    parentsByChild.get(edge.child).add(edge.parent);
  }

  if (!tree.byNumber.has(tree.rootIssueNumber)) {
    errors.push({
      code: "missing_root_issue",
      issue: tree.rootIssueNumber,
      message: `Root issue #${tree.rootIssueNumber} is missing from the tree payload.`,
    });
    return {
      checker: "tree-integrity-validator",
      ok: false,
      errors,
    };
  }

  for (const issue of tree.issues) {
    if (issue.number === tree.rootIssueNumber) {
      continue;
    }
    const parentSet = parentsByChild.get(issue.number) ?? new Set();

    if (issue.parentNumber !== null && !tree.byNumber.has(issue.parentNumber)) {
      errors.push({
        code: "orphaned_issue",
        issue: issue.number,
        message: `Issue #${issue.number} references missing parent #${issue.parentNumber}.`,
      });
    }

    if (issue.parentNumber !== null && !parentSet.has(issue.parentNumber)) {
      errors.push({
        code: "child_missing_parent_link",
        issue: issue.number,
        message: `Issue #${issue.number} declares parent #${issue.parentNumber}, but parent does not link to it as a child.`,
      });
    }

    if (parentSet.size === 0) {
      errors.push({
        code: "missing_parent",
        issue: issue.number,
        message: `Issue #${issue.number} has no parent link in the tree graph.`,
      });
    }

    if (parentSet.size > 1) {
      errors.push({
        code: "multiple_parents",
        issue: issue.number,
        message: `Issue #${issue.number} is linked by multiple parents: ${[...parentSet].map((n) => `#${n}`).join(", ")}.`,
      });
    }
  }

  const reachable = collectReachableIssues(tree);
  for (const issue of tree.issues) {
    if (!reachable.has(issue.number)) {
      errors.push({
        code: "orphaned_issue",
        issue: issue.number,
        message: `Issue #${issue.number} is not reachable from root #${tree.rootIssueNumber}.`,
      });
    }
  }

  const cycles = detectCycles(tree, tree.rootIssueNumber);
  for (const cycle of cycles) {
    errors.push({
      code: "cycle_detected",
      issue: cycle[0],
      message: `Cycle detected in sub-issue graph: ${cycle.map((n) => `#${n}`).join(" -> ")}.`,
    });
  }

  const depthViolations = detectDepthViolations(tree);
  for (const violation of depthViolations) {
    errors.push({
      code: "depth_limit_exceeded",
      issue: violation.issue,
      message: `Issue #${violation.issue} exceeds max depth ${MAX_DEPTH} (depth=${violation.depth}).`,
    });
  }

  return {
    checker: "tree-integrity-validator",
    ok: errors.length === 0,
    errors,
  };
}

export async function runCli(argv = process.argv.slice(2), { stdout = process.stdout } = {}) {
  const options = parseCheckerCliArgs(argv, USAGE, "tree-integrity-validator");
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return { ok: true, help: true };
  }
  const tree = await loadTreeFromInput(options.input);
  const result = runTreeIntegrityValidator(tree);
  process.exitCode = writeCheckerOutput(result, { stdout, json: options.json, jq: options.jq, silent: options.silent });
  return result;
}

if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  });
}
