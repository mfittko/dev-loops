import assert from "node:assert/strict";
import test from "node:test";

import {
  parseOfferCliArgs,
  applyHandoff,
  main,
} from "../../scripts/github/offer-human-handoff.mjs";

test("parseOfferCliArgs: parses repeated --assign / --request-review", () => {
  const out = parseOfferCliArgs([
    "--repo", "o/n", "--pr", "5",
    "--assign", "alice", "--assign", "@bob",
    "--request-review", "carol",
  ]);
  assert.equal(out.repo, "o/n");
  assert.equal(out.pr, 5);
  assert.deepEqual(out.assign, ["alice", "bob"]);
  assert.deepEqual(out.requestReview, ["carol"]);
});

test("parseOfferCliArgs: requires repo + pr", () => {
  assert.throws(() => parseOfferCliArgs(["--repo", "o/n"]), /requires both/);
});

test("applyHandoff: invokes `gh pr edit --add-assignee/--add-reviewer`", async () => {
  let captured;
  const result = await applyHandoff(
    { repo: "o/n", pr: 9, assign: ["alice"], requestReview: ["bob"] },
    { run: async (cmd, args) => { captured = { cmd, args }; return { code: 0, stdout: "", stderr: "" }; } },
  );
  assert.equal(captured.cmd, "gh");
  assert.deepEqual(captured.args, [
    "pr", "edit", "9", "--repo", "o/n",
    "--add-assignee", "alice",
    "--add-reviewer", "bob",
  ]);
  assert.deepEqual(result, { ok: true, mode: "apply", assigned: ["alice"], requestedReview: ["bob"] });
});

test("applyHandoff: surfaces gh failure", async () => {
  await assert.rejects(
    applyHandoff(
      { repo: "o/n", pr: 9, assign: ["alice"], requestReview: [] },
      { run: async () => ({ code: 1, stdout: "", stderr: "no such user" }) },
    ),
    /no such user/,
  );
});

test("main offer mode: prints candidates, assigns no one (disabled => no-op)", async () => {
  const chunks = [];
  const origWrite = process.stdout.write;
  process.stdout.write = (s) => { chunks.push(s); return true; };
  let ghCalled = false;
  let code;
  try {
    code = await main(["--repo", "o/n", "--pr", "1"], {
      config: { approval: { humanHandoff: { enabled: false } } },
      run: async () => { ghCalled = true; return { code: 0, stdout: "", stderr: "" }; },
    });
  } finally {
    process.stdout.write = origWrite;
  }
  assert.equal(code, 0);
  const out = JSON.parse(chunks.join(""));
  assert.equal(out.mode, "offer");
  assert.equal(out.enabled, false);
  assert.deepEqual(out.candidates, []);
  assert.equal(ghCalled, false);
});

test("main apply mode: operator confirmation routes via gh pr edit", async () => {
  const chunks = [];
  const origWrite = process.stdout.write;
  process.stdout.write = (s) => { chunks.push(s); return true; };
  let captured;
  let code;
  try {
    code = await main(["--repo", "o/n", "--pr", "2", "--assign", "alice"], {
      run: async (cmd, args) => { captured = { cmd, args }; return { code: 0, stdout: "", stderr: "" }; },
    });
  } finally {
    process.stdout.write = origWrite;
  }
  assert.equal(code, 0);
  assert.equal(captured.cmd, "gh");
  assert.deepEqual(captured.args, ["pr", "edit", "2", "--repo", "o/n", "--add-assignee", "alice"]);
  const out = JSON.parse(chunks.join(""));
  assert.equal(out.mode, "apply");
  assert.deepEqual(out.assigned, ["alice"]);
});
