import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import test from "node:test";

import {
  tickVerifiedCheckboxes,
  parseTickVerifiedCliArgs,
  runCli,
} from "../../scripts/github/tick-verified-checkboxes.mjs";

function stubGh(responses) {
  const calls = [];
  const run = async (_cmd, args) => {
    calls.push(args);
    const resp = responses.shift();
    if (!resp) throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    return { code: resp.code ?? 0, stdout: resp.stdout ?? "", stderr: resp.stderr ?? "" };
  };
  return { run, calls };
}

function captureStream() {
  let data = "";
  return { write: (s) => { data += s; }, get: () => data };
}

function bodyJson(body) {
  return { stdout: `${JSON.stringify({ body })}\n` };
}

// --- pure function ---

test("tickVerifiedCheckboxes: flips only exact-matched unchecked items", () => {
  const body = "- [ ] Alpha\n- [ ] Beta\n";
  const out = tickVerifiedCheckboxes(body, ["Alpha"]);
  assert.equal(out.body, "- [x] Alpha\n- [ ] Beta\n");
  assert.deepEqual(out.flipped, ["Alpha"]);
});

test("tickVerifiedCheckboxes: leaves other unchecked items untouched", () => {
  const body = "- [ ] Alpha\n- [ ] Beta\n";
  const out = tickVerifiedCheckboxes(body, ["Alpha"]);
  assert.match(out.body, /- \[ \] Beta/);
});

test("tickVerifiedCheckboxes: never blanket-checks unverified labels", () => {
  const body = "- [ ] Alpha\n- [ ] Beta\n";
  const out = tickVerifiedCheckboxes(body, ["Gamma"]);
  assert.equal(out.body, body);
  assert.deepEqual(out.flipped, []);
  assert.deepEqual(out.unmatched, ["Gamma"]);
});

test("tickVerifiedCheckboxes: partial label match does not flip", () => {
  const body = "- [ ] Alpha criterion one\n";
  const out = tickVerifiedCheckboxes(body, ["Alpha"]);
  assert.equal(out.body, body);
  assert.deepEqual(out.flipped, []);
});

test("tickVerifiedCheckboxes: never unchecks an already-checked item", () => {
  const body = "- [x] Alpha\n";
  const out = tickVerifiedCheckboxes(body, ["Beta"]);
  assert.equal(out.body, body);
});

test("tickVerifiedCheckboxes: idempotent — already-[x] verified label is not in flipped nor unmatched", () => {
  const body = "- [x] Alpha\n";
  const out = tickVerifiedCheckboxes(body, ["Alpha"]);
  assert.equal(out.body, body);
  assert.deepEqual(out.flipped, []);
  assert.deepEqual(out.unmatched, []);
});

test("tickVerifiedCheckboxes: reports absent verified labels as unmatched", () => {
  const body = "- [ ] Alpha\n";
  const out = tickVerifiedCheckboxes(body, ["Alpha", "Missing"]);
  assert.deepEqual(out.flipped, ["Alpha"]);
  assert.deepEqual(out.unmatched, ["Missing"]);
});

test("tickVerifiedCheckboxes: preserves indentation and */+ bullets", () => {
  const body = "  * [ ] Alpha\n    + [ ] Beta\n";
  const out = tickVerifiedCheckboxes(body, ["Alpha", "Beta"]);
  assert.equal(out.body, "  * [x] Alpha\n    + [x] Beta\n");
});

test("tickVerifiedCheckboxes: tolerates uppercase [X] as already-checked", () => {
  const body = "- [X] Alpha\n";
  const out = tickVerifiedCheckboxes(body, ["Alpha"]);
  assert.equal(out.body, body);
  assert.deepEqual(out.flipped, []);
});

test("tickVerifiedCheckboxes: does not mutate non-checkbox text", () => {
  const body = "# Heading\nSome prose with [ ] not a checkbox.\n- regular bullet\n- [ ] Alpha\n";
  const out = tickVerifiedCheckboxes(body, ["Alpha"]);
  assert.equal(out.body, "# Heading\nSome prose with [ ] not a checkbox.\n- regular bullet\n- [x] Alpha\n");
});

test("tickVerifiedCheckboxes: matches label ignoring surrounding whitespace on the line", () => {
  const body = "- [ ]   Alpha  \n";
  const out = tickVerifiedCheckboxes(body, ["Alpha"]);
  assert.deepEqual(out.flipped, ["Alpha"]);
});

test("tickVerifiedCheckboxes: preserves CRLF line endings when flipping", () => {
  const body = "- [ ] Alpha\r\n- [ ] Beta\r\n";
  const out = tickVerifiedCheckboxes(body, ["Alpha"]);
  assert.deepEqual(out.flipped, ["Alpha"]);
  assert.ok(out.body.includes("- [x] Alpha\r\n"), `expected CRLF-preserved flip, got: ${JSON.stringify(out.body)}`);
  assert.ok(out.body.includes("- [ ] Beta\r\n"), "Beta should be untouched with its CRLF intact");
});

test("tickVerifiedCheckboxes: duplicate identical labels flip every line but report once", () => {
  const body = "- [ ] Alpha\n- [ ] Alpha\n";
  const out = tickVerifiedCheckboxes(body, ["Alpha"]);
  assert.equal(out.body, "- [x] Alpha\n- [x] Alpha\n");
  assert.deepEqual(out.flipped, ["Alpha"]);
});

// --- CLI parse ---

test("parseTickVerifiedCliArgs: requires --repo and --pr", () => {
  assert.throws(() => parseTickVerifiedCliArgs(["--verified", "Alpha"]), /requires both --repo/);
  assert.throws(() => parseTickVerifiedCliArgs(["--repo", "o/n", "--verified", "Alpha"]), /requires both --repo/);
});

test("parseTickVerifiedCliArgs: requires at least one --verified", () => {
  assert.throws(() => parseTickVerifiedCliArgs(["--repo", "o/n", "--pr", "1"]), /at least one --verified is required/);
});

test("parseTickVerifiedCliArgs: collects repeated --verified labels", () => {
  const out = parseTickVerifiedCliArgs(["--repo", "o/n", "--pr", "1", "--verified", "Alpha", "--verified", "Beta"]);
  assert.deepEqual(out.verified, ["Alpha", "Beta"]);
  assert.equal(out.dryRun, false);
});

test("parseTickVerifiedCliArgs: rejects empty and whitespace-only --verified labels", () => {
  // Empty string is rejected upstream by requireTokenValue ("Missing value");
  // whitespace-only survives that check and is caught by the non-empty guard.
  assert.throws(
    () => parseTickVerifiedCliArgs(["--repo", "o/n", "--pr", "1", "--verified", ""]),
    /must be a non-empty label|Missing value for --verified/,
  );
  assert.throws(
    () => parseTickVerifiedCliArgs(["--repo", "o/n", "--pr", "1", "--verified", "   "]),
    /must be a non-empty label/,
  );
});

// --- CLI flow (stubbed gh) ---

test("runCli: fetches body then issues one gh pr edit with the flipped body", async () => {
  const { run, calls } = stubGh([
    bodyJson("- [ ] Alpha\n- [ ] Beta\n"),
    { stdout: "https://github.com/o/n/pull/17\n" },
  ]);
  // Capture the body-file content at edit time; the temp file is removed once tickCheckboxes returns.
  let editedBody;
  const runCapturing = async (cmd, args, env) => {
    if (args[1] === "edit") {
      const idx = args.indexOf("--body-file");
      editedBody = readFileSync(args[idx + 1], "utf8");
    }
    return run(cmd, args, env);
  };
  const stdout = captureStream();
  const code = await runCli(["--repo", "o/n", "--pr", "17", "--verified", "Alpha"], { run: runCapturing, stdout });
  assert.equal(code, 0);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], ["pr", "view", "17", "--repo", "o/n", "--json", "body"]);
  assert.equal(calls[1][0], "pr");
  assert.equal(calls[1][1], "edit");
  const bodyFileIdx = calls[1].indexOf("--body-file");
  assert.notEqual(bodyFileIdx, -1);
  assert.equal(editedBody, "- [x] Alpha\n- [ ] Beta\n");
  assert.match(stdout.get(), /"edited":true/);
});

test("runCli: removes the temp dir after a successful flip flow", async () => {
  const { run, calls } = stubGh([
    bodyJson("- [ ] Alpha\n"),
    { stdout: "https://github.com/o/n/pull/17\n" },
  ]);
  const code = await runCli(["--repo", "o/n", "--pr", "17", "--verified", "Alpha"], { run, stdout: captureStream() });
  assert.equal(code, 0);
  const bodyFileIdx = calls[1].indexOf("--body-file");
  const dir = dirname(calls[1][bodyFileIdx + 1]);
  assert.equal(existsSync(dir), false, "temp dir should be cleaned up after edit");
});

test("runCli: no gh pr edit when nothing flips", async () => {
  const { run, calls } = stubGh([bodyJson("- [ ] Alpha\n")]);
  const stdout = captureStream();
  const code = await runCli(["--repo", "o/n", "--pr", "17", "--verified", "Missing"], { run, stdout });
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.match(stdout.get(), /"edited":false/);
  assert.match(stdout.get(), /"unmatched":\["Missing"\]/);
});

test("runCli: --dry-run never edits even when items would flip", async () => {
  const { run, calls } = stubGh([bodyJson("- [ ] Alpha\n")]);
  const stdout = captureStream();
  const code = await runCli(["--repo", "o/n", "--pr", "17", "--verified", "Alpha", "--dry-run"], { run, stdout });
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.match(stdout.get(), /"flipped":\["Alpha"\]/);
  assert.match(stdout.get(), /"edited":false/);
});

test("runCli: parse error exits 1 with stderr JSON", async () => {
  const stderr = captureStream();
  const code = await runCli(["--repo", "o/n", "--pr", "17"], { run: async () => {}, stderr, stdout: captureStream() });
  assert.equal(code, 1);
  assert.match(stderr.get(), /at least one --verified is required/);
});

test("runCli: gh pr view failure returns exit 1", async () => {
  const { run } = stubGh([{ code: 1, stderr: "no such PR" }]);
  const stderr = captureStream();
  const code = await runCli(["--repo", "o/n", "--pr", "17", "--verified", "Alpha"], { run, stderr, stdout: captureStream() });
  assert.equal(code, 1);
  assert.match(stderr.get(), /gh pr view failed: no such PR/);
});

test("runCli: gh pr edit failure returns exit 1 with stderr JSON", async () => {
  const { run } = stubGh([
    bodyJson("- [ ] Alpha\n"),
    { code: 1, stderr: "permission denied" },
  ]);
  const stderr = captureStream();
  const code = await runCli(["--repo", "o/n", "--pr", "17", "--verified", "Alpha"], { run, stderr, stdout: captureStream() });
  assert.equal(code, 1);
  assert.match(stderr.get(), /gh pr edit failed/);
});

test("runCli: --silent maps success to exit 0 with no stdout", async () => {
  const { run } = stubGh([bodyJson("- [ ] Alpha\n"), { stdout: "url\n" }]);
  const stdout = captureStream();
  const code = await runCli(["--repo", "o/n", "--pr", "17", "--verified", "Alpha", "--silent"], { run, stdout });
  assert.equal(code, 0);
  assert.equal(stdout.get(), "");
});
