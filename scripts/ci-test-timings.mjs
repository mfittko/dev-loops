import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir, release } from "node:os";
import { join } from "node:path";
import { discoverRepositoryTests } from "./run-bun-test.mjs";

const LIMIT = 200_000;
export const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const artifactName = (run, attempt) => `ci-timings-${run}-${attempt}`;
const TRIAL_PROFILE = "docs/phases/six-shard-trial-profile.json";
export const TRIAL_PROFILE_SHA256 = "e943203c753d0f289879d670425dd2f82d6f2104a885671efc8e2c00f460d688";
const bytesDigest = (text) => createHash("sha256").update(text).digest("hex");

export function trialMatrix(shards = "4") {
  assert.ok(["4", "6"].includes(shards), "trial shards must be 4 or 6");
  return { include: [
    { suite: "test:docs", fetch_depth: 0 },
    { suite: "test:workflows", fetch_depth: 1 },
    ...Array.from({ length: Number(shards) }, (_, i) => ({ suite: "test:all", shard: `${i + 1}/${shards}`, shard_index: i + 1, fetch_depth: 0 })),
  ] };
}

export function validateTrialInput(text, inventory, runtime) {
  assert.equal(bytesDigest(text), TRIAL_PROFILE_SHA256, "trial profile bytes changed");
  const profile = validateProfile(JSON.parse(text), runtime);
  assert.deepEqual(profile.metadata.inventory, inventory, "trial inventory changed");
  return profile;
}

export function validateTrialMeasurements(records, inventory, shards) {
  trialMatrix(shards);
  assert.equal(records.length, Number(shards), "incomplete trial shards");
  const seen = new Set();
  for (const { input, output } of records) {
    assert.equal(bytesDigest(input), TRIAL_PROFILE_SHA256, "trial shard input changed");
    for (const file of Object.keys(filesOf(output))) {
      assert.ok(!seen.has(file), "duplicate trial measured file");
      seen.add(file);
    }
  }
  assert.deepEqual([...seen].sort(), inventory, "incomplete trial inventory");
}

function filesOf(profile) {
  assert.ok(profile?.version === 1 && object(profile.files), "invalid timing schema");
  for (const [path, duration] of Object.entries(profile.files)) {
    assert.ok(path.length < 500 && !path.startsWith("/") && !path.includes("\\") && !path.split("/").some((part) => !part || part === "." || part === ".."), "invalid timing path");
    assert.ok(Number.isInteger(duration) && duration >= 0 && duration <= 0xffffffff, "invalid duration");
  }
  return profile.files;
}

export function validateProfile(profile, runtime) {
  const files = filesOf(profile), meta = profile.metadata;
  assert.ok(object(meta) && same(meta.runtime, runtime), "incompatible runtime metadata");
  assert.ok(Array.isArray(meta.inventory) && same(Object.keys(files).sort(), meta.inventory), "incomplete inventory");
  assert.equal(digest(meta.inventory), meta.inventoryDigest, "invalid inventory digest");
  assert.ok(typeof meta.repository === "string" && positive(meta.workflow) && positive(meta.run) && positive(meta.attempt) && /^[a-f0-9]{40}$/.test(meta.commit), "invalid source metadata");
  assert.match(meta.inputDigest, /^[a-f0-9]{64}$/);
  return profile;
}

export function combine(records, metadata) {
  assert.equal(records.length, 4, "incomplete shards");
  const files = {}, shards = new Set();
  for (const record of records) {
    const { shard, ...meta } = record.metadata ?? {};
    assert.ok(same(meta, metadata), "mismatched shard metadata");
    assert.ok([1, 2, 3, 4].includes(shard) && !shards.has(shard), "duplicate/invalid shard");
    shards.add(shard);
    for (const [path, duration] of Object.entries(filesOf(record))) {
      assert.ok(!Object.hasOwn(files, path), "duplicate measured file");
      files[path] = duration;
    }
  }
  return validateProfile({ version: 1, files, metadata }, metadata.runtime);
}

export async function selectSnapshot({ inventory, runtime, bootstrap, restore, log = console.log }) {
  let profile;
  try {
    profile = validateProfile(await restore(), runtime);
    assert.ok(JSON.stringify(profile).length <= LIMIT, "oversized learned profile");
    log(`Timing source: run ${profile.metadata.run} attempt ${profile.metadata.attempt}, commit ${profile.metadata.commit}`);
  } catch (error) {
    log(`Timing bootstrap fallback: ${error.message}`);
    try { filesOf(bootstrap); profile = bootstrap; } catch { profile = { version: 1, files: {} }; }
  }
  const files = Object.fromEntries(inventory.filter((p) => Object.hasOwn(profile.files, p)).map((p) => [p, profile.files[p]]));
  return { version: 1, files, provenance: { ...runtime, source: profile.metadata ?? profile.provenance ?? "committed bootstrap" } };
}

export function trustedRun(run, repository, workflow, branch) {
  assert.ok(run?.status === "completed" && run.conclusion === "success" && run.event === "push" && run.head_branch === branch && run.workflow_id === workflow && run.repository?.full_name === repository && run.head_repository?.full_name === repository, "untrusted source run");
  assert.ok(positive(run.id) && positive(run.run_attempt) && /^[a-f0-9]{40}$/.test(run.head_sha), "invalid run identity");
  return { repository, workflow, run: run.id, attempt: run.run_attempt, commit: run.head_sha };
}

function api(path, binary = false) {
  const output = execFileSync("gh", ["api", path], { timeout: 15000, maxBuffer: LIMIT, encoding: binary ? "buffer" : "utf8" });
  return binary ? output : JSON.parse(output);
}

export async function restore(runtime, env, request = api) {
  const repo = env.GITHUB_REPOSITORY, branch = env.DEFAULT_BRANCH;
  const workflow = request(`repos/${repo}/actions/workflows/ci.yml`).id;
  const runs = request(`repos/${repo}/actions/workflows/${workflow}/runs?event=push&branch=${encodeURIComponent(branch)}&status=success&per_page=1`).workflow_runs;
  assert.ok(runs?.length === 1, "no successful CI source");
  const source = trustedRun(request(`repos/${repo}/actions/runs/${runs[0].id}`), repo, workflow, branch);
  const artifacts = request(`repos/${repo}/actions/runs/${source.run}/artifacts?per_page=100`).artifacts;
  const matches = artifacts.filter((a) => a.name === artifactName(source.run, source.attempt) && !a.expired);
  assert.equal(matches.length, 1, "missing/ambiguous learned artifact");
  const artifact = matches[0];
  assert.ok(artifact.size_in_bytes <= LIMIT && artifact.workflow_run?.id === source.run && artifact.workflow_run?.head_sha === source.commit, "invalid artifact provenance");
  const dir = await mkdtemp(join(tmpdir(), "ci-timing-restore-"));
  try {
    const archive = join(dir, "profile.zip");
    await writeFile(archive, request(`repos/${repo}/actions/artifacts/${artifact.id}/zip`, true));
    // Read one bounded member without extracting artifact-controlled filesystem paths.
    const profile = JSON.parse(execFileSync("unzip", ["-p", archive, "profile.json"], { timeout: 5000, maxBuffer: LIMIT, encoding: "utf8" }));
    validateProfile(profile, runtime);
    for (const [key, value] of Object.entries(source)) assert.equal(profile.metadata[key], value, "artifact source mismatch");
    return profile;
  } finally { await rm(dir, { recursive: true, force: true }); }
}

async function context(env) {
  const inventory = await discoverRepositoryTests();
  const run = api(`repos/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`);
  assert.ok(env.GITHUB_EVENT_NAME === "push" && env.GITHUB_REF === `refs/heads/${env.DEFAULT_BRANCH}`, "publication requires default-branch push");
  assert.ok(run.event === "push" && run.head_branch === env.DEFAULT_BRANCH && run.repository?.full_name === env.GITHUB_REPOSITORY && run.head_repository?.full_name === env.GITHUB_REPOSITORY, "invalid current source");
  assert.equal(run.head_sha, env.GITHUB_SHA);
  assert.equal(run.id, Number(env.GITHUB_RUN_ID));
  assert.equal(run.run_attempt, Number(env.GITHUB_RUN_ATTEMPT));
  const runtime = currentRuntime(env);
  const input = JSON.parse(env.TIMING_INPUT);
  return { repository: env.GITHUB_REPOSITORY, workflow: run.workflow_id, run: Number(env.GITHUB_RUN_ID), attempt: Number(env.GITHUB_RUN_ATTEMPT), commit: env.GITHUB_SHA, runtime, inventory, inventoryDigest: digest(inventory), inputDigest: digest(input) };
}

function currentRuntime(env) {
  assert.equal(Bun.version, "1.4.1");
  assert.equal(Number(env.BUN_TEST_PARALLELISM), 2, "timing runtime requires two workers");
  return { bunVersion: Bun.version, platform: `${process.platform}-${process.arch}`, image: env.ImageOS ?? "unknown", parallelism: 2, shards: 4, isolation: false };
}

async function readProfile(path) {
  const text = await readFile(path, "utf8");
  assert.ok(Buffer.byteLength(text) <= LIMIT, "oversized profile");
  return JSON.parse(text);
}

async function main(command, env = process.env) {
  if (command === "prepare") {
    const trial = env.GITHUB_EVENT_NAME === "workflow_dispatch";
    let bootstrap;
    try { bootstrap = await readProfile(".bun-test-timings.json"); } catch { bootstrap = {}; }
    const inventory = await discoverRepositoryTests(), runtime = currentRuntime(env);
    const snapshot = trial
      ? validateTrialInput(await readFile(TRIAL_PROFILE, "utf8"), inventory, runtime)
      : await selectSnapshot({ inventory, runtime, bootstrap, restore: () => restore(runtime, env) });
    const text = JSON.stringify(snapshot);
    assert.ok(Buffer.byteLength(text) <= LIMIT, "snapshot exceeds output budget");
    const shards = trial ? env.TRIAL_SHARDS : "4";
    await appendFile(env.GITHUB_OUTPUT, `timing_input=${text}\nsuite_matrix=${JSON.stringify(trialMatrix(shards))}\n`);
    if (trial) console.log(`Trial shards=${shards}, profile sha256=${TRIAL_PROFILE_SHA256}, inventory=${inventory.length}, parallelism=2, source=${snapshot.metadata.commit}`);
  } else if (command === "input") {
    const profile = JSON.parse(env.TIMING_INPUT);
    filesOf(profile);
    const text = env.GITHUB_EVENT_NAME === "workflow_dispatch" ? await readFile(TRIAL_PROFILE, "utf8") : JSON.stringify(profile);
    assert.deepEqual(JSON.parse(text), profile, "inconsistent shard timing input");
    await writeFile(".ci-timing-input.json", text, { flag: "wx" });
    // Never seed the first timings path: sharded updates must contain measurements only.
    await writeFile(".ci-timing-output.json", "", { flag: "wx" });
    await rm(".ci-timing-output.json");
  } else if (command === "collect") {
    const profile = await readProfile(".ci-timing-output.json");
    filesOf(profile);
    profile.metadata = { ...await context(env), shard: Number(env.TIMING_SHARD) };
    profile.osRelease = release();
    await writeFile("shard.json", JSON.stringify(profile));
  } else if (command === "merge") {
    const records = [];
    for (const directory of await readdir("timing-shards")) records.push(await readProfile(join("timing-shards", directory, "shard.json")));
    const profile = combine(records, await context(env));
    await writeFile("profile.json", JSON.stringify(profile));
    console.log(`Publishing ${Object.keys(profile.files).length} measured files, source run ${profile.metadata.run}/${profile.metadata.attempt}`);
  } else if (command === "trial-verify") {
    assert.equal(env.GITHUB_EVENT_NAME, "workflow_dispatch");
    const inventory = await discoverRepositoryTests();
    validateTrialInput(await readFile(TRIAL_PROFILE, "utf8"), inventory, currentRuntime(env));
    const records = [];
    for (const directory of await readdir("timing-shards")) records.push({
      input: await readFile(join("timing-shards", directory, ".ci-timing-input.json"), "utf8"),
      output: await readProfile(join("timing-shards", directory, ".ci-timing-output.json")),
    });
    validateTrialMeasurements(records, inventory, env.TRIAL_SHARDS);
    console.log(`Trial complete and disjoint: ${inventory.length} files, ${env.TRIAL_SHARDS} shards, profile sha256=${TRIAL_PROFILE_SHA256}`);
  } else throw Error("Expected prepare, input, collect, merge or trial-verify");
}

if (import.meta.main) await main(process.argv[2]);
