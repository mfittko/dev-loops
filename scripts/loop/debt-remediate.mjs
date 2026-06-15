#!/usr/bin/env node
// ============================================================================
// Debt remediation loop command
//
// Single CLI entrypoint: --input → cluster → score → shape → issue → report
//
// Usage:
//   debt-remediate.mjs --input <path> [--repo <owner/name>] [--dry-run]
//
// Takes a JSON array of debt_signal objects, runs the full remediation pipeline,
// and creates GitHub issues for each remediation_item outcome.
// ============================================================================

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { requireOptionValue } from "../_cli-primitives.mjs";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { DebtSignalSchema } from "@dev-loops/core/debt/signal";
import { clusterSignalsEnriched } from "@dev-loops/core/debt/cluster";
import { shapeFindings } from "@dev-loops/core/debt/shape";
import { createRemediationIssue } from "@dev-loops/core/debt/remediation-to-issue";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

const USAGE = `Usage:
  debt-remediate.mjs --input <path>
  debt-remediate.mjs --input <path> --repo <owner/name>
  debt-remediate.mjs --input <path> --dry-run

Run the debt pipeline: cluster signals → score → shape → create
GitHub issues for remediation_items.

Required:
  --input <path>          Path to a JSON file with array of debt_signal objects

Optional:
  --repo <owner/name>     Target repository (default: detected from git remote)
  --dry-run               Validate and report without creating issues

Output (stdout, JSON):
  { "ok": true, "signals": N, "findings": N, "remediationItems": N, "issues": [...], "summary": "..." }

Exit codes:
  0  Success (all remediation issue creations succeeded)
  1  Argument error, input validation failure, or issue creation failure`.trim();

const parseError = buildParseError(USAGE);

// ============================================================================
// Signal validation
// ============================================================================

function validateSignals(signals) {
  if (!Array.isArray(signals)) {
    return { ok: false, error: "Input must be a JSON array of debt_signal objects" };
  }
  if (signals.length === 0) {
    return { ok: false, error: "Input array must contain at least one debt_signal" };
  }

  const errors = [];
  for (let i = 0; i < signals.length; i++) {
    const result = DebtSignalSchema.safeParse(signals[i]);
    if (!result.success) {
      errors.push({
        index: i,
        id: signals[i]?.id || `index-${i}`,
        issues: result.error.issues,
      });
    }
  }

  if (errors.length > 0) {
    return { ok: false, error: "Signal validation failed", validationErrors: errors };
  }

  return { ok: true, signals };
}

// ============================================================================
// Detect repo from git remote
// ============================================================================

function detectRepo() {
  try {
    const remote = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
    }).trim();
    // parseRepoSlug expects owner/name; extract from common remote URL formats
    const match = remote.match(/(?:github\.com[:/])([^/]+\/[^/]+?)(?:\.git)?$/);
    if (match) {
      return parseRepoSlug(match[1]);
    }
    return null;
  } catch {
    return null;
  }
}

// ============================================================================
// Build summary report
// ============================================================================

function buildReport(signalsCount, findingsCount, results) {
  const remediationItems = results.filter(r => r.outcome === "remediation_item");
  const epics = results.filter(r => r.outcome === "debt_epic");
  const defers = results.filter(r => r.outcome === "defer");
  const watches = results.filter(r => r.outcome === "watch");
  const dismisses = results.filter(r => r.outcome === "dismiss");

  const issuesCreated = remediationItems.filter(r => r.issueCreated);
  const issuesFailed = remediationItems.filter(r => !r.issueCreated && r.issueError);

  const summary = [
    `${signalsCount} signals → ${findingsCount} findings`,
    `${remediationItems.length} remediation items (${issuesCreated.length} issues created, ${issuesFailed.length} failed)`,
    `${epics.length} debt epics`,
    `${defers.length} deferred`,
    `${watches.length} watching`,
    `${dismisses.length} dismissed`,
  ].join("; ");

  return {
    signals: signalsCount,
    findings: findingsCount,
    remediationItems: remediationItems.length,
    debtEpics: epics.length,
    deferred: defers.length,
    watching: watches.length,
    dismissed: dismisses.length,
    issues: remediationItems.map(r => ({
      findingId: r.findingId,
      title: r.artifact?.title,
      created: r.issueCreated || false,
      issueNumber: r.issueNumber || null,
      issueUrl: r.issueUrl || null,
      error: r.issueError || null,
    })),
    summary,
  };
}

// ============================================================================
// Run CLI (test-compatible: returns exitCode without calling process.exit)
// ============================================================================

export async function runCli(argv) {
  const args = [...argv];
  const options = { input: undefined, repo: undefined, dryRun: false, help: false };

  while (args.length > 0) {
    const token = args.shift();
    if (token === "--help" || token === "-h") {
      options.help = true;
      break;
    }
    if (token === "--input") {
      options.input = requireOptionValue(args, "--input", parseError);
      continue;
    }
    if (token === "--repo") {
      options.repo = requireOptionValue(args, "--repo", parseError);
      continue;
    }
    if (token === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    throw parseError(`Unknown flag: ${token}`);
  }

  if (options.help) {
    process.stdout.write(USAGE + "\n");
    return { exitCode: 0 };
  }

  if (!options.input) {
    throw parseError("Missing required flag: --input <path>");
  }

  // Resolve input path
  const inputPath = path.resolve(options.input);

  // Read and parse input
  let rawInput;
  try {
    rawInput = await readFile(inputPath, "utf-8");
  } catch (err) {
    return { exitCode: 1, output: { ok: false, error: `Cannot read input file: ${inputPath}`, detail: err.message } };
  }

  let signals;
  try {
    signals = JSON.parse(rawInput);
  } catch (err) {
    return { exitCode: 1, output: { ok: false, error: "Input file is not valid JSON", detail: err.message } };
  }

  // Validate signals
  const validation = validateSignals(signals);
  if (!validation.ok) {
    return { exitCode: 1, output: validation };
  }

  // Resolve repo
  let repo;
  if (options.repo) {
    try {
      repo = parseRepoSlug(options.repo);
    } catch {
      return { exitCode: 1, output: { ok: false, error: `Invalid repo slug: ${options.repo}` } };
    }
  } else {
    repo = detectRepo();
  }

  if (!repo) {
    return { exitCode: 1, output: { ok: false, error: "Cannot detect repository. Pass --repo <owner/name>." } };
  }

  // Run pipeline: cluster → score → shape
  const findings = clusterSignalsEnriched(signals);
  const shaped = shapeFindings(findings);

  // Create issues for remediation_items (skip in dry-run mode)
  const results = [];
  let anyIssueFailed = false;
  for (const { outcome, artifact, findingId } of shaped) {
    if (outcome === "remediation_item" && artifact && !options.dryRun) {
      try {
        const issueResult = createRemediationIssue(artifact, repo);
        if (!issueResult.ok) {
          anyIssueFailed = true;
        }
        results.push({
          outcome,
          findingId,
          artifact,
          issueCreated: issueResult.ok,
          issueNumber: issueResult.issueNumber || null,
          issueUrl: issueResult.issueUrl || null,
          issueError: issueResult.ok ? null : issueResult.error,
        });
      } catch (err) {
        anyIssueFailed = true;
        results.push({
          outcome,
          findingId,
          artifact,
          issueCreated: false,
          issueNumber: null,
          issueUrl: null,
          issueError: err.message || "Unknown error creating issue",
        });
      }
    } else if (outcome === "remediation_item" && artifact && options.dryRun) {
      results.push({
        outcome,
        findingId,
        artifact,
        issueCreated: false,
        issueNumber: null,
        issueUrl: null,
        issueError: null,
        dryRun: true,
      });
    } else {
      results.push({ outcome, findingId, artifact });
    }
  }

  // Build report
  const report = buildReport(signals.length, findings.length, results);
  report.ok = !anyIssueFailed;
  report.dryRun = options.dryRun;
  report.repo = `${repo.owner}/${repo.name}`;

  const outputTarget = report.ok ? process.stdout : process.stderr;
  outputTarget.write(JSON.stringify(report) + "\n");
  return { exitCode: anyIssueFailed ? 1 : 0 };
}

// ============================================================================
// Direct CLI entrypoint
// ============================================================================

if (isDirectCliRun(import.meta.url)) {
  runCli(process.argv.slice(2)).then(({ exitCode, output }) => {
    if (output) {
      process.stderr.write(JSON.stringify(output) + "\n");
    }
    process.exitCode = exitCode;
  }).catch((err) => {
    process.stderr.write(`${formatCliError(err)}\n`);
    process.exitCode = 1;
  });
}

export { validateSignals, buildReport, detectRepo };
