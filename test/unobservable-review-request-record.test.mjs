import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import {
  readProbeStartedAt,
  readRequestNotObservable,
  recordProbeStart,
  recordPath,
  recordTimedOutProbe,
  recordUnobservableRequest,
} from "../scripts/loop/_unobservable-review-request-record.mjs";

const pr = { repo: "o/r", pr: 1 };

test("two unobservable requests plus two timed-out probes on the same head reach the threshold", async () => {
  const checkpointDir = await mkdtemp(path.join(os.tmpdir(), "unobservable-record-"));
  const read = () => readRequestNotObservable({ ...pr, headSha: "a" }, { checkpointDir });
  assert.equal(await recordTimedOutProbe({ ...pr, headSha: "a" }, { checkpointDir }), null);
  await recordUnobservableRequest({ ...pr, headSha: "a" }, { checkpointDir });
  await recordTimedOutProbe({ ...pr, headSha: "a" }, { checkpointDir });
  assert.equal(await read(), false);
  await recordUnobservableRequest({ ...pr, headSha: "a" }, { checkpointDir });
  assert.equal(await read(), false);
  await recordTimedOutProbe({ ...pr, headSha: "a" }, { checkpointDir });
  assert.equal(await read(), true);
});

test("a new head resets the count and the record never applies to another head", async () => {
  const checkpointDir = await mkdtemp(path.join(os.tmpdir(), "unobservable-record-"));
  for (let i = 0; i < 2; i += 1) {
    await recordUnobservableRequest({ ...pr, headSha: "a" }, { checkpointDir });
    await recordTimedOutProbe({ ...pr, headSha: "a" }, { checkpointDir });
  }
  assert.equal(await readRequestNotObservable({ ...pr, headSha: "b" }, { checkpointDir }), false);
  const fresh = await recordUnobservableRequest({ ...pr, headSha: "b" }, { checkpointDir });
  assert.deepEqual([fresh.unobservableRequests, fresh.timedOutProbes], [1, 0]);
  assert.equal(await readRequestNotObservable({ ...pr, headSha: "a" }, { checkpointDir }), false);
});

test("a probe of another head, and a null head, never count", async () => {
  const checkpointDir = await mkdtemp(path.join(os.tmpdir(), "unobservable-record-"));
  assert.equal(await recordUnobservableRequest({ ...pr, headSha: null }, { checkpointDir }), null);
  await recordUnobservableRequest({ ...pr, headSha: "a" }, { checkpointDir });
  assert.equal(await recordTimedOutProbe({ ...pr, headSha: "b" }, { checkpointDir }), null);
  assert.equal(await recordTimedOutProbe({ ...pr, headSha: null }, { checkpointDir }), null);
  assert.equal(await readRequestNotObservable({ ...pr, headSha: null }, { checkpointDir }), false);
});

test("a non-integer or negative prior count restarts at zero", async () => {
  const checkpointDir = await mkdtemp(path.join(os.tmpdir(), "unobservable-record-"));
  const file = path.join(checkpointDir, "unobservable-review-requests.json");
  await writeFile(file, JSON.stringify({ ...pr, headSha: "a", unobservableRequests: -3, timedOutProbes: "x" }));
  const record = await recordUnobservableRequest({ ...pr, headSha: "a" }, { checkpointDir });
  assert.deepEqual([record.unobservableRequests, record.timedOutProbes], [1, 0]);
  await writeFile(file, JSON.stringify({ ...pr, headSha: "a", timedOutProbes: 1.5 }));
  assert.equal((await recordTimedOutProbe({ ...pr, headSha: "a" }, { checkpointDir })).timedOutProbes, 1);
});

test("a failed rename removes the temp file and rethrows", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "unobservable-record-"));
  // A directory at the record path makes the rename fail.
  await mkdir(path.join(dir, "unobservable-review-requests.json", "keep"), { recursive: true });
  await assert.rejects(recordUnobservableRequest({ ...pr, headSha: "a" }, { checkpointDir: dir }));
  assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith(".tmp")), []);
});

test("the default record path is the main checkout's from a linked worktree", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "unobservable-record-wt-")));
  const main = path.join(root, "main");
  const linked = path.join(root, "linked");
  const git = (...args) => execFileSync("git", args, { cwd: main, stdio: "ignore" });
  await mkdir(main);
  git("init", "-q", "-b", "main");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  git("worktree", "add", "-q", linked, "-b", "pr");
  const cwd = process.cwd();
  try {
    process.chdir(linked);
    const fromLinked = recordPath(pr.repo, pr.pr);
    process.chdir(main);
    assert.equal(recordPath(pr.repo, pr.pr), fromLinked);
    assert.ok(fromLinked.startsWith(`${main}${path.sep}`), fromLinked);
  } finally {
    process.chdir(cwd);
  }
});

test("a probe start is stored only on a record of the same head and a new request clears it", async () => {
  const checkpointDir = await mkdtemp(path.join(os.tmpdir(), "unobservable-record-"));
  const key = { ...pr, headSha: "a" };
  assert.equal(await recordProbeStart({ ...key, startedAt: 5 }, { checkpointDir }), null);
  await recordUnobservableRequest(key, { checkpointDir });
  await recordProbeStart({ ...key, startedAt: 5 }, { checkpointDir });
  assert.equal(await readProbeStartedAt(key, { checkpointDir }), 5);
  assert.equal(await readProbeStartedAt({ ...pr, headSha: "b" }, { checkpointDir }), null);
  await recordUnobservableRequest(key, { checkpointDir });
  assert.equal(await readProbeStartedAt(key, { checkpointDir }), null);
});
