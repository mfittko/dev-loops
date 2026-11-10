import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { parse } from "yaml";
import { combine, digest, selectSnapshot, validateProfile, trustedRun, restore, trialMatrix, validateTrialInput, validateTrialMeasurements } from "../../scripts/ci-test-timings.mjs";

const inventory = ["a.test.mjs", "b.test.mjs", "c.test.mjs", "d.test.mjs"];
const runtime = { bunVersion: "1.4.1", platform: "linux-x64", image: "ubuntu26", parallelism: 2, shards: 4, isolation: false };
const identity = { repository: "o/r", workflow: 12, run: 34, attempt: 2, commit: "a".repeat(40) };
const metadata = { ...identity, runtime, inventory, inventoryDigest: digest(inventory), inputDigest: digest({}) };
const records = () => inventory.map((file, i) => ({ version: 1, files: { [file]: i }, metadata: { ...metadata, shard: i + 1 } }));
const merged = () => combine(records(), metadata);

test("combination requires exactly four disjoint complete same-run measurements, accepting zero", () => {
  assert.deepEqual(merged().files, Object.fromEntries(inventory.map((p, i) => [p, i])));
  for (const key of ["run", "attempt", "commit", "inputDigest", "inventoryDigest", "runtime", "inventory"]) {
    const data = records(); data[1].metadata[key] = "different";
    assert.throws(() => combine(data, metadata), /metadata/);
  }
  for (const mutate of [
    (r) => r.pop(), (r) => r.push(r[0]), (r) => { r[1].metadata.shard = 1; },
    (r) => { r[1].files = r[0].files; }, (r) => { r[1].files = {}; },
    (r) => { r[1].files = { "unknown.test.mjs": 3 }; },
  ]) { const data = records(); mutate(data); assert.throws(() => combine(data, metadata)); }
  for (const duration of [-1, 0.5, 2 ** 32, "3", null, Infinity, NaN]) {
    const data = records(); data[0].files[inventory[0]] = duration;
    assert.throws(() => combine(data, metadata), /duration/);
  }
});

test("learned profile validates producer completeness and runtime, independently of consumer inventory", () => {
  assert.equal(validateProfile(merged(), runtime).version, 1);
  for (const mutate of [
    (p) => { p.version = 2; }, (p) => { delete p.files[inventory[0]]; },
    (p) => { p.metadata.runtime.parallelism = 8; }, (p) => { p.metadata.inventoryDigest = "wrong"; },
    (p) => { p.metadata.inventory.push("../outside"); },
  ]) { const p = structuredClone(merged()); mutate(p); assert.throws(() => validateProfile(p, runtime)); }
});

test("one immutable selection prunes deleted weights, leaves additions unknown, and centralizes fallback", async () => {
  const bootstrap = { version: 1, files: { "a.test.mjs": 9, "deleted.test.mjs": 7 } };
  const current = ["a.test.mjs", "new.test.mjs"];
  const snapshot = await selectSnapshot({ inventory: current, runtime, bootstrap, restore: async () => merged() });
  assert.deepEqual(snapshot.files, { "a.test.mjs": 0 });
  for (const restore of [async () => { throw Error("expired"); }, async () => ({}), async () => ({ ...merged(), version: 2 })]) {
    assert.deepEqual((await selectSnapshot({ inventory: current, runtime, bootstrap, restore, log: () => {} })).files, { "a.test.mjs": 9 });
  }
  assert.deepEqual((await selectSnapshot({ inventory: current, runtime, bootstrap: {}, restore: async () => ({}), log: () => {} })).files, {});
});

test("trusted run must be successful exact-workflow default-branch push from this repository", () => {
  const run = { id: 34, run_attempt: 2, head_sha: identity.commit, workflow_id: 12, status: "completed", conclusion: "success", event: "push", head_branch: "main", repository: { full_name: "o/r" }, head_repository: { full_name: "o/r" } };
  assert.deepEqual(trustedRun(run, "o/r", 12, "main"), identity);
  for (const [key, value] of [["event", "pull_request"], ["status", "in_progress"], ["conclusion", "failure"], ["head_branch", "other"], ["workflow_id", 13], ["head_repository", { full_name: "fork/r" }], ["run_attempt", 0]]) {
    assert.throws(() => trustedRun({ ...run, [key]: value }, "o/r", 12, "main"));
  }
});

test("restore binds real archive contents to API run, attempt, workflow and commit before selection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ci-timing-api-"));
  try {
    await writeFile(join(dir, "profile.json"), JSON.stringify(merged()));
    execFileSync("zip", ["-q", "profile.zip", "profile.json"], { cwd: dir });
    const archive = await readFile(join(dir, "profile.zip"));
    const run = { id: 34, run_attempt: 2, head_sha: identity.commit, workflow_id: 12, status: "completed", conclusion: "success", event: "push", head_branch: "main", repository: { full_name: "o/r" }, head_repository: { full_name: "o/r" } };
    const artifact = { id: 56, name: "ci-timings-34-2", expired: false, size_in_bytes: archive.length, workflow_run: { id: 34, head_sha: identity.commit } };
    const env = { GITHUB_REPOSITORY: "o/r", DEFAULT_BRANCH: "main" };
    const calls = [];
    const request = (path) => {
      calls.push(path);
      if (path.endsWith("/ci.yml")) return { id: 12 };
      if (path.includes("/runs?")) return { workflow_runs: [run] };
      if (path.endsWith("/runs/34")) return run;
      if (path.includes("/artifacts?")) return { artifacts: [artifact] };
      if (path.endsWith("/56/zip")) return archive;
      throw Error(`Unexpected API call ${path}`);
    };
    assert.deepEqual(await restore(runtime, env, request), merged());
    assert.equal(calls.length, 5);
    assert.match(calls[1], /event=push&branch=main&status=success&per_page=1/);
    for (const [object, key, value] of [[artifact, "expired", true], [artifact, "name", "ci-timings-34-1"], [artifact, "name", "ci-timing-diagnostic-34-2-1"], [artifact.workflow_run, "head_sha", "b".repeat(40)], [run, "run_attempt", 3], [run, "event", "pull_request"], [run, "conclusion", "failure"]]) {
      const previous = object[key]; object[key] = value;
      const snapshot = await selectSnapshot({ inventory, runtime, bootstrap: { version: 1, files: {} }, restore: () => restore(runtime, env, request), log: () => {} });
      assert.deepEqual(snapshot.files, {});
      object[key] = previous;
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("workflow preserves native inventory runs and read-only PR consumption with guarded optional publication", async () => {
  const workflow = parse(await readFile(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(workflow.on).sort(), ["pull_request", "push", "workflow_dispatch"]);
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.shards.options, ["4", "6"]);
  assert.equal(workflow.on.workflow_dispatch.inputs.shards.default, "4");
  assert.deepEqual(workflow.permissions, { contents: "read", actions: "read" });
  assert.equal(workflow.env.BUN_TEST_PARALLELISM, 2);
  const jobs = workflow.jobs, suite = jobs["verify-suite"];
  assert.equal(suite.needs, "changes");
  assert.equal(suite.env.BUN_TEST_PARALLELISM, 2);
  assert.equal(suite.strategy.matrix, "${{ fromJSON(needs.changes.outputs.suite_matrix) }}");
  assert.deepEqual(trialMatrix().include.filter((r) => r.shard).map((r) => [r.shard, r.shard_index]), [["1/4", 1], ["2/4", 2], ["3/4", 3], ["4/4", 4]]);
  assert.equal(jobs.changes.steps.find((s) => s.id === "timings").env.TRIAL_SHARDS, "${{ inputs.shards }}");
  assert.ok(jobs.verify.steps.some((s) => s.run === "bun scripts/ci-test-timings.mjs trial-verify" && s.if === "github.event_name == 'workflow_dispatch'"));
  const run = suite.steps.find((s) => s.run?.includes("--update-timings"));
  assert.match(run.run, /--timings=\.ci-timing-output.json --timings=\.ci-timing-input.json --update-timings --shard=/);
  assert.equal(run.env.BUN_TEST_TIMINGS_PATH, ".ci-timing-input.json");
  assert.deepEqual(jobs["publish-timings"].needs, ["changes", "verify"]);
  const uploads = suite.steps.filter((s) => s.uses === "actions/upload-artifact@v4");
  const diagnostic = uploads.find((s) => s.with.name.startsWith("ci-timing-diagnostic-"));
  assert.equal(diagnostic.if, "matrix.shard != '' && (github.event_name == 'pull_request' || github.event_name == 'workflow_dispatch')");
  assert.equal(diagnostic["continue-on-error"], "${{ github.event_name != 'workflow_dispatch' }}");
  assert.equal(diagnostic.with.name, "ci-timing-diagnostic-${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.shard_index }}");
  assert.equal(diagnostic.with.path, ".ci-timing-output.json\n.ci-timing-input.json\n");
  assert.equal(diagnostic.with["include-hidden-files"], true);
  assert.equal(diagnostic.with["if-no-files-found"], "error");
  assert.equal(diagnostic.with["retention-days"], 7);
  assert.equal(uploads.length, 2);
  for (const gate of [jobs["publish-timings"], suite.steps.find((s) => s.id === "collect-timings"), uploads.find((s) => s !== diagnostic)]) {
    assert.match(gate.if, /github.event_name == 'push'/);
    assert.match(gate.if, /github.ref == format\('refs\/heads\/\{0\}', github.event.repository.default_branch\)/);
  }
  assert.equal(jobs["publish-timings"]["continue-on-error"], true);
  assert.ok(jobs.verify.needs.includes("verify-suite"));
});

test.each([4, 6])("pinned native Bun fresh-first outputs partition all fixture files with %i shards and never retain seeded values", async (shards) => {
  assert.equal(Bun.version, "1.4.1");
  const root = await mkdtemp(join(tmpdir(), "ci-timings-"));
  try {
    const files = Array.from({ length: 8 }, (_, i) => `f${i}.test.mjs`);
    for (const file of files) await writeFile(join(root, file), 'import { test, expect } from "bun:test"; test("fixture", () => expect(1).toBe(1));');
    const seed = JSON.stringify({ version: 1, files: { ...Object.fromEntries(files.slice(0, 6).map((f) => [f, 100000])), "deleted.test.mjs": 999999 } });
    await writeFile(join(root, "input.json"), seed);
    const seen = [];
    for (let shard = 1; shard <= shards; shard++) {
      execFileSync(process.execPath, ["test", "--parallel=2", "--no-isolate", "--timeout=30000", "--timings=out.json", "--timings=input.json", "--update-timings", `--shard=${shard}/${shards}`, ...files.map((f) => `./${f}`)], { cwd: root, stdio: "pipe" });
      const output = JSON.parse(await readFile(join(root, "out.json"), "utf8"));
      seen.push(...Object.keys(output.files));
      assert.ok(Object.values(output.files).every((v) => v < 100000));
      await rm(join(root, "out.json"));
    }
    assert.deepEqual(seen.sort(), files);
    assert.equal(await readFile(join(root, "input.json"), "utf8"), seed);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("trial freezes measured profile bytes and rejects missing, duplicate, unknown or incompatible measurements", async () => {
  const input = await readFile(new URL("../../docs/phases/six-shard-trial-profile.json", import.meta.url), "utf8");
  const profile = JSON.parse(input), inventory = profile.metadata.inventory;
  assert.equal(inventory.length, 551);
  assert.deepEqual(validateTrialInput(input, inventory, runtime), profile);
  assert.throws(() => validateTrialInput(`${input}\n`, inventory, runtime), /bytes/);
  assert.throws(() => validateTrialInput(input, inventory.slice(1), runtime), /inventory/);
  assert.throws(() => validateTrialInput(input, inventory, { ...runtime, shards: 6 }), /runtime/);
  for (const count of ["4", "6"]) {
    const matrix = trialMatrix(count);
    assert.equal(matrix.include.length, Number(count) + 2);
    assert.deepEqual(matrix.include.slice(0, 2).map((r) => r.suite), ["test:docs", "test:workflows"]);
    const records = Array.from({ length: Number(count) }, (_, i) => ({ input, output: { version: 1, files: Object.fromEntries(inventory.filter((_, n) => n % Number(count) === i).map((p) => [p, 1])) } }));
    validateTrialMeasurements(records, inventory, count);
    for (const mutate of [
      (r) => r.pop(), (r) => r.push(r[0]), (r) => { r[1].output = r[0].output; },
      (r) => { r[0].output.files = {}; }, (r) => { r[0].output.files["unknown.test.mjs"] = 1; },
      (r) => { r[0].input += "\n"; }, (r) => { r[0].output.files[inventory[0]] = -1; },
    ]) { const data = structuredClone(records); mutate(data); assert.throws(() => validateTrialMeasurements(data, inventory, count)); }
  }
  for (const count of ["2", "8", "6;echo bad", 6, ""]) assert.throws(() => trialMatrix(count));
});
