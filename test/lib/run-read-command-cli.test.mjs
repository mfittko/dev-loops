// Authoritative test for the shared GitHub read-command execution shell
// (issue #2037). view-issue/view-pr/list-issues delegate their entire runCli to
// runReadCommandCli; this covers the shell's behavior once — parse/help,
// success + filtering, runtime failure, invalid-filter refusal, and the
// parse-error-vs-runtime-error distinction — so the per-command tests do not
// repeat the same matrix three times. Command-specific parser/payload/wiring
// behavior stays in each command's own test.

import assert from "node:assert/strict";
import { test } from "bun:test";

import { runReadCommandCli } from "../../scripts/lib/jq-output.mjs";
import { captureStream } from "../_helpers.mjs";

const USAGE = "Usage: fake-command --flag <v>";

// A minimal parser mirroring the migrated commands' options shape: it produces
// { help, jq, silent } plus a marker the operation echoes back. A thrown parse
// error carries the usage/retry hint via the same buildParseError seam the real
// commands use; here we simulate that with an Error whose message the canonical
// formatCliError renders.
function makeParse({ help = false, jq, silent = false, throwOn } = {}) {
  return (argv) => {
    if (throwOn && argv.includes(throwOn)) {
      // buildParseError attaches `usage`; formatCliError turns that into the
      // `hint: "run with --help for usage"` retry hint (the parse-error signal).
      const error = new Error("bad argument");
      error.usage = USAGE;
      throw error;
    }
    return { help, jq, silent, marker: argv[0] ?? null };
  };
}

test("help precedence: prints usage and returns 0 before any operation runs", async () => {
  const stdout = captureStream();
  let operated = false;
  const code = await runReadCommandCli(
    { parse: makeParse({ help: true }), operate: async () => { operated = true; return { ok: true }; }, usage: USAGE },
    [],
    { stdout },
  );
  assert.equal(code, 0);
  assert.equal(stdout.get(), `${USAGE}\n`);
  assert.equal(operated, false);
});

test("success: threads env/ghCommand/run into the operation and emits the verbatim result", async () => {
  const stdout = captureStream();
  const seen = {};
  const code = await runReadCommandCli(
    {
      parse: makeParse(),
      operate: async (options, ctx) => { Object.assign(seen, { options, ctx }); return { ok: true, value: 42 }; },
      usage: USAGE,
    },
    ["hello"],
    { stdout, env: { A: "1" }, ghCommand: "gh-x", run: "RUN" },
  );
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout.get().trim()), { ok: true, value: 42 });
  assert.equal(seen.options.marker, "hello");
  assert.deepEqual(seen.ctx, { env: { A: "1" }, ghCommand: "gh-x", run: "RUN" });
});

test("--jq filters the result and exits 0", async () => {
  const stdout = captureStream();
  const code = await runReadCommandCli(
    { parse: makeParse({ jq: ".value" }), operate: async () => ({ ok: true, value: 7 }), usage: USAGE },
    [],
    { stdout },
  );
  assert.equal(code, 0);
  assert.equal(stdout.get().trim(), "7");
});

test("--silent + --jq predicate maps to exit code only, no stdout", async () => {
  const stdout = captureStream();
  const code = await runReadCommandCli(
    { parse: makeParse({ jq: ".ok", silent: true }), operate: async () => ({ ok: true }), usage: USAGE },
    [],
    { stdout },
  );
  assert.equal(code, 0);
  assert.equal(stdout.get(), "");
});

test("invalid --jq filter fails closed with exit 2 and a stderr envelope", async () => {
  const stdout = captureStream();
  const stderr = captureStream();
  const code = await runReadCommandCli(
    { parse: makeParse({ jq: "bogus!!" }), operate: async () => ({ ok: true }), usage: USAGE },
    [],
    { stdout, stderr },
  );
  assert.equal(code, 2);
  assert.equal(stdout.get(), "");
  assert.match(stderr.get(), /--jq/);
});

test("runtime/operation error: plain {ok:false,error} envelope, exit 1, no usage/retry hint", async () => {
  const stdout = captureStream();
  const stderr = captureStream();
  const code = await runReadCommandCli(
    { parse: makeParse(), operate: async () => { throw new Error("gh pr view failed: nope"); }, usage: USAGE },
    [],
    { stdout, stderr },
  );
  assert.equal(code, 1);
  assert.equal(stdout.get(), "");
  const envelope = JSON.parse(stderr.get().trim());
  // Exact shape: no `hint` field. A runtime failure must NOT carry the
  // parse-error retry hint — otherwise the top-level launcher could mistake it
  // for a retryable parse error.
  assert.deepEqual(envelope, { ok: false, error: "gh pr view failed: nope" });
});

test("parse error: routes through formatCliError (carries the usage/retry hint), exit 1, distinct from runtime path", async () => {
  const stdout = captureStream();
  const stderr = captureStream();
  let operated = false;
  const code = await runReadCommandCli(
    { parse: makeParse({ throwOn: "--boom" }), operate: async () => { operated = true; return { ok: true }; }, usage: USAGE },
    ["--boom"],
    { stdout, stderr },
  );
  assert.equal(code, 1);
  assert.equal(operated, false, "operation must not run when parsing fails");
  const envelope = JSON.parse(stderr.get().trim());
  // Parse errors carry the retry hint; runtime errors do not. This is the
  // distinction the shell must preserve.
  assert.deepEqual(envelope, { ok: false, error: "bad argument", hint: "run with --help for usage" });
});
