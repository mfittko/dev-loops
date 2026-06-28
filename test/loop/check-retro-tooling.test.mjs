import assert from "node:assert/strict";
import test from "node:test";

import { analyzeTranscript } from "../../scripts/loop/check-retro-tooling.mjs";

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

test("allowed write-ops (gh pr merge / issue create) are recorded, not violations", () => {
  const transcript = [
    "gh pr merge 982 --squash",
    "gh issue create --title x",
    "gh pr ready 982",
  ].join("\n");
  const { violations, allowedWriteOps, internalToolingOnly } = analyzeTranscript(transcript);
  assert.deepEqual(violations, []);
  assert.equal(allowedWriteOps.length, 3);
  assert.equal(internalToolingOnly, true);
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
  assert.equal(violations.length, 3); // gh api, python3, node -e
  assert.equal(allowedWriteOps.length, 1); // gh pr merge
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
