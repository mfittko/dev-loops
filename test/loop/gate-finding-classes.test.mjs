import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "bun:test";

import { collectFindingClasses, main } from "../../scripts/loop/gate-finding-classes.mjs";

const dirs = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmpRoot = () => { const d = mkdtempSync(path.join(os.tmpdir(), "issue-3395-classes-")); dirs.push(d); return d; };

function writeLog(root, pr, sha, loggedAt, findings, gate = "draft_gate") {
  const dir = path.join(root, "gate-findings", "o-r", `pr-${pr}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${gate}-${sha}.json`), JSON.stringify({ loggedAt, findings }));
}
const f = (angle, judgeDisposition = "act", summary = `${angle} summary`) => ({ angle, judgeDisposition, summary });

test("only the first draft_gate round per PR counts, and only act findings", () => {
  const root = tmpRoot();
  writeLog(root, 1, "aaaaaaa", "2026-01-01T00:00:00Z", [f("tests"), f("tests"), f("docs", "reject"), f("scope")]);
  writeLog(root, 1, "bbbbbbb", "2026-01-02T00:00:00Z", [f("later"), f("later")]);
  writeLog(root, 1, "ccccccc", "2026-01-03T00:00:00Z", [f("pre")], "pre_approval_gate");
  writeLog(root, 2, "ddddddd", "2026-01-01T00:00:00Z", [f("tests")]);
  const r = collectFindingClasses({ repo: "o/r", tmpRoot: root });
  assert.equal(r.changes, 2);
  assert.equal(r.total, 4);
  assert.deepEqual(r.classes.map((c) => [c.angle, c.count, c.share]), [["tests", 3, 0.75], ["scope", 1, 0.25]]);
  assert.deepEqual(r.classes[0].examples, ["tests summary", "tests summary"]);
});

test("the class list is capped by --top (default 3) and examples are cut to 160 characters", () => {
  const root = tmpRoot();
  writeLog(root, 1, "aaaaaaa", "2026-01-01T00:00:00Z", [f("a", "act", "x".repeat(300)), f("b"), f("c"), f("d")]);
  const r = collectFindingClasses({ repo: "o/r", tmpRoot: root });
  assert.equal(r.classes.length, 3);
  assert.equal(r.classes[0].examples[0].length, 160);
  assert.equal(collectFindingClasses({ repo: "o/r", tmpRoot: root, top: 1 }).classes.length, 1);
});

test("a missing logs dir yields no classes; a malformed file is skipped and counted", () => {
  const root = tmpRoot();
  assert.deepEqual(collectFindingClasses({ repo: "o/r", tmpRoot: root }), { changes: 0, total: 0, skipped: 0, classes: [] });
  const dir = path.join(root, "gate-findings", "o-r", "pr-9");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "draft_gate-eeeeeee.json"), "{not json");
  assert.equal(collectFindingClasses({ repo: "o/r", tmpRoot: root }).skipped, 1);
});

test("the CLI prints the JSON result and refuses a malformed --top or --repo", async () => {
  const root = tmpRoot();
  writeLog(root, 1, "aaaaaaa", "2026-01-01T00:00:00Z", [f("tests")]);
  let out = "", err = "";
  const io = { stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } } };
  assert.equal(await main(["--repo", "o/r", "--tmp-root", root], io), 0);
  assert.equal(JSON.parse(out).classes[0].angle, "tests");
  assert.equal(await main(["--repo", "o/r", "--tmp-root", root, "--top", "0"], io), 1);
  assert.equal(await main(["--repo", "bad", "--tmp-root", root], io), 1);
  assert.match(err, /--top must be a positive integer/u);
});
