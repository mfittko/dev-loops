import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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
  const t = (body) => JSON.stringify({ pr: 1, path: "a.mjs", isResolved: true, author: "copilot-pull-request-reviewer[bot]", body });
  writeFileSync(file, [
    t("Handle an empty or null input here."), t("The parser throws on missing fields."), t("Update the --help text."),
    t("Add a test for this branch. " + "y".repeat(300)), t("Unrelated remark."), "{not json", JSON.stringify({ pr: 2, author: "Copilot" }),
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
  writeFileSync(path.join(root, "copilot-threads.jsonl"), `${JSON.stringify({ author: "Copilot", body: "Add a test." })}\n`);
  out = "";
  assert.equal(await main(["--repo", "o/r", "--tmp-root", root], io), 0);
  assert.equal(JSON.parse(out).copilotClasses[0].class, "tests");
  out = "";
  assert.equal(await main(["--repo", "o/r", "--tmp-root", root, "--copilot-file", path.join(root, "nope")], io), 0);
  assert.deepEqual(JSON.parse(out).copilotClasses, []);
  assert.equal(await main(["--repo", "o/r", "--tmp-root", root, "--copilot-file"], io), 1);
});

test("--repo with a dot segment is a usage error", async () => {
  let err = "";
  assert.equal(await main(["--repo", "o/..", "--tmp-root", tmpRoot()], { stdout: { write() {} }, stderr: { write: (s) => { err += s; } }, cwd: process.cwd() }), 1);
  assert.match(err, /--repo must be owner\/name/u);
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

test("only the sanctioned Copilot reviewer author is counted, compared case-insensitively", () => {
  const root = tmpRoot();
  const file = path.join(root, "threads.jsonl");
  const accepted = ["copilot-pull-request-reviewer", "copilot-pull-request-reviewer[bot]", "Copilot", "COPILOT-PULL-REQUEST-REVIEWER[BOT]"];
  const rejected = ["", "octocat", "copilot-pull-request-reviewer-fan", "github-actions", undefined];
  const line = (author) => JSON.stringify({ body: "Add a test.", ...(author === undefined ? {} : { author }) });
  writeFileSync(file, [...accepted, ...rejected].map(line).join("\n"));
  const r = collectCopilotClasses({ file });
  assert.equal(r.copilotThreads, accepted.length);
  writeFileSync(file, rejected.map(line).join("\n"));
  assert.deepEqual(collectCopilotClasses({ file }), { copilotThreads: 0, copilotClasses: [] });
});

test("the first round falls back to the file mtime without loggedAt, and an equal-time tie goes to the lexically first file", () => {
  const root = tmpRoot();
  const dir = path.join(root, "gate-findings", "o-r", "pr-1");
  mkdirSync(dir, { recursive: true });
  const put = (name, log, mtime) => { const file = path.join(dir, name); writeFileSync(file, JSON.stringify(log)); utimesSync(file, mtime, mtime); };
  put("draft_gate-bbbbbbb.json", { findings: [f("undated-old")] }, new Date("2026-01-01T00:00:00Z"));
  put("draft_gate-aaaaaaa.json", { loggedAt: "2026-02-01T00:00:00Z", findings: [f("dated-later")] }, new Date("2026-03-01T00:00:00Z"));
  assert.deepEqual(collectFindingClasses({ repo: "o/r", tmpRoot: root }).classes.map((c) => c.angle), ["undated-old"]);
  const tie = tmpRoot();
  const tieDir = path.join(tie, "gate-findings", "o-r", "pr-1");
  mkdirSync(tieDir, { recursive: true });
  for (const [name, angle] of [["draft_gate-zzzzzzz.json", "zed"], ["draft_gate-aaaaaaa.json", "alpha"]]) writeFileSync(path.join(tieDir, name), JSON.stringify({ loggedAt: "2026-01-01T00:00:00Z", findings: [f(angle)] }));
  assert.deepEqual(collectFindingClasses({ repo: "o/r", tmpRoot: tie }).classes.map((c) => c.angle), ["alpha"]);
});

test("the CLI makes no gh invocation, with or without a Copilot export", () => {
  const root = tmpRoot();
  const bin = path.join(root, "bin");
  const marker = path.join(root, "gh-was-run");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "gh"), `#!/bin/sh\ntouch "${marker}"\nexit 1\n`);
  chmodSync(path.join(bin, "gh"), 0o755);
  writeLog(root, 1, "aaaaaaa", "2026-01-01T00:00:00Z", [f("tests")]);
  const cli = path.resolve(import.meta.dir, "../../scripts/loop/gate-finding-classes.mjs");
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  const run = () => spawnSync(process.execPath, [cli, "--repo", "o/r", "--tmp-root", root], { env, encoding: "utf8", cwd: root });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).classes[0].angle, "tests");
  assert.equal(existsSync(marker), false);
  writeFileSync(path.join(root, "copilot-threads.jsonl"), `${JSON.stringify({ author: "copilot-pull-request-reviewer", body: "Add a test." })}\n`);
  const withExport = run();
  assert.equal(withExport.status, 0, withExport.stderr);
  assert.ok(JSON.parse(withExport.stdout).copilotClasses.length > 0);
  assert.equal(existsSync(marker), false);
});
