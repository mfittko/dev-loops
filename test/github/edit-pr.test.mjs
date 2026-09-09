import assert from "node:assert/strict";
import { test } from "bun:test";

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseEditPrCliArgs, editPr, runCli } from "../../scripts/github/edit-pr.mjs";
import { captureStream, makeGhStub } from "../_helpers.mjs";

function stubGh({ code = 0, stderr = "" } = {}) {
  return makeGhStub([{ code, stdout: code === 0 ? "https://github.com/o/n/pull/17\n" : "", stderr }], { repeatLastOnOverflow: true });
}

test("parseEditPrCliArgs: requires --repo, --pr and at least one edit", () => {
  assert.throws(() => parseEditPrCliArgs(["--repo", "o/n"]), /requires both --repo/);
  assert.throws(() => parseEditPrCliArgs(["--repo", "o/n", "--pr", "1"]), /at least one of/);
});

test("parseEditPrCliArgs: --body and --body-file are mutually exclusive", () => {
  assert.throws(
    () => parseEditPrCliArgs(["--repo", "o/n", "--pr", "1", "--body", "x", "--body-file", "f"]),
    /mutually exclusive/,
  );
});

test("parseEditPrCliArgs: --milestone '' parses (empty clears; not rejected as missing)", () => {
  const out = parseEditPrCliArgs(["--repo", "o/n", "--pr", "1", "--milestone", ""]);
  assert.equal(out.milestone, "");
});

test("parseEditPrCliArgs: --milestone rejects whitespace-only but allows a real name and empty clear", () => {
  assert.throws(() => parseEditPrCliArgs(["--repo", "o/n", "--pr", "1", "--milestone", "   "]), /whitespace-only is not allowed/);
  assert.equal(parseEditPrCliArgs(["--repo", "o/n", "--pr", "1", "--milestone", "v1.0"]).milestone, "v1.0");
  assert.equal(parseEditPrCliArgs(["--repo", "o/n", "--pr", "1", "--milestone", ""]).milestone, "");
});

test("parseEditPrCliArgs: --milestone with no value is rejected", () => {
  // A bare --milestone (no following token) is a real omission, not an empty clear.
  assert.throws(() => parseEditPrCliArgs(["--repo", "o/n", "--pr", "1", "--milestone"]), /--milestone requires a value/);
});

test("parseEditPrCliArgs: rejects whitespace-only --title / --body", () => {
  assert.throws(() => parseEditPrCliArgs(["--repo", "o/n", "--pr", "1", "--title", "   "]), /--title must not be empty or whitespace/);
  assert.throws(() => parseEditPrCliArgs(["--repo", "o/n", "--pr", "1", "--body", "\t\n"]), /--body must not be empty or whitespace/);
});

test("parseEditPrCliArgs: collects repeated assignees", () => {
  const out = parseEditPrCliArgs(["--repo", "o/n", "--pr", "1", "--add-assignee", "a", "--add-assignee", "b"]);
  assert.deepEqual(out.addAssignees, ["a", "b"]);
});

test("editPr: builds gh pr edit args and reports edited fields", async () => {
  const { run, calls } = stubGh();
  const result = await editPr(
    { repo: "o/n", pr: 17, title: "New", body: "Body", addAssignees: ["me"], removeAssignees: [], milestone: undefined },
    { run },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.edited, ["title", "body", "add-assignee"]);
  assert.deepEqual(calls[0], [
    "pr", "edit", "17", "--repo", "o/n", "--title", "New", "--body", "Body", "--add-assignee", "me",
  ]);
});

test("editPr: empty --milestone clears (passes empty string through)", async () => {
  const { run, calls } = stubGh();
  await editPr({ repo: "o/n", pr: 1, addAssignees: [], removeAssignees: [], milestone: "" }, { run });
  assert.deepEqual(calls[0], ["pr", "edit", "1", "--repo", "o/n", "--milestone", ""]);
});

test("editPr: throws when gh fails", async () => {
  const { run } = stubGh({ code: 1, stderr: "forbidden" });
  await assert.rejects(
    () => editPr({ repo: "o/n", pr: 1, title: "x", addAssignees: [], removeAssignees: [] }, { run }),
    /gh pr edit failed: forbidden/,
  );
});

test("runCli: --jq extracts an edited field; --silent maps to exit code", async () => {
  const { run } = stubGh();
  const stdout = captureStream();
  const code = await runCli(["--repo", "o/n", "--pr", "1", "--title", "T", "--jq", ".edited[0]"], { run, stdout });
  assert.equal(code, 0);
  assert.equal(stdout.get().trim(), "title");

  const { run: run2 } = stubGh();
  const code2 = await runCli(["--repo", "o/n", "--pr", "1", "--title", "T", "--silent"], { run: run2, stdout: captureStream() });
  assert.equal(code2, 0);
});

test("editPr: --body-file fails closed on an empty/whitespace-only file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "edit-pr-"));
  const emptyPath = join(dir, "empty.md");
  writeFileSync(emptyPath, "   \n  ");
  const { run } = stubGh();
  await assert.rejects(
    () => editPr({ repo: "o/n", pr: 5, bodyFile: emptyPath, addAssignees: [], removeAssignees: [] }, { run }),
    /is empty/,
  );
});

test("editPr: --body-file reads the body from a real file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "edit-pr-"));
  const bodyPath = join(dir, "body.md");
  writeFileSync(bodyPath, "Body from file\nsecond line");
  const { run, calls } = stubGh();
  const result = await editPr(
    { repo: "o/n", pr: 5, bodyFile: bodyPath, addAssignees: [], removeAssignees: [] },
    { run },
  );
  assert.deepEqual(result.edited, ["body"]);
  assert.deepEqual(calls[0], ["pr", "edit", "5", "--repo", "o/n", "--body-file", bodyPath]);
});

test("editPr: --body-file - reads stdin and passes it inline as --body (never re-emits exhausted fd 0)", () => {
  // resolveBody consumes fd 0 to validate the body; re-emitting `--body-file -`
  // would make gh re-read an already-drained stdin and clear the PR body. So the
  // resolved stdin content must be passed inline via --body. Exercised in a child
  // process because resolveBody reads the real fd 0 (stdin).
  const modUrl = new URL("../../scripts/github/edit-pr.mjs", import.meta.url).href;
  const dir = mkdtempSync(join(tmpdir(), "edit-pr-stdin-"));
  const driver = join(dir, "driver.mjs");
  writeFileSync(
    driver,
    `import { editPr } from ${JSON.stringify(modUrl)};\n` +
      "const calls = [];\n" +
      "await editPr(\n" +
      "  { repo: \"o/n\", pr: 17, bodyFile: \"-\", addAssignees: [], removeAssignees: [] },\n" +
      "  { run: async (_cmd, args) => { calls.push(args); return { code: 0, stdout: \"\", stderr: \"\" }; } },\n" +
      ");\n" +
      "process.stdout.write(JSON.stringify(calls[0]));\n",
  );
  const res = spawnSync((Bun.which("node") ?? "node"), [driver], { input: "Body from stdin\n", encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  const args = JSON.parse(res.stdout);
  assert.deepEqual(args, ["pr", "edit", "17", "--repo", "o/n", "--body", "Body from stdin\n"]);
  assert.ok(!args.includes("--body-file"), "must not re-emit --body-file - for an exhausted stdin");
});

test("editPr: --remove-assignee builds gh args and reports the edited field", async () => {
  const { run, calls } = stubGh();
  const result = await editPr(
    { repo: "o/n", pr: 5, addAssignees: ["a"], removeAssignees: ["b", "c"] },
    { run },
  );
  assert.deepEqual(result.edited, ["add-assignee", "remove-assignee"]);
  assert.deepEqual(calls[0], [
    "pr", "edit", "5", "--repo", "o/n",
    "--add-assignee", "a", "--remove-assignee", "b", "--remove-assignee", "c",
  ]);
});

test("editPr: GRILL-SUBLOOP-NO-EMBED-SYNTHESIS (#1628) refuses a body embedding grill headings under --enforce-grill", async () => {
  const { run } = stubGh();
  await assert.rejects(
    () => editPr({
      repo: "o/n", pr: 5,
      body: "## Acceptance criteria\n\n- [ ] ac\n\n## Grill findings\n\n- Q: what\n- A: ans\n",
      addAssignees: [], removeAssignees: [],
      enforceGrill: true,
    }, { run }),
    /GRILL-SUBLOOP-NO-EMBED-SYNTHESIS/,
  );
});

test("editPr: --enforce-grill does not refuse a clean body containing no grill embed", async () => {
  const { run, calls } = stubGh();
  const result = await editPr({
    repo: "o/n", pr: 5,
    body: "## Acceptance criteria\n\n- [ ] ac\n\n<!-- loop-grill: 2026-08-14 mode:auto -->",
    addAssignees: [], removeAssignees: [],
    enforceGrill: true,
  }, { run });
  assert.deepEqual(result.edited, ["body"]);
  assert.ok(calls.length === 1);
});

test("parseEditPrCliArgs: --enforce-grill flag is wired", () => {
  const opts = parseEditPrCliArgs(["--repo", "o/n", "--pr", "5", "--title", "x", "--enforce-grill"]);
  assert.equal(opts.enforceGrill, true);
});

test("editPr: --base retargets the PR (gh pr edit ... --base <branch>) and reports base in the edited set (#2062)", async () => {
  const { run, calls } = stubGh();
  const result = await editPr(
    { repo: "o/n", pr: 17, base: "1.0.2-slim", addAssignees: [], removeAssignees: [] },
    { run },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.edited, ["base"]);
  assert.deepEqual(calls[0], ["pr", "edit", "17", "--repo", "o/n", "--base", "1.0.2-slim"]);
});

test("parseEditPrCliArgs: --base alone satisfies the at-least-one-edit requirement and parses the branch (#2062)", () => {
  const out = parseEditPrCliArgs(["--repo", "o/n", "--pr", "1", "--base", "main"]);
  assert.equal(out.base, "main");
});

test("parseEditPrCliArgs: --base refuses an empty or whitespace-only value (#2062)", () => {
  assert.throws(() => parseEditPrCliArgs(["--repo", "o/n", "--pr", "1", "--base", ""]), /--base must not be empty or whitespace/);
  assert.throws(() => parseEditPrCliArgs(["--repo", "o/n", "--pr", "1", "--base", "   "]), /--base must not be empty or whitespace/);
});

test("parseEditPrCliArgs: bare --base with no value is rejected (#2062)", () => {
  assert.throws(() => parseEditPrCliArgs(["--repo", "o/n", "--pr", "1", "--base"]), /--base/);
});

test("editPr: --base combines with other edits and appears once in the forwarded argv (#2062)", async () => {
  const { run, calls } = stubGh();
  const result = await editPr(
    { repo: "o/n", pr: 5, title: "T", base: "main", addAssignees: [], removeAssignees: [] },
    { run },
  );
  assert.deepEqual(result.edited, ["title", "base"]);
  assert.deepEqual(calls[0], ["pr", "edit", "5", "--repo", "o/n", "--title", "T", "--base", "main"]);
});

// --- branch-derived closing-reference guard (CLOSING-REF-BRANCH-MISMATCH) ---

const editOpts = (over) => ({ repo: "o/n", pr: 17, addAssignees: [], removeAssignees: [], allowCrossIssue: false, ...over });

test("editPr: refuses a new body whose closing reference disagrees with the PR's branch-slug issue", async () => {
  const { run } = stubGh();
  const fetchPrContext = async () => ({ headRefName: "dl/issue-2092-body-swap", closingIssuesReferences: [] });
  await assert.rejects(
    () => editPr(editOpts({ body: "Body text. Closes #2071" }), { run, fetchPrContext }),
    /CLOSING-REF-BRANCH-MISMATCH.*#2071.*#2092/s,
  );
});

test("editPr: refuses a wrong SECOND closing reference even when the first matches (GitHub closes every one)", async () => {
  const { run } = stubGh();
  const fetchPrContext = async () => ({ headRefName: "issue-2092", closingIssuesReferences: [] });
  await assert.rejects(
    () => editPr(editOpts({ body: "Closes #2092\n\nCloses #2071" }), { run, fetchPrContext }),
    /CLOSING-REF-BRANCH-MISMATCH.*#2071/s,
  );
});

test("editPr: refuses a mismatch expressed with a non-Closes/Fixes verb (Resolves)", async () => {
  const { run } = stubGh();
  const fetchPrContext = async () => ({ headRefName: "issue-2092", closingIssuesReferences: [] });
  await assert.rejects(
    () => editPr(editOpts({ body: "Resolves #2071" }), { run, fetchPrContext }),
    /CLOSING-REF-BRANCH-MISMATCH.*#2071.*#2092/s,
  );
});

test("editPr: accepts a correct-match body derived from the PR's branch slug", async () => {
  const { run, calls } = stubGh();
  const fetchPrContext = async () => ({ headRefName: "issue-2092", closingIssuesReferences: [] });
  const result = await editPr(editOpts({ body: "Closes #2092" }), { run, fetchPrContext });
  assert.deepEqual(result.edited, ["body"]);
  assert.equal(calls.length, 1);
});

test("editPr: falls back to closingIssuesReferences when the branch encodes no issue, and refuses a mismatch", async () => {
  const { run } = stubGh();
  const fetchPrContext = async () => ({ headRefName: "fix/thing", closingIssuesReferences: [{ number: 2092 }] });
  await assert.rejects(
    () => editPr(editOpts({ body: "Closes #2071" }), { run, fetchPrContext }),
    /CLOSING-REF-BRANCH-MISMATCH.*#2071.*#2092/s,
  );
});

test("editPr: exempts an issue-less PR (no branch issue, no closingIssuesReferences) even with a closing reference", async () => {
  const { run, calls } = stubGh();
  const fetchPrContext = async () => ({ headRefName: "fix/thing", closingIssuesReferences: [] });
  const result = await editPr(editOpts({ body: "Closes #2071" }), { run, fetchPrContext });
  assert.deepEqual(result.edited, ["body"]);
  assert.equal(calls.length, 1);
});

test("editPr: --allow-cross-issue waives the mismatch guard (and never fetches PR context)", async () => {
  const { run, calls } = stubGh();
  let fetched = false;
  const fetchPrContext = async () => { fetched = true; return null; };
  const result = await editPr(editOpts({ body: "Closes #2071", allowCrossIssue: true }), { run, fetchPrContext });
  assert.deepEqual(result.edited, ["body"]);
  assert.equal(fetched, false, "waiver must skip the PR-context fetch entirely");
  assert.equal(calls.length, 1);
});

test("editPr: fails closed when the PR context cannot be resolved and the body carries a closing reference", async () => {
  const { run } = stubGh();
  const fetchPrContext = async () => null;
  await assert.rejects(
    () => editPr(editOpts({ body: "Closes #2071" }), { run, fetchPrContext }),
    /CLOSING-REF-BRANCH-MISMATCH.*fail closed/s,
  );
});

test("editPr: a body with no closing reference never fetches PR context and edits normally", async () => {
  const { run, calls } = stubGh();
  let fetched = false;
  const fetchPrContext = async () => { fetched = true; return { headRefName: "issue-2092", closingIssuesReferences: [] }; };
  const result = await editPr(editOpts({ body: "Just a plain body update, no closing keyword" }), { run, fetchPrContext });
  assert.deepEqual(result.edited, ["body"]);
  assert.equal(fetched, false, "no closing reference means nothing to mislink, so no fetch");
  assert.equal(calls.length, 1);
});

test("parseEditPrCliArgs: --allow-cross-issue flag is wired", () => {
  const opts = parseEditPrCliArgs(["--repo", "o/n", "--pr", "5", "--body", "x", "--allow-cross-issue"]);
  assert.equal(opts.allowCrossIssue, true);
});

test("editPr: --enforce-grill with --body-file - forwards stdin inline (no fd 0 double-read), not --body-file -", () => {
  // Under --enforce-grill the grill check reads std IN first; the fix forwards
  // the resolved text inline so the gh call never re-reads the exhausted fd 0.
  const modUrl = new URL("../../scripts/github/edit-pr.mjs", import.meta.url).href;
  const dir = mkdtempSync(join(tmpdir(), "edit-pr-grill-stdin-"));
  const driver = join(dir, "driver.mjs");
  writeFileSync(
    driver,
    `import { editPr } from ${JSON.stringify(modUrl)};\n` +
      "const calls = [];\n" +
      "await editPr(\n" +
      "  { repo: \"o/n\", pr: 17, bodyFile: \"-\", enforceGrill: true, addAssignees: [], removeAssignees: [] },\n" +
      "  { run: async (_c, args) => { calls.push(args); return { code: 0, stdout: \"\", stderr: \"\" }; } },\n" +
      ");\n" +
      "process.stdout.write(JSON.stringify(calls[0]));\n",
  );
  const res = spawnSync((Bun.which("node") ?? "node"), [driver], { input: "## Acceptance criteria\n\n- [ ] ac\n", encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  const args = JSON.parse(res.stdout);
  assert.deepEqual(args, ["pr", "edit", "17", "--repo", "o/n", "--body", "## Acceptance criteria\n\n- [ ] ac\n"]);
  assert.ok(!args.includes("--body-file"), "must not re-emit --body-file - under --enforce-grill");
});
