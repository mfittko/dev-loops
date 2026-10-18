#!/usr/bin/env node
/**
 * classify-base-merge-carry.mjs — detect whether a head advance A..B only merged
 * the base branch, and persist the evidence (issue 2752, ADR 0156). The decision
 * is the pure, fail-closed `classifyBaseMergeCarry` seam; this CLI only computes
 * its inputs with git. Any git failure yields a durable `fallback_full` record.
 */
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { classifyBaseMergeCarry } from "@dev-loops/core/loop/base-merge-verdict-carry";

import { formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { runGitCommand } from "../lib/git-delta.mjs";
import { normalizeFullHeadSha } from "../lib/head-sha.mjs";
import { buildGateArtifactPath } from "./_gate-artifact-paths.mjs";

const USAGE = "Usage: classify-base-merge-carry.mjs --repo <owner/name> --pr <number> --gate <draft_gate|pre_approval_gate> --prev-head <full sha> --head-sha <full sha> --base-ref <ref, e.g. origin/main> [--tmp-root <path>]";

export function buildBaseMergeCarryPath({ repo, pr, gate, headSha, tmpRoot = "tmp" }) {
  return buildGateArtifactPath({ repo, pr, gate, headSha, tmpRoot, dir: "base-merge-carry", suffix: ".base-merge-carry.json" });
}

// --verbatim keeps whitespace significant: an indentation-only change must change the id.
function stablePatchId(diffText) {
  const r = spawnSync("git", ["patch-id", "--verbatim"], { input: diffText, encoding: "utf8" });
  if (r.error || r.status !== 0) throw new Error(`git patch-id failed: ${r.error?.message ?? r.stderr}`);
  return r.stdout.split(/\s+/)[0] || "";
}

async function git(runGit, repoRoot, args) {
  const r = await runGit(args, { repoRoot });
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim()}`);
  return r.stdout;
}

const lines = (s) => s.split("\n").filter(Boolean);
const nulLines = (s) => s.split("\0").filter(Boolean);
const DIFF_FLAGS = ["--no-ext-diff", "--no-color", "--no-relative", "--no-renames"];

export async function computeBaseMergeCarry({ prevHead, headSha, baseRef, repoRoot, runGit = runGitCommand, patchId = stablePatchId }) {
  try {
    const anc = await runGit(["merge-base", "--is-ancestor", prevHead, headSha], { repoRoot });
    if (anc.code === 1) throw new Error("prev-head is not an ancestor of head-sha");
    if (anc.code !== 0) throw new Error(`git merge-base --is-ancestor failed: ${anc.stderr.trim()}`);
    const mbA = (await git(runGit, repoRoot, ["merge-base", baseRef, prevHead])).trim();
    const mbB = (await git(runGit, repoRoot, ["merge-base", baseRef, headSha])).trim();
    const diffA = await git(runGit, repoRoot, ["diff", ...DIFF_FLAGS, mbA, prevHead]);
    const diffB = await git(runGit, repoRoot, ["diff", ...DIFF_FLAGS, mbB, headSha]);
    const prDiffPaths = nulLines(await git(runGit, repoRoot, ["diff", ...DIFF_FLAGS, "--name-only", "-z", mbB, headSha]));
    const baseDeltaPaths = nulLines(await git(runGit, repoRoot, ["diff", ...DIFF_FLAGS, "--name-only", "-z", mbA, mbB]));
    // A merge commit's combined diff (--cc) is non-empty only when the merge hand-resolved something.
    // Check every merge commit in prevHead..headSha.
    let conflictResolutionHunks = false;
    for (const merge of lines(await git(runGit, repoRoot, ["rev-list", "--merges", `${prevHead}..${headSha}`]))) {
      if ((await git(runGit, repoRoot, ["diff-tree", "--cc", "--no-ext-diff", "--no-color", "--format=", merge])).trim() !== "") conflictResolutionHunks = true;
    }
    return classifyBaseMergeCarry({
      sourceHead: prevHead, newHead: headSha, patchIdBefore: patchId(diffA), patchIdAfter: patchId(diffB),
      prDiffPaths, baseDeltaPaths, conflictResolutionHunks,
    });
  } catch (error) {
    return classifyBaseMergeCarry({ sourceHead: prevHead, newHead: headSha, detectionError: error instanceof Error ? error.message : String(error) });
  }
}

export async function main(argv = process.argv.slice(2), { repoRoot = process.cwd(), runGit = runGitCommand } = {}) {
  try {
    const { values } = parseArgs({
      args: argv,
      options: { repo: { type: "string" }, pr: { type: "string" }, gate: { type: "string" }, "prev-head": { type: "string" }, "head-sha": { type: "string" }, "base-ref": { type: "string" }, "tmp-root": { type: "string" } },
    });
    const prevHead = normalizeFullHeadSha(values["prev-head"] ?? "");
    const headSha = normalizeFullHeadSha(values["head-sha"] ?? "");
    if (!values.repo || !values.pr || !values.gate || !prevHead || !headSha || !values["base-ref"] || values["base-ref"].startsWith("-")) {
      throw new Error(`Missing or invalid arguments (full SHAs required)\n${USAGE}`);
    }
    const evidence = await computeBaseMergeCarry({ prevHead, headSha, baseRef: values["base-ref"], repoRoot, runGit });
    const out = path.resolve(repoRoot, buildBaseMergeCarryPath({ repo: values.repo, pr: values.pr, gate: values.gate, headSha, tmpRoot: values["tmp-root"] || "tmp" }));
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({ ok: true, path: out, ...evidence })}\n`);
  } catch (error) {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  }
}

if (isDirectCliRun(import.meta.url)) {
  await main();
}
