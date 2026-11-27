import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import {
  readRequestNotObservable,
  recordPath,
  recordUnobservableRequest,
} from "../scripts/loop/_unobservable-review-request-record.mjs";

const pr = { repo: "o/r", pr: 1 };

test("two unobservable requests on the same head reach the threshold", async () => {
  const checkpointDir = await mkdtemp(path.join(os.tmpdir(), "unobservable-record-"));
  const read = () => readRequestNotObservable({ ...pr, headSha: "a" }, { checkpointDir });
  await recordUnobservableRequest({ ...pr, headSha: "a" }, { checkpointDir });
  assert.equal(await read(), false);
  await recordUnobservableRequest({ ...pr, headSha: "a" }, { checkpointDir });
  assert.equal(await read(), true);
});

test("a new head resets the count and the record never applies to another head", async () => {
  const checkpointDir = await mkdtemp(path.join(os.tmpdir(), "unobservable-record-"));
  for (let i = 0; i < 2; i += 1) {
    await recordUnobservableRequest({ ...pr, headSha: "a" }, { checkpointDir });
  }
  assert.equal(await readRequestNotObservable({ ...pr, headSha: "b" }, { checkpointDir }), false);
  const fresh = await recordUnobservableRequest({ ...pr, headSha: "b" }, { checkpointDir });
  assert.equal(fresh.unobservableRequests, 1);
  assert.equal(await readRequestNotObservable({ ...pr, headSha: "a" }, { checkpointDir }), false);
});

test("a threshold record at head a carries to head b only when the base-only-merge check accepts a to b", async () => {
  const checkpointDir = await mkdtemp(path.join(os.tmpdir(), "unobservable-record-"));
  for (let i = 0; i < 2; i += 1) {
    await recordUnobservableRequest({ ...pr, headSha: "a" }, { checkpointDir });
  }
  const read = (accepts, extra = { baseRef: "origin/main", repoRoot: "/r" }) => {
    const calls = [];
    const baseOnlyMerge = async (args) => { calls.push(args); return accepts; };
    return readRequestNotObservable({ ...pr, headSha: "b", ...extra }, { checkpointDir, baseOnlyMerge }).then((value) => ({ value, calls }));
  };
  const accepted = await read(true);
  assert.equal(accepted.value, true);
  assert.deepEqual(accepted.calls, [{ originHead: "a", headSha: "b", baseRef: "origin/main", repoRoot: "/r" }]);
  assert.equal((await read(false)).value, false);
  assert.equal((await read(true, {})).value, false);
  const throwing = async () => { throw new Error("git failed"); };
  assert.equal(await readRequestNotObservable({ ...pr, headSha: "b", baseRef: "origin/main", repoRoot: "/r" }, { checkpointDir, baseOnlyMerge: throwing }), false);
});

test("a below-threshold record never calls the base-only-merge check on another head", async () => {
  const checkpointDir = await mkdtemp(path.join(os.tmpdir(), "unobservable-record-"));
  await recordUnobservableRequest({ ...pr, headSha: "a" }, { checkpointDir });
  let calls = 0;
  const baseOnlyMerge = async () => { calls += 1; return true; };
  assert.equal(await readRequestNotObservable({ ...pr, headSha: "b", baseRef: "origin/main", repoRoot: "/r" }, { checkpointDir, baseOnlyMerge }), false);
  assert.equal(calls, 0);
});

test("a null head never counts", async () => {
  const checkpointDir = await mkdtemp(path.join(os.tmpdir(), "unobservable-record-"));
  assert.equal(await recordUnobservableRequest({ ...pr, headSha: null }, { checkpointDir }), null);
  await recordUnobservableRequest({ ...pr, headSha: "a" }, { checkpointDir });
  assert.equal(await readRequestNotObservable({ ...pr, headSha: null }, { checkpointDir }), false);
});

test("a non-integer or negative prior count restarts at zero", async () => {
  const checkpointDir = await mkdtemp(path.join(os.tmpdir(), "unobservable-record-"));
  const file = path.join(checkpointDir, "unobservable-review-requests.json");
  await writeFile(file, JSON.stringify({ ...pr, headSha: "a", unobservableRequests: -3 }));
  assert.equal((await recordUnobservableRequest({ ...pr, headSha: "a" }, { checkpointDir })).unobservableRequests, 1);
  await writeFile(file, JSON.stringify({ ...pr, headSha: "a", unobservableRequests: 1.5 }));
  assert.equal((await recordUnobservableRequest({ ...pr, headSha: "a" }, { checkpointDir })).unobservableRequests, 1);
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

