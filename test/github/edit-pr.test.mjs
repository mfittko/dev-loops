import assert from "node:assert/strict";
import { test } from "bun:test";

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseEditPrCliArgs, editPr as editPrRaw, runCli } from "../../scripts/github/edit-pr.mjs";
import { captureStream, makeGhStub } from "../_helpers.mjs";

// A body edit reads the PR's current body (waiver-line baseline) through
// fetchPrContext. Default it to an empty-body PR; a test-supplied context
// without a body gets an empty one.
const PLAIN_PR_CONTEXT = { headRefName: "x", closingIssuesReferences: [], body: "" };
const editPr = (options, runtime = {}) => {
  const fetchPrContext = runtime.fetchPrContext
    ? async (...a) => {
        const ctx = await runtime.fetchPrContext(...a);
        return ctx === null || typeof ctx.body === "string" ? ctx : { ...ctx, body: "" };
      }
    : async () => PLAIN_PR_CONTEXT;
  return editPrRaw(options, { ...runtime, fetchPrContext });
};

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
  assert.deepEqual(calls[0], ["pr", "edit", "5", "--repo", "o/n", "--body", "Body from file\nsecond line"]);
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
      "  { fetchPrContext: async () => ({ headRefName: \"x\", closingIssuesReferences: [], body: \"\" }), run: async (_cmd, args) => { calls.push(args); return { code: 0, stdout: \"\", stderr: \"\" }; } },\n" +
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

test("editPr: --allow-cross-issue waives the mismatch guard (the context is read once, for the waiver baseline)", async () => {
  const { run, calls } = stubGh();
  let fetches = 0;
  const fetchPrContext = async () => { fetches += 1; return { headRefName: "issue-2092", closingIssuesReferences: [], body: "" }; };
  const result = await editPr(editOpts({ body: "Closes #2071", allowCrossIssue: true }), { run, fetchPrContext });
  assert.deepEqual(result.edited, ["body"]);
  assert.equal(fetches, 1);
  assert.equal(calls.length, 1);
});

test("editPr: fails closed when the PR context cannot be resolved", async () => {
  const { run } = stubGh();
  const fetchPrContext = async () => null;
  await assert.rejects(
    () => editPr(editOpts({ body: "Closes #2071" }), { run, fetchPrContext }),
    /fail closed/s,
  );
});

test("editPr: refuses a waiver-baseline-less edit when the current body cannot be read", async () => {
  const { run, calls } = stubGh();
  const fetchPrContext = async () => null;
  await assert.rejects(
    () => editPr(editOpts({ body: "plain" }), { run, fetchPrContext }),
    /ADR-TRIPWIRE-STANDING-WAIVER.*cannot read the current body/s,
  );
  assert.equal(calls.length, 0);
});

test("editPr: a body with no closing reference edits normally after one context read", async () => {
  const { run, calls } = stubGh();
  let fetches = 0;
  const fetchPrContext = async () => { fetches += 1; return { headRefName: "issue-2092", closingIssuesReferences: [], body: "" }; };
  const result = await editPr(editOpts({ body: "Just a plain body update, no closing keyword" }), { run, fetchPrContext });
  assert.deepEqual(result.edited, ["body"]);
  assert.equal(fetches, 1);
  assert.equal(calls.length, 1);
});

// --- ADR-TRIPWIRE-STANDING-WAIVER: no hand-written waiver line ---

const WAIVER = "adr-tripwire:allow contract doc edit named in the issue matrix";
const withCurrentBody = (body) => async () => ({ headRefName: "x", closingIssuesReferences: [], body });

test("editPr: refuses a body that ADDS an adr-tripwire:allow line and names the sanctioned writer", async () => {
  const { run, calls } = stubGh();
  await assert.rejects(
    () => editPr(editOpts({ body: `Body\n\n${WAIVER}\n` }), { run, fetchPrContext: withCurrentBody("Body\n") }),
    /ADR-TRIPWIRE-STANDING-WAIVER.*dev-loops pr waive-adr-tripwire/s,
  );
  assert.equal(calls.length, 0, "refused before gh pr edit runs");
});

test("editPr: refuses a body that CHANGES an existing adr-tripwire:allow line", async () => {
  const { run } = stubGh();
  await assert.rejects(
    () => editPr(editOpts({ body: "Body\n\nadr-tripwire:allow another reason\n" }), { run, fetchPrContext: withCurrentBody(`Body\n\n${WAIVER}\n`) }),
    /dev-loops pr waive-adr-tripwire/,
  );
});

test("editPr: refuses a body that REMOVES an existing adr-tripwire:allow line", async () => {
  const { run } = stubGh();
  await assert.rejects(
    () => editPr(editOpts({ body: "Body\n" }), { run, fetchPrContext: withCurrentBody(`Body\n\n${WAIVER}\n`) }),
    /dev-loops pr waive-adr-tripwire/,
  );
});

test("editPr: refuses the same standing-authorization waiver line when written by hand", async () => {
  const { run } = stubGh();
  const line = `adr-tripwire:allow standing-authorization head=${"a".repeat(40)} issue=7 granted-by=op expires=2026-12-01 paths=skills/docs/x-contract.md`;
  await assert.rejects(
    () => editPr(editOpts({ body: `Body\n\n${line}\n` }), { run, fetchPrContext: withCurrentBody("Body\n") }),
    /dev-loops pr waive-adr-tripwire/,
  );
});

test("editPr: accepts an edit that preserves the existing waiver lines", async () => {
  const { run, calls } = stubGh();
  const result = await editPr(editOpts({ body: `New prose\n\n${WAIVER}\n` }), { run, fetchPrContext: withCurrentBody(`Old prose\n\n${WAIVER}\n`) });
  assert.deepEqual(result.edited, ["body"]);
  assert.equal(calls.length, 1);
});

test("editPr: the waiverWriter runtime seam may change the waiver line (no CLI flag exists)", async () => {
  const { run, calls } = stubGh();
  const result = await editPrRaw(editOpts({ body: `Body\n\n${WAIVER}\n` }), { run, waiverWriter: true });
  assert.deepEqual(result.edited, ["body"]);
  assert.equal(calls.length, 1);
  assert.throws(() => parseEditPrCliArgs(["--repo", "o/n", "--pr", "1", "--body", "x", "--waiver-writer"]), /Unknown argument/);
});

test("editPr: a title-only edit never reads the body", async () => {
  const { run, calls } = stubGh();
  const result = await editPrRaw(editOpts({ title: "T" }), { run, fetchPrContext: async () => { throw new Error("must not fetch"); } });
  assert.deepEqual(result.edited, ["title"]);
  assert.equal(calls.length, 1);
});

test("parseEditPrCliArgs: --allow-cross-issue flag is wired", () => {
  const opts = parseEditPrCliArgs(["--repo", "o/n", "--pr", "5", "--body", "x", "--allow-cross-issue"]);
  assert.equal(opts.allowCrossIssue, true);
});

test("parseEditPrCliArgs: --allow-cross-issue=false does NOT enable the waiver (no fail-open on the escape hatch)", () => {
  assert.equal(parseEditPrCliArgs(["--repo", "o/n", "--pr", "5", "--body", "x", "--allow-cross-issue=false"]).allowCrossIssue, false);
  assert.equal(parseEditPrCliArgs(["--repo", "o/n", "--pr", "5", "--body", "x", "--allow-cross-issue=0"]).allowCrossIssue, false);
  assert.equal(parseEditPrCliArgs(["--repo", "o/n", "--pr", "5", "--body", "x", "--allow-cross-issue=true"]).allowCrossIssue, true);
});

test("editPr: --allow-cross-issue=false still enforces the mismatch guard (the disable form does not waive)", async () => {
  const { run } = stubGh();
  const fetchPrContext = async () => ({ headRefName: "issue-2092", closingIssuesReferences: [] });
  await assert.rejects(
    () => editPr(editOpts({ body: "Closes #2071", allowCrossIssue: false }), { run, fetchPrContext }),
    /CLOSING-REF-BRANCH-MISMATCH/,
  );
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
      "  { fetchPrContext: async () => ({ headRefName: \"x\", closingIssuesReferences: [], body: \"\" }), run: async (_c, args) => { calls.push(args); return { code: 0, stdout: \"\", stderr: \"\" }; } },\n" +
      ");\n" +
      "process.stdout.write(JSON.stringify(calls[0]));\n",
  );
  const res = spawnSync((Bun.which("node") ?? "node"), [driver], { input: "## Acceptance criteria\n\n- [ ] ac\n", encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  const args = JSON.parse(res.stdout);
  assert.deepEqual(args, ["pr", "edit", "17", "--repo", "o/n", "--body", "## Acceptance criteria\n\n- [ ] ac\n"]);
  assert.ok(!args.includes("--body-file"), "must not re-emit --body-file - under --enforce-grill");
});

test("editPr: a caller-supplied currentBody is the waiver baseline and skips the fetch", async () => {
  const { run, calls } = stubGh();
  const fetchPrContext = async () => { throw new Error("must not fetch"); };
  const result = await editPrRaw(editOpts({ body: `Ticked\n\n${WAIVER}\n` }), { run, fetchPrContext, currentBody: `Unticked\n\n${WAIVER}\n` });
  assert.deepEqual(result.edited, ["body"]);
  assert.equal(calls.length, 1);
  await assert.rejects(
    () => editPrRaw(editOpts({ body: "Ticked\n" }), { run, fetchPrContext, currentBody: `Unticked\n\n${WAIVER}\n` }),
    /dev-loops pr waive-adr-tripwire/,
  );
});

test("editPr: the closing-reference refusal still fails closed when currentBody is supplied and the PR context is null", async () => {
  const { run } = stubGh();
  const fetchPrContext = async () => null;
  await assert.rejects(
    () => editPr(editOpts({ body: "Closes #2071" }), { run, fetchPrContext, currentBody: "" }),
    /CLOSING-REF-BRANCH-MISMATCH.*fail closed/s,
  );
  await assert.rejects(
    () => editPr(editOpts({ body: "Closes #2071" }), { run, fetchPrContext, currentBody: "", waiverWriter: true }),
    /CLOSING-REF-BRANCH-MISMATCH.*fail closed/s,
  );
});
