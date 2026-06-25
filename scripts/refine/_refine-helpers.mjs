#!/usr/bin/env node
import { readFile } from "node:fs/promises";

import { buildParseError, formatCliError, isDirectCliRun, parseJsonText } from "../_core-helpers.mjs";
import { parseArgs } from "node:util";
import { parsePositiveInteger, requireTokenValue, runChild } from "../_cli-primitives.mjs";
import { detectRepoSlug, parseRepoSlug } from "@dev-loops/core/github/repo-slug";

export const FORBIDDEN_PROSE_PATTERNS = [
  /Child of #/iu,
  /Parent:\s*#/iu,
  /Depends on:\s*#/iu,
  /sub-issue of #/iu,
];

export const DEFAULT_USAGE_SUFFIX = `
Output:
  Default output is human-readable text.
  Add --json for machine-readable JSON.`.trim();

export function normalizeIssueNumber(value, label, parseError) {
  return parsePositiveInteger(value, label, parseError);
}

export function parseCheckerCliArgs(argv, usage, checkerName) {
  const parseError = buildParseError(usage);
  const { tokens } = parseArgs({
    args: [...argv],
    options: { help: { type: "boolean", short: "h" }, input: { type: "string" }, json: { type: "boolean" } },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  const options = { help: false, input: undefined, json: false };
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
  if (typeof options.input !== "string" || options.input.trim().length === 0) {
    throw parseError(`${checkerName} requires --input <path>`);
  }
  return options;
}

export function normalizeTreePayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Refinement tree input must be a JSON object");
  }
  const rootIssueNumber = normalizeIssueNumber(
    payload.rootIssueNumber ?? payload.root,
    "root issue number",
    (message) => new Error(message),
  );
  if (!Array.isArray(payload.issues) || payload.issues.length === 0) {
    throw new Error("Refinement tree input requires a non-empty issues array");
  }

  const issues = [];
  const byNumber = new Map();
  for (const rawIssue of payload.issues) {
    if (!rawIssue || typeof rawIssue !== "object") {
      throw new Error("Each issue entry must be an object");
    }
    const number = normalizeIssueNumber(rawIssue.number, "issue number", (message) => new Error(message));
    const title = typeof rawIssue.title === "string" ? rawIssue.title : "";
    const body = typeof rawIssue.body === "string" ? rawIssue.body : "";
    const state = typeof rawIssue.state === "string" ? rawIssue.state : "open";

    let parentNumber = null;
    if (rawIssue.parentNumber !== undefined && rawIssue.parentNumber !== null) {
      parentNumber = normalizeIssueNumber(rawIssue.parentNumber, "parent issue number", (message) => new Error(message));
    }

    const children = Array.isArray(rawIssue.children)
      ? rawIssue.children.map((child) => normalizeIssueNumber(child, "child issue number", (message) => new Error(message)))
      : [];

    if (byNumber.has(number)) {
      throw new Error(`Duplicate issue number in tree input: ${number}`);
    }
    const issue = { number, title, body, state, parentNumber, children };
    byNumber.set(number, issue);
    issues.push(issue);
  }

  const edges = [];
  for (const issue of issues) {
    for (const child of issue.children) {
      edges.push({ parent: issue.number, child });
    }
  }

  return {
    mode: payload.mode === "online" ? "online" : "offline",
    repo: typeof payload.repo === "string" ? payload.repo : null,
    rootIssueNumber,
    issues,
    byNumber,
    edges,
  };
}

export async function loadTreeFromInput(inputPath) {
  const raw = await readFile(inputPath, "utf8");
  return normalizeTreePayload(parseJsonText(raw));
}

async function ghApiJson(args, { ghCommand = "gh", env = process.env } = {}) {
  const result = await runChild(ghCommand, ["api", ...args], env);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    throw new Error(`gh api command failed: ${detail}`);
  }
  return parseJsonText(result.stdout);
}

export async function loadTreeOnline({ issue, repo, cwd = process.cwd(), ghCommand = "gh", env = process.env }) {
  const resolvedRepo = typeof repo === "string" && repo.trim().length > 0
    ? repo.trim()
    : detectRepoSlug(cwd);
  if (!resolvedRepo) {
    throw new Error("Unable to detect repository slug. Pass --repo <owner/name>.");
  }
  const parsed = parseRepoSlug(resolvedRepo, { errorMessage: "--repo must match <owner/name>" });
  const { owner, name } = parsed;

  const byNumber = new Map();
  const edges = [];
  const queuedNumbers = new Set([issue]);
  const queue = [{ number: issue, parentNumber: null }];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!Number.isInteger(current.number) || current.number <= 0) {
      continue;
    }

    const issuePayload = await ghApiJson([
      `repos/${owner}/${name}/issues/${current.number}`,
    ], { ghCommand, env });

    const number = issuePayload?.number;
    if (!Number.isInteger(number) || number <= 0) {
      throw new Error(`Invalid issue payload for #${current.number}`);
    }

    const existing = byNumber.get(number);
    if (!existing) {
      byNumber.set(number, {
        number,
        title: typeof issuePayload.title === "string" ? issuePayload.title : "",
        body: typeof issuePayload.body === "string" ? issuePayload.body : "",
        state: typeof issuePayload.state === "string" ? issuePayload.state : "open",
        parentNumber: current.parentNumber,
        children: [],
      });
    } else if (existing.parentNumber === null && current.parentNumber !== null) {
      existing.parentNumber = current.parentNumber;
    }

    const subIssuesPayload = await ghApiJson([
      `repos/${owner}/${name}/issues/${number}/sub_issues`,
    ], { ghCommand, env });

    const currentIssue = byNumber.get(number);
    const children = [];
    if (Array.isArray(subIssuesPayload)) {
      for (const entry of subIssuesPayload) {
        if (!entry || typeof entry !== "object") {
          continue;
        }
        const childNumber = entry.number;
        if (!Number.isInteger(childNumber) || childNumber <= 0) {
          continue;
        }
        children.push(childNumber);
        edges.push({ parent: number, child: childNumber });
        if (!byNumber.has(childNumber) && !queuedNumbers.has(childNumber)) {
          queuedNumbers.add(childNumber);
          queue.push({ number: childNumber, parentNumber: number });
        }
      }
    } else {
      throw new Error(`Invalid sub-issues payload for #${number}: expected array`);
    }

    currentIssue.children = [...new Set(children)];
  }

  return {
    mode: "online",
    repo: resolvedRepo,
    rootIssueNumber: issue,
    issues: [...byNumber.values()],
    byNumber,
    edges,
  };
}

export function extractSection(body, headingText) {
  if (typeof body !== "string" || body.length === 0) {
    return null;
  }
  const escapedHeading = headingText.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const headingPattern = new RegExp(`^##\\s+${escapedHeading}\\s*$`, "imu");
  const match = headingPattern.exec(body);
  if (!match || match.index === undefined) {
    return null;
  }
  const start = match.index + match[0].length;
  const remaining = body.slice(start);
  const nextHeadingMatch = /^##\s+/imu.exec(remaining);
  const end = nextHeadingMatch && nextHeadingMatch.index !== undefined
    ? start + nextHeadingMatch.index
    : body.length;
  return body.slice(start, end).trim();
}

export function normalizeScopeToken(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[`*_~]/gu, "")
    .replace(/^[:\-\s]+|[:\-\s]+$/gu, "")
    .replace(/\s+/gu, " ");
}

export function writeCheckerOutput(result, { stdout = process.stdout, json = false }) {
  if (json) {
    stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  const status = result.ok ? "PASS" : "FAIL";
  const lines = [`${result.checker}: ${status}`];
  if (result.errors.length === 0) {
    lines.push("  - No problems found.");
  } else {
    for (const error of result.errors) {
      const issuePart = Number.isInteger(error.issue) ? ` (#${error.issue})` : "";
      lines.push(`  - [${error.code}]${issuePart} ${error.message}`);
    }
  }
  stdout.write(`${lines.join("\n")}\n`);
}


export function handleCliError(error) {
  process.stderr.write(`${formatCliError(error)}\n`);
  process.exitCode = 1;
}
// Re-exported for checker scripts
export { isDirectCliRun };
