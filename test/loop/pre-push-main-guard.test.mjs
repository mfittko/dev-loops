import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";

import { parsePrePushGuardCliArgs, runCli } from "../../scripts/loop/pre-push-main-guard.mjs";

test("parsePrePushGuardCliArgs rejects unknown args", () => {
  assert.throws(() => parsePrePushGuardCliArgs(["--unknown"]), /Unknown argument/i);
});

test("parsePrePushGuardCliArgs accepts --help", () => {
  const result = parsePrePushGuardCliArgs(["--help"]);
  assert.equal(result.help, true);
});

test("parsePrePushGuardCliArgs accepts -h", () => {
  const result = parsePrePushGuardCliArgs(["-h"]);
  assert.equal(result.help, true);
});

test("runCli --help returns ok with help flag", async () => {
  const stdout = { write: () => {} };
  const stderr = { write: () => {} };
  let output = "";
  const fakeStdout = { write: (s) => { output += s; } };
  const result = await runCli(["--help"], { stdout: fakeStdout, stderr, stdin: new PassThrough() });
  assert.ok(result.ok);
  assert.ok(result.help);
  assert.ok(output.includes("Usage:"));
});

test("runCli allows non-main push target", async () => {
  const stdin = new PassThrough();
  stdin.end("refs/heads/feature-603 abc refs/heads/feature-603 def\n");
  const stdout = { write: () => {} };
  const stderr = { write: () => {} };
  let output = "";
  const fakeStdout = { write: (s) => { output += s; } };
  const result = await runCli([], { stdout: fakeStdout, stderr, stdin });
  assert.ok(result.ok);
  assert.equal(result.blocked, false);
  assert.equal(result.refsChecked, 1);
});

test("runCli blocks push to refs/heads/main", async () => {
  const stdin = new PassThrough();
  stdin.end("refs/heads/main abc refs/heads/main def\n");
  const stdout = { write: () => {} };
  const stderr = { write: () => {} };
  let stderrOutput = "";
  const fakeStderr = { write: (s) => { stderrOutput += s; } };
  const result = await runCli([], { stdout, stderr: fakeStderr, stdin });
  assert.equal(result.ok, false);
  assert.equal(result.error, "direct_push_to_main_blocked");
  assert.equal(result.blockedRef, "refs/heads/main");
});

test("runCli bypasses with DEVLOOPS_PREPUSH_BYPASS=1", async () => {
  const stdin = new PassThrough();
  stdin.end("refs/heads/main abc refs/heads/main def\n");
  const stdout = { write: () => {} };
  const stderr = { write: () => {} };
  const env = { DEVLOOPS_PREPUSH_BYPASS: "1" };
  let output = "";
  const fakeStdout = { write: (s) => { output += s; } };
  const result = await runCli([], { stdout: fakeStdout, stderr, stdin, env });
  assert.ok(result.ok);
  assert.equal(result.bypassed, true);
});

test("runCli handles empty stdin gracefully", async () => {
  const stdin = new PassThrough();
  stdin.end("");
  const stdout = { write: () => {} };
  const stderr = { write: () => {} };
  let output = "";
  const fakeStdout = { write: (s) => { output += s; } };
  const result = await runCli([], { stdout: fakeStdout, stderr, stdin });
  assert.ok(result.ok);
  assert.equal(result.blocked, false);
  assert.equal(result.refsChecked, 0);
});

test("runCli blocks push when multiple refs include main", async () => {
  const stdin = new PassThrough();
  stdin.end("refs/heads/feature x refs/heads/feature y\nrefs/heads/main a refs/heads/main b\n");
  const stdout = { write: () => {} };
  const stderr = { write: () => {} };
  let stderrOutput = "";
  const fakeStderr = { write: (s) => { stderrOutput += s; } };
  const result = await runCli([], { stdout, stderr: fakeStderr, stdin });
  assert.equal(result.ok, false);
  assert.equal(result.error, "direct_push_to_main_blocked");
});

test("runCli handles tab-separated pre-push input", async () => {
  const stdin = new PassThrough();
  // Git hook protocol is whitespace-delimited; tabs are valid separators.
  stdin.end("refs/heads/main\tabc123\trefs/heads/main\tdef456\n");
  const stdout = { write: () => {} };
  const stderr = { write: () => {} };
  let stderrOutput = "";
  const fakeStderr = { write: (s) => { stderrOutput += s; } };
  const result = await runCli([], { stdout, stderr: fakeStderr, stdin });
  assert.equal(result.ok, false);
  assert.equal(result.error, "direct_push_to_main_blocked");
  assert.equal(result.blockedRef, "refs/heads/main");
});

test("runCli handles multiple-space-separated pre-push input", async () => {
  const stdin = new PassThrough();
  stdin.end("refs/heads/main   abc123   refs/heads/main   def456\n");
  const stdout = { write: () => {} };
  const stderr = { write: () => {} };
  const result = await runCli([], { stdout, stderr, stdin });
  assert.equal(result.ok, false);
  assert.equal(result.error, "direct_push_to_main_blocked");
});
