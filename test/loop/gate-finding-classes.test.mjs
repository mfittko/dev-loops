import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "bun:test";

import { collectCopilotClasses, collectFindingClasses, main } from "../../scripts/loop/gate-finding-classes.mjs";

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

test("Copilot threads from a local export are bucketed by keyword; malformed lines and a missing file are skipped", () => {
  const root = tmpRoot();
  const file = path.join(root, "threads.jsonl");
  const t = (body) => JSON.stringify({ pr: 1, path: "a.mjs", isResolved: true, body });
  writeFileSync(file, [
    t("Handle an empty or null input here."), t("The parser throws on missing fields."), t("Update the --help text."),
    t("Add a test for this branch. " + "y".repeat(300)), t("Unrelated remark."), "{not json", JSON.stringify({ pr: 2 }),
  ].join("\n"));
  const r = collectCopilotClasses({ file });
  assert.equal(r.copilotThreads, 5);
  assert.deepEqual(r.copilotClasses.map((c) => [c.class, c.count, c.share]), [["edge-case-input-validation", 2, 0.4], ["docs-help-description", 1, 0.2], ["other", 1, 0.2]]);
  assert.equal(collectCopilotClasses({ file, top: 4 }).copilotClasses.find((c) => c.class === "tests").examples[0].length, 160);
  assert.deepEqual(collectCopilotClasses({ file: path.join(root, "nope.jsonl") }), { copilotThreads: 0, copilotClasses: [] });
});

test("the CLI adds copilotClasses from --copilot-file or the default export, and emits an empty list without one", async () => {
  const root = tmpRoot();
  let out = "";
  const io = { stdout: { write: (s) => { out += s; } }, stderr: { write() {} } };
  assert.equal(await main(["--repo", "o/r", "--tmp-root", root], io), 0);
  assert.deepEqual(JSON.parse(out).copilotClasses, []);
  writeFileSync(path.join(root, "copilot-threads.jsonl"), `${JSON.stringify({ body: "Add a test." })}\n`);
  out = "";
  assert.equal(await main(["--repo", "o/r", "--tmp-root", root], io), 0);
  assert.equal(JSON.parse(out).copilotClasses[0].class, "tests");
  out = "";
  assert.equal(await main(["--repo", "o/r", "--tmp-root", root, "--copilot-file", path.join(root, "nope")], io), 0);
  assert.deepEqual(JSON.parse(out).copilotClasses, []);
  assert.equal(await main(["--repo", "o/r", "--tmp-root", root, "--copilot-file"], io), 1);
});

test("a non-directory pr-N entry is counted as skipped and does not fail the run", () => {
  const root = tmpRoot();
  writeLog(root, 1, "aaaaaaa", "2026-01-01T00:00:00Z", [f("tests")]);
  writeFileSync(path.join(root, "gate-findings", "o-r", "pr-2"), "not a directory");
  const r = collectFindingClasses({ repo: "o/r", tmpRoot: root });
  assert.equal(r.skipped, 1);
  assert.equal(r.changes, 1);
  assert.deepEqual(r.classes.map((c) => c.angle), ["tests"]);
});
