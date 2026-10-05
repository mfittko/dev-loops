import assert from "node:assert/strict";
import { test } from "bun:test";

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import { analyzeTranscript, run } from "../../scripts/loop/check-retro-tooling.mjs";

test("clean transcript: dev-loops tooling + node scripts only — no violations", () => {
  const transcript = [
    "node scripts/github/foo.mjs --pr 982",
    "node scripts/loop/check-retro-tooling.mjs --transcript x.txt",
    "dev-loops loop info",
    "gate capture-threads --pr 982",
    "queue list",
    "git status",
  ].join("\n");
  const { violations, internalToolingOnly } = analyzeTranscript(transcript);
  assert.deepEqual(violations, []);
  assert.equal(internalToolingOnly, true);
});

test("agent-level raw gh api is a violation", () => {
  const { violations, internalToolingOnly } = analyzeTranscript("gh api repos/o/r/pulls/1/comments");
  assert.equal(internalToolingOnly, false);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /^gh:/);
});

test("python and python3 are violations", () => {
  const { violations } = analyzeTranscript("python3 -c 'import json'\npython script.py");
  assert.equal(violations.length, 2);
  assert.match(violations[0], /^python3:/);
  assert.match(violations[1], /^python:/);
});

test("node -e and node --eval are violations; node scripts/x.mjs is not", () => {
  const transcript = [
    "node -e 'console.log(1)'",
    "node --eval 'console.log(2)'",
    "node scripts/github/reply-resolve-review-threads.mjs --pr 1",
  ].join("\n");
  const { violations } = analyzeTranscript(transcript);
  assert.equal(violations.length, 2);
  assert.ok(violations.every((v) => v.startsWith("node -e:")));
});

test("--eval after the script path is a script arg, not inline eval — clean", () => {
  const transcript = [
    "node scripts/github/foo.mjs --eval 'console.log(1)'",
    "node scripts/loop/check-retro-tooling.mjs --transcript x --eval",
  ].join("\n");
  const { violations, internalToolingOnly } = analyzeTranscript(transcript);
  assert.equal(violations.length, 0);
  assert.equal(internalToolingOnly, true);
});

test("script-internal gh (node scripts/github/foo.mjs) does NOT trip the verifier", () => {
  const { violations, internalToolingOnly } = analyzeTranscript("node scripts/github/foo.mjs --gh api");
  assert.deepEqual(violations, []);
  assert.equal(internalToolingOnly, true);
});

test("gh after && / | / ; separator is caught", () => {
  const { violations } = analyzeTranscript("git fetch && gh pr view 1");
  assert.equal(violations.length, 1);
  assert.match(violations[0], /gh pr view/);
});

test("gh pr ready is still an allowed write-op (no wrapper-forbidden raw form)", () => {
  const { violations, allowedWriteOps, internalToolingOnly } = analyzeTranscript("gh pr ready 982");
  assert.deepEqual(violations, []);
  assert.equal(allowedWriteOps.length, 1);
  assert.equal(internalToolingOnly, true);
});

test("raw `gh pr merge` is a flagged violation now that merge-pr.mjs wraps it (issue #1939)", () => {
  const { violations, allowedWriteOps, internalToolingOnly } = analyzeTranscript("gh pr merge 982 --squash");
  assert.equal(violations.length, 1);
  assert.match(violations[0], /gh pr merge/);
  assert.deepEqual(allowedWriteOps, []);
  assert.equal(internalToolingOnly, false);
});

test("raw `gh issue create` is a violation now that create-issue.mjs wraps it", () => {
  const { violations, allowedWriteOps, internalToolingOnly } = analyzeTranscript("gh issue create --title x");
  assert.equal(violations.length, 1);
  assert.match(violations[0], /gh issue create/);
  assert.deepEqual(allowedWriteOps, []);
  assert.equal(internalToolingOnly, false);
});

test("representative mixed transcript classifies correctly", () => {
  const transcript = [
    "node scripts/loop/resolve-dev-loop-startup.mjs --input -",
    "gate capture-threads --pr 982",
    "gh api graphql -f query='...'",
    "python3 -c \"import json,sys; print(json.load(sys.stdin))\"",
    "node -e \"require('fs')\"",
    "gh pr merge 982 --squash",
    "git commit -m wip",
  ].join("\n");
  const { violations, allowedWriteOps, internalToolingOnly } = analyzeTranscript(transcript);
  assert.equal(internalToolingOnly, false);
  assert.equal(violations.length, 4); // gh api, python3, node -e, gh pr merge
  assert.equal(allowedWriteOps.length, 0); // gh pr merge is no longer allowlisted
});

test("env-prefixed, wrapper-prefixed, and path-prefixed raw calls are violations", () => {
  const cases = [
    ["GH_TOKEN=x gh api repos/o/r", "gh"],
    ["sudo gh api foo", "gh"],
    ["xargs gh api foo", "gh"],
    ["NODE_OPTIONS=x node -e 'x'", "node -e"],
    ["./node_modules/.bin/gh pr view 1", "gh"],
    ["/usr/bin/python3 -c 'x'", "python3"],
  ];
  for (const [line, tool] of cases) {
    const { violations, internalToolingOnly } = analyzeTranscript(line);
    assert.equal(internalToolingOnly, false, `expected violation for: ${line}`);
    assert.equal(violations.length, 1, `expected one violation for: ${line}`);
    assert.ok(violations[0].startsWith(`${tool}:`), `expected ${tool} for: ${line} (got ${violations[0]})`);
  }
});

test("quoted env value with spaces does not under-report the real command", () => {
  // The space inside the quotes must not be mistaken for the env/command
  // separator; the real `gh api` head must still be classified as a violation.
  const cases = [
    'FOO="a b" gh api repos/o/r',
    "FOO='a b' gh api repos/o/r",
    'A=1 B="x y" gh api repos/o/r',
  ];
  for (const line of cases) {
    const { violations, internalToolingOnly } = analyzeTranscript(line);
    assert.equal(internalToolingOnly, false, `expected violation for: ${line}`);
    assert.equal(violations.length, 1, `expected one violation for: ${line}`);
    assert.ok(violations[0].startsWith("gh:"), `expected gh for: ${line} (got ${violations[0]})`);
  }
});

test("env prefix before an allowed node script stays clean", () => {
  const { violations, internalToolingOnly } = analyzeTranscript("env NODE_ENV=x node scripts/foo.mjs --pr 1");
  assert.deepEqual(violations, []);
  assert.equal(internalToolingOnly, true);
});

test("comments and blank lines are ignored", () => {
  const { violations } = analyzeTranscript("# this mentions gh api but is a comment\n\n   \n");
  assert.deepEqual(violations, []);
});

const SCRIPT = fileURLToPath(new URL("../../scripts/loop/check-retro-tooling.mjs", import.meta.url));

function runCli(args, stdinText) {
  return new Promise((resolve, reject) => {
    const child = spawn(Bun.which("node") ?? "node", [SCRIPT, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    // Chunked async writes with gaps let the child drain the pipe before EOF, which
    // is when a non-blocking stdin read fails, so the pipe runs dry before EOF as the old code hit.
    child.stdin.on("error", () => {});
    const text = stdinText ?? "";
    let closed = false;
    child.on("close", () => { closed = true; });
    (async () => {
      for (let i = 0; i < text.length && !closed; i += 16384) {
        if (!child.stdin.write(text.slice(i, i + 16384))) await new Promise((r) => child.stdin.once("drain", r).once("close", r));
        await new Promise((r) => setTimeout(r, 5));
      }
      child.stdin.end();
    })();
  });
}

function tmpFile(content) {
  const file = join(mkdtempSync(join(tmpdir(), "retro-tooling-")), "transcript.txt");
  writeFileSync(file, content);
  return file;
}

test("piped stdin over 64KB matches --transcript output", async () => {
  const transcript = Array.from({ length: 6000 }, (_, i) => `gh api repos/o/r/pulls/${i}/comments`).join("\n");
  assert.ok(transcript.length >= 200 * 1024);
  const viaFile = await runCli(["--json", "--transcript", tmpFile(transcript)]);
  const viaPipe = await runCli(["--json"], transcript);
  assert.equal(viaFile.status, 1);
  assert.equal(viaPipe.status, 1);
  assert.equal(viaPipe.stdout, viaFile.stdout);
  assert.equal(JSON.parse(viaPipe.stdout).rawCallViolations.length, 6000);
});

test("stdin read error rejects naming stdin and the cause, with no output", async () => {
  const stdin = new PassThrough();
  const out = [];
  const sink = { write: (s) => out.push(s) };
  const pending = run(["--json"], { stdout: sink, stderr: sink, stdin });
  stdin.destroy(new Error("boom"));
  await assert.rejects(pending, /stdin.*boom/);
  assert.deepEqual(out, []);
});

test("empty stdin exits 2 with 'empty transcript' and no clean result", async () => {
  const r = await runCli(["--json"], "  \n");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /empty transcript/);
  assert.doesNotMatch(r.stdout, /"ok":true/);
});

test("empty --transcript file exits 2 with 'empty transcript' and no clean result", async () => {
  const r = await runCli(["--json", "--transcript", tmpFile("\n \n")]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /empty transcript/);
  assert.doesNotMatch(r.stdout, /"ok":true/);
});

test("comment-only transcript is analyzed normally", async () => {
  const r = await runCli(["--json"], "# only a comment\n");
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).internalToolingOnly, true);
});
