#!/usr/bin/env node
import { formatCliError } from "../_core-helpers.mjs";
import {
  DEFAULT_USAGE_SUFFIX,
  extractSection,
  loadTreeFromInput,
  normalizeScopeToken,
  parseCheckerCliArgs,
  writeCheckerOutput,
  isDirectCliRun,
} from "./_refine-helpers.mjs";

const USAGE = `Usage:
  scope-boundary-cross-checker.mjs --input <path> [--json]
Cross-check sibling scopes and non-goal handoffs to detect scope gaps and duplicate ownership.${"\n"}${DEFAULT_USAGE_SUFFIX}`;

function extractOwnershipClaims(issue) {
  const tokens = new Set();
  const scopeSection = extractSection(issue.body, "Scope") ?? "";
  const ownershipSection = extractSection(issue.body, "Ownership") ?? "";
  const searchText = [scopeSection, ownershipSection, issue.body].filter(Boolean).join("\n");

  const ownsPattern = /\bowns?\s+([^\n.;]+)/giu;
  for (const match of searchText.matchAll(ownsPattern)) {
    const token = normalizeScopeToken(match[1]);
    if (token.length > 0) {
      tokens.add(token);
    }
  }

  for (const line of scopeSection.split(/\r?\n/gu)) {
    const bullet = /^\s*[-*]\s+(.+)$/u.exec(line);
    if (!bullet) continue;
    const rawToken = bullet[1].replace(/^\s*owns?\s+/iu, '');
    const token = normalizeScopeToken(rawToken);
    if (token.length > 0) {
      tokens.add(token);
    }
  }

  return [...tokens];
}

function extractNonGoalDelegations(issue) {
  const nonGoals = extractSection(issue.body, "Non-goals") ?? "";
  const delegations = [];
  for (const line of nonGoals.split(/\r?\n/gu)) {
    const match = /not\s+(.+?)\s*(?:->|→)\s*#?(\d+)\b/iu.exec(line);
    if (!match) {
      continue;
    }
    const token = normalizeScopeToken(match[1]);
    const target = Number(match[2]);
    if (token.length > 0 && Number.isInteger(target) && target > 0) {
      delegations.push({ token, target });
    }
  }
  return delegations;
}

function buildSiblingGroups(tree) {
  const childrenByParent = new Map();
  for (const edge of tree.edges) {
    if (!childrenByParent.has(edge.parent)) {
      childrenByParent.set(edge.parent, new Set());
    }
    childrenByParent.get(edge.parent).add(edge.child);
  }
  return childrenByParent;
}

export function runScopeBoundaryCrossChecker(tree) {
  const errors = [];
  const ownershipByIssue = new Map();
  const delegationsByIssue = new Map();

  for (const issue of tree.issues) {
    ownershipByIssue.set(issue.number, extractOwnershipClaims(issue));
    delegationsByIssue.set(issue.number, extractNonGoalDelegations(issue));
  }

  for (const [parent, childrenSet] of buildSiblingGroups(tree)) {
    const siblings = [...childrenSet].map((number) => tree.byNumber.get(number)).filter(Boolean);
    if (siblings.length < 2) {
      continue;
    }

    const ownersByToken = new Map();
    for (const sibling of siblings) {
      for (const token of ownershipByIssue.get(sibling.number) ?? []) {
        if (!ownersByToken.has(token)) {
          ownersByToken.set(token, new Set());
        }
        ownersByToken.get(token).add(sibling.number);
      }
    }

    for (const sibling of siblings) {
      const delegations = delegationsByIssue.get(sibling.number) ?? [];
      for (const delegation of delegations) {
        const target = tree.byNumber.get(delegation.target);
        if (!target || !childrenSet.has(target.number)) {
          continue;
        }
        const targetClaims = new Set(ownershipByIssue.get(target.number) ?? []);
        if (!targetClaims.has(delegation.token)) {
          errors.push({
            code: "mutual_exclusion_gap",
            issue: sibling.number,
            message: `Issue #${sibling.number} delegates '${delegation.token}' to #${target.number}, but target does not claim ownership.`,
            parent,
          });
        }

        const ownerSet = ownersByToken.get(delegation.token);
        if (!ownerSet || ownerSet.size === 0) {
          errors.push({
            code: "unowned_scope_gap",
            issue: sibling.number,
            message: `No sibling under parent #${parent} claims delegated scope '${delegation.token}'.`,
            parent,
          });
        }
      }
    }

    for (const [token, owners] of ownersByToken.entries()) {
      if (owners.size > 1) {
        errors.push({
          code: "duplicate_ownership",
          issue: parent,
          message: `Siblings under #${parent} claim duplicate ownership for '${token}': ${[...owners].map((n) => `#${n}`).join(", ")}.`,
          parent,
        });
      }
    }
  }

  return {
    checker: "scope-boundary-cross-checker",
    ok: errors.length === 0,
    errors,
  };
}

export async function runCli(argv = process.argv.slice(2), { stdout = process.stdout } = {}) {
  const options = parseCheckerCliArgs(argv, USAGE, "scope-boundary-cross-checker");
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return { ok: true, help: true };
  }
  const tree = await loadTreeFromInput(options.input);
  const result = runScopeBoundaryCrossChecker(tree);
  process.exitCode = writeCheckerOutput(result, { stdout, json: options.json, jq: options.jq, silent: options.silent });
  return result;
}

if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  });
}
