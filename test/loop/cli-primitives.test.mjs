import assert from "node:assert/strict";
import test from "node:test";

import { buildParseError } from "../../scripts/_core-helpers.mjs";
import {
  parseCliTokens,
  parseIssueNumber,
  parseNonNegativeInteger,
  parsePositiveInteger,
  parsePrNumber,
  requireOptionValue,
  requireTokenValue,
  runChild,
  runCommand,
} from "../../scripts/_cli-primitives.mjs";

test("buildParseError attaches usage to returned errors", () => {
  const parseError = buildParseError("usage text");
  const error = parseError("bad flag");

  assert.equal(error.message, "bad flag");
  assert.equal(error.usage, "usage text");
});

test("requireOptionValue returns next value", () => {
  const args = ["abc"];
  assert.equal(requireOptionValue(args, "--repo"), "abc");
});

test("requireOptionValue uses provided parseError", () => {
  assert.throws(
    () => requireOptionValue([], "--repo", (message) => Object.assign(new Error(message), { usage: "usage" })),
    (error) => error.message === "Missing value for --repo" && error.usage === "usage",
  );
});

// ── requireTokenValue / parseCliTokens (node:util.parseArgs adapters, #808) ──

test("requireTokenValue returns the token value", () => {
  assert.equal(requireTokenValue({ rawName: "--repo", value: "owner/name" }), "owner/name");
});

test("requireTokenValue rejects a missing value with the legacy message", () => {
  assert.throws(
    () => requireTokenValue({ rawName: "--repo", value: undefined }, (m) => Object.assign(new Error(m), { usage: "u" })),
    (error) => error.message === "Missing value for --repo" && error.usage === "u",
  );
});

test("requireTokenValue rejects an empty value", () => {
  assert.throws(
    () => requireTokenValue({ rawName: "--repo", value: "" }),
    (error) => error.message === "Missing value for --repo",
  );
});

test("requireTokenValue rejects a flag-like value (default --flagPattern)", () => {
  assert.throws(
    () => requireTokenValue({ rawName: "--repo", value: "--pr" }),
    (error) => error.message === "Missing value for --repo",
  );
});

test("requireTokenValue accepts a single-dash value under the default pattern but rejects it under /^-/", () => {
  // Default /^--/ only rejects double-dash values, so a single-dash value passes.
  assert.equal(requireTokenValue({ rawName: "--branch", value: "-x" }), "-x");
  // A stricter /^-/ pattern rejects it (the short-flag-like case).
  assert.throws(
    () => requireTokenValue({ rawName: "--branch", value: "-x" }, null, { flagPattern: /^-/u }),
    (error) => error.message === "Missing value for --branch",
  );
});

test("parseCliTokens collects option values and rejects unknown flags / positionals", () => {
  const options = { repo: { type: "string" }, json: { type: "boolean" } };
  const { values, positionals } = parseCliTokens(["--repo", "owner/name", "--json"], options);
  assert.equal(values.get("repo"), "owner/name");
  assert.equal(values.get("json"), true);
  assert.deepEqual(positionals, []);

  assert.throws(() => parseCliTokens(["--bogus"], options), (e) => e.message === "Unknown argument: --bogus");
  assert.throws(() => parseCliTokens(["extra"], options), (e) => e.message === "Unknown argument: extra");
});

test("parseCliTokens sets a bare boolean flag true but honors an explicit =false", () => {
  const options = { json: { type: "boolean" } };
  assert.equal(parseCliTokens(["--json"], options).values.get("json"), true);
  assert.equal(parseCliTokens(["--json=false"], options).values.get("json"), false);
  assert.equal(parseCliTokens(["--json=true"], options).values.get("json"), true);
});

test("parseCliTokens keeps positionals when allowed and rejects flag-like option values", () => {
  const options = { repo: { type: "string" } };
  const { positionals } = parseCliTokens(["cmd"], options, null, { allowPositionals: true });
  assert.deepEqual(positionals, ["cmd"]);
  assert.throws(
    () => parseCliTokens(["--repo", "--json"], options),
    (e) => e.message === "Missing value for --repo",
  );
});

test("requireOptionValue can reject short flag-like values when configured", () => {
  const parseError = buildParseError("usage");
  assert.throws(
    () => requireOptionValue(["-h"], "--branch", parseError, { flagPattern: /^-/u }),
    (error) => error.message === "Missing value for --branch" && error.usage === "usage",
  );
});

test("parsePositiveInteger validates positive integers with custom error", () => {
  assert.throws(
    () => parsePositiveInteger("0", "--limit", (message) => Object.assign(new Error(message), { usage: "usage" })),
    (error) => error.message === "--limit must be a positive integer" && error.usage === "usage",
  );
  assert.equal(parsePositiveInteger("7", "--limit"), 7);
});

test("parseNonNegativeInteger accepts zero and rejects invalid values", () => {
  assert.equal(parseNonNegativeInteger("0", "--timeout-ms"), 0);
  assert.throws(
    () => parseNonNegativeInteger("abc", "--timeout-ms", (message) => Object.assign(new Error(message), { usage: "usage" })),
    (error) => error.message === "--timeout-ms must be a non-negative integer" && error.usage === "usage",
  );
});

test("parseIssueNumber validates issue numbers with custom error", () => {
  assert.throws(
    () => parseIssueNumber("0", (message) => Object.assign(new Error(message), { usage: "usage" })),
    (error) => error.message === "--issue must be a positive integer" && error.usage === "usage",
  );
  assert.equal(parseIssueNumber("42"), 42);
});

test("parsePrNumber validates positive integer with custom error", () => {
  assert.throws(
    () => parsePrNumber("0", (message) => Object.assign(new Error(message), { usage: "usage" })),
    (error) => error.message === "--pr must be a positive integer" && error.usage === "usage",
  );
});

test("runChild captures stdout and stderr", async () => {
  const result = await runChild(
    process.execPath,
    ["-e", "process.stdout.write('ok'); process.stderr.write('warn');"],
    process.env,
  );

  assert.equal(result.code, 0);
  assert.equal(result.stdout, "ok");
  assert.equal(result.stderr, "warn");
});

test("runCommand resolves stdout/stderr with cwd and env", async () => {
  const result = await runCommand(
    process.execPath,
    [
      "-e",
      "process.stdout.write(process.cwd()); process.stderr.write(process.env.TEST_TOKEN);",
    ],
    { cwd: process.cwd(), env: { ...process.env, TEST_TOKEN: "seen" } },
  );

  assert.equal(result.stdout, process.cwd());
  assert.equal(result.stderr, "seen");
});

test("runCommand rejects with stderr detail on non-zero exit", async () => {
  await assert.rejects(
    () => runCommand(process.execPath, ["-e", "process.stderr.write('boom'); process.exit(4);"]),
    /boom/,
  );
});
