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

// Returns Map<token, Set<raw trimmed source line>> so shared boilerplate can be told from rival claims.
function extractOwnershipClaims(issue) {
  const claims = new Map();
  const add = (token, line) => {
    if (token.length === 0) return;
    if (!claims.has(token)) claims.set(token, new Set());
    claims.get(token).add(line.trim());
  };
  const scopeSection = extractSection(issue.body, "Scope") ?? "";
  const ownershipSection = extractSection(issue.body, "Ownership") ?? "";
  const searchText = [scopeSection, ownershipSection, issue.body].filter(Boolean).join("\n");

  for (const line of searchText.split(/\r?\n/gu)) {
    for (const match of line.matchAll(/\bowns?\s+([^\n.;]+)/giu)) {
      add(normalizeScopeToken(match[1]), line);
    }
  }

  for (const line of scopeSection.split(/\r?\n/gu)) {
    const bullet = /^\s*[-*]\s+(.+)$/u.exec(line);
    if (!bullet) continue;
    add(normalizeScopeToken(bullet[1].replace(/^\s*owns?\s+/iu, '')), line);
  }

  return claims;
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
      for (const token of ownershipByIssue.get(sibling.number)?.keys() ?? []) {
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
        const targetClaims = new Set(ownershipByIssue.get(target.number)?.keys() ?? []);
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
      // Shared constraint: three or more siblings (the floor keeps two-sibling overlaps flagged)
      // that all repeat the identical raw line. Any differing wording is a rival claim.
      const lineSets = [...owners].map((n) => [...ownershipByIssue.get(n).get(token)].sort().join("\n"));
      const sharedConstraint = siblings.length >= 3 && owners.size === siblings.length && new Set(lineSets).size === 1;
      if (owners.size > 1 && !sharedConstraint) {
        errors.push({
          code: "duplicate_ownership",
          issue: parent,
          message: `Siblings under #${parent} claim duplicate ownership for '${token}': ${[...owners].map((n) => `#${n}`).join(", ")}. Give the claim to one sibling, or repeat the identical line in every sibling (three or more siblings) when it is a shared constraint.`,
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
