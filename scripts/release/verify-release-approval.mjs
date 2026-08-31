#!/usr/bin/env node
/**
 * Verify explicit operator release approval for a STABLE release (fail closed).
 *
 * Root cause (#1901): the release runbook gated the release *mechanics* but left
 * the publish/tag decision to agent judgment once "gates are clean" — a general
 * "continue" plus a blanket merge authorization was read as transferable release
 * authority, and the first v1.0.0 cut was tagged and published by a dev-loop
 * subagent. The operator had to roll it back.
 *
 * This check is the fail-closed gate at the release boundary: a STABLE version
 * (npm dist-tag `latest`) may only proceed when an explicit, per-release
 * operator approval record exists — an issue comment authored by the operator
 * (repo owner) stating `approve release v<version>` (or the operator running
 * the publish commands themselves, which is the operator acting directly and
 * outside this check's scope). Blanket merge authorizations and generic
 * "continue" instructions never satisfy it. A prerelease (rc/next/beta/…)
 * is out of scope here — its publishing flow is unchanged.
 *
 * Usage (release.yml / npm-publish.yml):
 *
 *   node scripts/release/verify-release-approval.mjs \
 *     --version "${VERSION}" --repo "${GITHUB_REPOSITORY}"
 *
 * `--operator <login>` overrides the operator identity (default: the repo
 * owner, resolved via `gh api repo`). Exit 0 when the gate passes (approved or
 * not applicable), 1 on a named refusal or any gh failure (fail closed — a
 * flaky/forbidden lookup must never pass the gate), 2 on usage/parse error.
 *
 * Node builtins only: this script runs in the release workflows.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
import { resolveNpmDistTag } from "./resolve-npm-dist-tag.mjs";

const USAGE = `Usage: verify-release-approval.mjs --version <semver> --repo <owner/name> [--operator <login>] [--jq <filter>] [--silent]
Fail-closed operator-approval gate for STABLE releases (#1901). A stable version
requires an issue comment by the operator stating "approve release v<version>";
prereleases pass through unchanged. Exit 0 pass, 1 refusal/gh failure, 2 usage.
${JQ_OUTPUT_USAGE}`;

function isDirectCliRun(importMetaUrl, argv1 = process.argv[1]) {
  if (typeof argv1 !== "string" || argv1.length === 0) return false;
  try {
    return fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(importMetaUrl));
  } catch {
    return false;
  }
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The only accepted approval record: a comment by the operator whose body
 * states `approve release v<version>` (leading `v` optional, case-insensitive,
 * whitespace-tolerant). Anything else — a blanket merge authorization, a
 * generic "continue", an approval for a DIFFERENT version (including a
 * prerelease of the same X.Y.Z, e.g. `v1.0.0-rc.7` ≠ `v1.0.0`), or a comment
 * by anyone else — does not match, so the gate fails closed.
 */
function approvalPattern(version) {
  // The trailing boundary refuses version extensions: another digit, a
  // `.digit` (v1.0.0.1), a `-` prerelease continuation (v1.0.0-rc.7), or any
  // word character glued to the version.
  return new RegExp(`approve\\s+release\\s+v?${escapeRegExp(version)}(?![\\w-])(?!\\.\\d)`, "i");
}

/**
 * Pure gate decision over already-fetched comments.
 * @param {object} p
 * @param {string} p.version — SemVer version (no leading `v`)
 * @param {string} p.operator — operator login (case-insensitive compare)
 * @param {Array<{author: string, body: string}>} p.comments — candidate comments
 * @returns {{ applies: boolean, approved: boolean, refusal: string | null }}
 */
export function resolveApprovalState({ version, operator, comments }) {
  if (typeof version !== "string" || version.trim().length === 0) {
    throw new Error("version must be a non-empty string");
  }
  if (typeof operator !== "string" || operator.trim().length === 0) {
    throw new Error("operator must be a non-empty string");
  }
  const distTag = resolveNpmDistTag(version); // throws on garbage (fail closed)
  if (distTag !== "latest") {
    return { applies: false, approved: false, refusal: null };
  }
  const pattern = approvalPattern(version);
  const approved = (Array.isArray(comments) ? comments : []).some(
    (c) =>
      c &&
      typeof c.author === "string" &&
      typeof c.body === "string" &&
      c.author.trim().toLowerCase() === operator.trim().toLowerCase() &&
      pattern.test(c.body),
  );
  return {
    applies: true,
    approved,
    refusal: approved
      ? null
      : `stable release v${version} blocked: no explicit operator release approval record found. `
        + `Expected an issue comment by the operator (@${operator}) stating "approve release v${version}", `
        + `or the operator running the publish commands themselves. Blanket merge authorizations and `
        + `generic continue instructions do NOT satisfy this gate.`,
  };
}

/** Run a bounded `gh` call; throws (fail closed) on any non-zero exit. */
function runGh(args, { ghCommand = "gh", runChild = execFileSync } = {}) {
  const stdout = runChild(ghCommand, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

/**
 * Candidate issues: search for issues where the operator commented on text
 * matching the per-release approval phrase, then verify the AUTHORING comment
 * exactly (search `commenter:` alone would match any operator comment on an
 * issue where someone ELSE wrote the phrase — verify the operator authored it).
 * Bounded to 50 candidates. Raw `gh api` output is parsed in-script (no `--jq`):
 * the script is node-builtins-only and must not depend on jq parsing behavior.
 */
function fetchApprovalCandidates({ repo, operator, version, ghCommand, runChild }) {
  const phrase = `approve release v${version}`;
  const searchOut = runGh(
    ["api", "-X", "GET", "search/issues", "-f", `q=repo:${repo} commenter:${operator} "${phrase}"`],
    { ghCommand, runChild },
  );
  let candidates = [];
  try {
    candidates = (JSON.parse(searchOut)?.items ?? []).map((item) => item?.number).filter((n) => Number.isInteger(n)).slice(0, 50);
  } catch {
    throw new Error(`release-approval search returned non-JSON output — fail closed`);
  }
  const comments = [];
  for (const issueNumber of candidates) {
    const body = runGh(
      ["api", "repos/" + repo + "/issues/" + issueNumber + "/comments", "--paginate"],
      { ghCommand, runChild },
    );
    try {
      const parsed = JSON.parse(body);
      // --paginate emits a JSON array per page on stdout; a single page is one
      // array, multiple pages would be consecutive arrays. Parse each page.
      const pages = Array.isArray(parsed) ? [parsed] : [parsed].flat();
      for (const page of pages) {
        for (const c of Array.isArray(page) ? page : []) {
          const author = c?.user?.login;
          const commentBody = c?.body;
          if (typeof author === "string" && typeof commentBody === "string") {
            comments.push({ author, body: commentBody });
          }
        }
      }
    } catch {
      throw new Error(`release-approval comment fetch returned non-JSON output — fail closed`);
    }
  }
  return comments;
}

export function verifyReleaseApproval({ version, repo, operator = null, ghCommand = "gh", runChild = execFileSync } = {}) {
  const distTag = resolveNpmDistTag(version); // throws on garbage -> usage error upstream
  if (distTag !== "latest") {
    return { ok: true, applies: false, message: `prerelease v${version} publishes under dist-tag "${distTag}"; the stable-release operator-approval gate does not apply (prerelease flow unchanged).` };
  }
  const operatorLogin = operator ?? runGh(["api", "repo", "--jq", ".owner.login"], { ghCommand, runChild }).trim();
  if (!operatorLogin) {
    throw new Error("operator login could not be resolved (gh api repo returned empty) — fail closed");
  }
  const comments = fetchApprovalCandidates({ repo, operator: operatorLogin, version, ghCommand, runChild });
  const decision = resolveApprovalState({ version, operator: operatorLogin, comments });
  if (!decision.approved) {
    return { ok: false, applies: true, refusal: decision.refusal };
  }
  return { ok: true, applies: true, message: `operator release approval for v${version} verified (comment by @${operatorLogin}).` };
}

function parseArgs(argv) {
  const options = { version: null, repo: null, operator: null, jq: undefined, silent: false };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--version") {
      options.version = argv[++i] ?? null;
    } else if (token === "--repo") {
      options.repo = argv[++i] ?? null;
    } else if (token === "--operator") {
      options.operator = argv[++i] ?? null;
    } else if (token === "--help" || token === "-h") {
      process.stdout.write(USAGE + "\n");
      process.exit(0);
    } else {
      if (matchJqOutputToken(token, options, (t) => usageError("--jq requires a filter"))) break;
      usageError(`unknown argument: ${token}`);
    }
  }
  return options;
}

function usageError(message) {
  process.stderr.write(`{"ok":false,"error":${JSON.stringify(message)},"usage":${JSON.stringify(USAGE)}}\n`);
  process.exit(2);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) usageError("no arguments: --version and --repo are required");
  const options = parseArgs(argv);
  if (!options.version) usageError("--version is required (the workflows always pass it)");
  if (!options.repo) usageError("--repo <owner/name> is required");
  if (!/^[^/\s]+\/[^/\s]+$/.test(options.repo)) usageError(`--repo must be owner/name shape: ${options.repo}`);

  let result;
  try {
    result = verifyReleaseApproval({ version: options.version, repo: options.repo, operator: options.operator });
  } catch (err) {
    // Version parse errors are usage errors; gh/network failures below are
    // enforcement failures (exit 1). resolveNpmDistTag throws on garbage.
    if (/not a valid SemVer|non-empty string/.test(String(err?.message))) {
      usageError(err.message);
    }
    if (/not a valid SemVer|non-empty string/.test(String(err?.message))) {
      usageError(err.message);
    }
    const failure = { ok: false, error: `operator-approval check failed closed: ${err?.message ?? err}` };
    process.exitCode = emitResult(failure, { jq: options.jq, silent: options.silent });
    process.exit(process.exitCode === 0 ? 1 : process.exitCode);
  }
  if (!result.ok) {
    const failure = { ok: false, error: result.refusal };
    process.stderr.write(`::error::${result.refusal}\n`);
    const code = emitResult(failure, { jq: options.jq, silent: options.silent });
    process.exit(code === 0 ? 1 : code); // a clean jq-false must not mask a refusal
  }
  process.exit(emitResult({ ok: true, ...(result.applies ? {} : { applies: false }), message: result.message }, { jq: options.jq, silent: options.silent }));
}

if (isDirectCliRun(import.meta.url)) {
  main();
}
