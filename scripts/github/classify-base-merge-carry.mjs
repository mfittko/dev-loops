#!/usr/bin/env node
/**
 * classify-base-merge-carry.mjs — detect whether a head advance A..B only merged
 * the base branch, and persist the evidence (issue 2752, ADR 0156). The decision
 * is the pure, fail-closed `classifyBaseMergeCarry` seam; this CLI only computes
 * its inputs with git. Any git failure yields a durable `fallback_full` record.
 */
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { classifyBaseMergeCarry } from "@dev-loops/core/loop/base-merge-verdict-carry";

import { formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { normalizeFullHeadSha } from "../lib/head-sha.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";
import { buildGateArtifactPath } from "./_gate-artifact-paths.mjs";

const USAGE = `Usage: classify-base-merge-carry.mjs --repo <owner/name> --pr <number> --gate <draft_gate|pre_approval_gate> --prev-head <full sha> --head-sha <full sha> --base-ref <ref, e.g. origin/main> [--tmp-root <path>]
${JQ_OUTPUT_USAGE}`;

export function buildBaseMergeCarryPath({ repo, pr, gate, headSha, tmpRoot = "tmp" }) {
  return buildGateArtifactPath({ repo, pr, gate, headSha, tmpRoot, dir: "base-merge-carry", suffix: ".base-merge-carry.json" });
}

// Pinned raw-byte git runner: the child env is built ONLY from this allowlist, so no ambient GIT_*, HOME, XDG_* or LANG reaches git.
// stdout stays a Buffer; stderr is a string.
export function runPinnedGit(args, { repoRoot } = {}) {
  const env = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1", LC_ALL: "C" };
  const r = spawnSync("git", args, { cwd: repoRoot, env, maxBuffer: 1 << 30 });
  if (r.error) throw r.error;
  return Promise.resolve({ code: r.status, stdout: r.stdout, stderr: r.stderr.toString("utf8") });
}

async function git(runGit, repoRoot, args, opts = {}) {
  const r = await runGit(args, { repoRoot, ...opts });
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim()}`);
  return r.stdout;
}

const lines = (s) => s.toString("utf8").split("\n").filter(Boolean);
// Raw tree-entry read: diff-tree --raw compares tree entries only (blob/gitlink oids and modes), so attributes, textconv, diff drivers and diff rendering config never apply.
// --no-abbrev gives full oids; --ignore-submodules=none keeps gitlink changes visible. Returns sorted `path\tmode\toid` (new side) entries.
async function rawEntries(runGit, repoRoot, from, to) {
  const out = (await git(runGit, repoRoot, ["diff-tree", "-r", "--raw", "--no-renames", "--no-abbrev", "--ignore-submodules=none", "-z", from, to])).toString("latin1").split("\0").filter(Boolean);
  const entries = [];
  for (let i = 0; i < out.length; i += 2) {
    const meta = out[i].match(/^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) [A-Z]\d*$/);
    if (!meta || out[i + 1] === undefined) throw new Error("unparseable git diff-tree --raw output");
    entries.push(`${out[i + 1]}\t${meta[2]}\t${meta[4]}`);
  }
  return entries.sort();
}
const entryPath = (e) => e.split("\t").slice(0, -2).join("\t");
// Path bytes are decoded as latin1 (one-to-one), so distinct non-UTF-8 paths stay distinct; the gate-tooling matcher only needs ASCII prefixes.
// A criss-cross history has several merge bases; any ambiguity fails closed.
async function singleMergeBase(runGit, repoRoot, baseRef, head) {
  const bases = lines(await git(runGit, repoRoot, ["merge-base", "--all", baseRef, head]));
  if (bases.length !== 1) throw new Error(`expected exactly one merge base, got ${bases.length}`);
  return bases[0];
}

export async function computeBaseMergeCarry({ prevHead, headSha, baseRef, repoRoot, runGit = runPinnedGit }) {
  try {
    const anc = await runGit(["merge-base", "--is-ancestor", prevHead, headSha], { repoRoot });
    if (anc.code === 1) throw new Error("prev-head is not an ancestor of head-sha");
    if (anc.code !== 0) throw new Error(`git merge-base --is-ancestor failed: ${anc.stderr.trim()}`);
    const mbA = await singleMergeBase(runGit, repoRoot, baseRef, prevHead);
    const mbB = await singleMergeBase(runGit, repoRoot, baseRef, headSha);
    const prBlobsBefore = await rawEntries(runGit, repoRoot, mbA, prevHead);
    const prBlobsAfter = await rawEntries(runGit, repoRoot, mbB, headSha);
    const baseDeltaPaths = (await rawEntries(runGit, repoRoot, mbA, mbB)).map(entryPath);
    // A merge commit's combined diff (--cc) is non-empty only when the merge hand-resolved something.
    // Check every merge commit on the PR branch line (--first-parent) in prevHead..headSha; merges that arrived from the base side are not the PR's own.
    let conflictResolutionHunks = false;
    const merges = lines(await git(runGit, repoRoot, ["rev-list", "--merges", "--first-parent", `${prevHead}..${headSha}`]));
    if (merges.length > 0) {
      // --cc honors -diff/binary attributes, and .git/info/attributes cannot be switched off in the repo.
      // Read the objects through a throwaway bare git dir (alternates) that has no attribute files.
      const objects = (await git(runGit, repoRoot, ["rev-parse", "--path-format=absolute", "--git-path", "objects"])).toString("utf8").trim();
      const bare = await mkdtemp(path.join(os.tmpdir(), "bmc-cc-"));
      try {
        await git(runGit, repoRoot, ["init", "-q", "--bare", bare]);
        await writeFile(path.join(bare, "objects", "info", "alternates"), `${objects}\n`);
        for (const merge of merges) {
          if ((await git(runGit, repoRoot, ["--git-dir", bare, "-c", "core.attributesFile=/dev/null", "diff-tree", "--cc", "--no-ext-diff", "--no-color", "--format=", merge])).toString("utf8").trim() !== "") conflictResolutionHunks = true;
        }
      } finally { await rm(bare, { recursive: true, force: true }); }
    }
    return classifyBaseMergeCarry({
      sourceHead: prevHead, newHead: headSha, prBlobsBefore, prBlobsAfter,
      baseDeltaPaths, conflictResolutionHunks,
    });
  } catch (error) {
    return classifyBaseMergeCarry({ sourceHead: prevHead, newHead: headSha, detectionError: error instanceof Error ? error.message : String(error) });
  }
}

export async function main(argv = process.argv.slice(2), { repoRoot = process.cwd(), runGit = runPinnedGit } = {}) {
  try {
    const { values } = parseArgs({
      args: argv,
      options: { repo: { type: "string" }, pr: { type: "string" }, gate: { type: "string" }, "prev-head": { type: "string" }, "head-sha": { type: "string" }, "base-ref": { type: "string" }, "tmp-root": { type: "string" }, ...JQ_OUTPUT_PARSE_OPTIONS },
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
    process.exitCode = emitResult({ ok: true, path: out, ...evidence }, { jq: values.jq, silent: values.silent, fields: values.fields });
  } catch (error) {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  }
}

if (isDirectCliRun(import.meta.url)) {
  await main();
}
