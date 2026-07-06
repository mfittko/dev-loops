import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  parseValidatePrBodySpecCliArgs,
  validatePrBodySpecFromOptions,
  runCli,
} from "../../scripts/loop/validate-pr-body-spec.mjs";

const COMPLETE_BODY = `Closes #123

## Objective
Because reasons.

## In scope
- a

## Explicit non-goals
- b

## Acceptance criteria
- [ ] works

## Definition of done
- [ ] tested

## Risks
- none
`;

test("parseValidatePrBodySpecCliArgs parses --input", () => {
  const opts = parseValidatePrBodySpecCliArgs(["--input", "/tmp/x.json"]);
  assert.equal(opts.input, "/tmp/x.json");
});

test("parseValidatePrBodySpecCliArgs parses --repo and --pr", () => {
  const opts = parseValidatePrBodySpecCliArgs(["--repo", "owner/name", "--pr", "7"]);
  assert.equal(opts.repo, "owner/name");
  assert.equal(opts.pr, 7);
});

test("parseValidatePrBodySpecCliArgs rejects both --input and remote args", () => {
  assert.throws(
    () => parseValidatePrBodySpecCliArgs(["--input", "/tmp/x.json", "--repo", "owner/name", "--pr", "7"]),
    /exactly one/i,
  );
});

test("parseValidatePrBodySpecCliArgs rejects a zero --pr", () => {
  assert.throws(() => parseValidatePrBodySpecCliArgs(["--repo", "owner/name", "--pr", "0"]), /positive/i);
});

test("parseValidatePrBodySpecCliArgs parses --expected-issue", () => {
  const opts = parseValidatePrBodySpecCliArgs(["--repo", "owner/name", "--pr", "7", "--expected-issue", "123"]);
  assert.equal(opts.expectedIssue, 123);
});

test("parseValidatePrBodySpecCliArgs rejects a zero --expected-issue", () => {
  assert.throws(
    () => parseValidatePrBodySpecCliArgs(["--repo", "owner/name", "--pr", "7", "--expected-issue", "0"]),
    /positive/i,
  );
});

test("parseValidatePrBodySpecCliArgs rejects a non-numeric --expected-issue", () => {
  assert.throws(
    () => parseValidatePrBodySpecCliArgs(["--repo", "owner/name", "--pr", "7", "--expected-issue", "abc"]),
    /positive/i,
  );
});

test("parseValidatePrBodySpecCliArgs rejects --input combined with a stray --repo (no --pr)", () => {
  assert.throws(
    () => parseValidatePrBodySpecCliArgs(["--input", "/tmp/x.json", "--repo", "owner/name"]),
    /mutually exclusive/i,
  );
});

test("validatePrBodySpecFromOptions --input: complete body is ok", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pr-body-spec-"));
  try {
    const p = path.join(dir, "complete.json");
    await writeFile(p, JSON.stringify({ repo: "owner/name", pr: 7, body: COMPLETE_BODY }), "utf8");
    const result = await validatePrBodySpecFromOptions({ input: p });
    assert.equal(result.ok, true);
    assert.equal(result.repo, "owner/name");
    assert.equal(result.pr, 7);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runCli --input fails closed (exit 1) when the body is missing the DoD", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pr-body-spec-"));
  try {
    const body = COMPLETE_BODY.replace(/## Definition of done[\s\S]*?(?=## Risks)/u, "");
    const p = path.join(dir, "nodod.json");
    await writeFile(p, JSON.stringify({ body }), "utf8");
    let out = "";
    let err = "";
    const code = await runCli(["--input", p], {
      stdout: { write: (s) => { out += s; } },
      stderr: { write: (s) => { err += s; } },
    });
    assert.equal(code, 1);
    const parsed = JSON.parse(out);
    assert.equal(parsed.ok, false);
    assert.ok(parsed.errors.some((e) => e.code === "missing_definition_of_done"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runCli --input fails closed (exit 1) when the body has no Closes/Fixes/Resolves reference", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pr-body-spec-"));
  try {
    const body = COMPLETE_BODY.replace("Closes #123\n\n", "");
    const p = path.join(dir, "noclosing.json");
    await writeFile(p, JSON.stringify({ body }), "utf8");
    let out = "";
    const code = await runCli(["--input", p], {
      stdout: { write: (s) => { out += s; } },
      stderr: { write: () => {} },
    });
    assert.equal(code, 1);
    const parsed = JSON.parse(out);
    assert.equal(parsed.ok, false);
    assert.ok(parsed.errors.some((e) => e.code === "missing_closing_issue_reference"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runCli --input --expected-issue matching the Closes reference exits 0", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pr-body-spec-"));
  try {
    const p = path.join(dir, "complete.json");
    await writeFile(p, JSON.stringify({ body: COMPLETE_BODY }), "utf8");
    let out = "";
    const code = await runCli(["--input", p, "--expected-issue", "123"], {
      stdout: { write: (s) => { out += s; } },
      stderr: { write: () => {} },
    });
    assert.equal(code, 0);
    const parsed = JSON.parse(out);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.closesIssues, [123]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runCli --input --expected-issue mismatched with the Closes reference fails closed with closes_wrong_issue", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pr-body-spec-"));
  try {
    const p = path.join(dir, "complete.json");
    await writeFile(p, JSON.stringify({ body: COMPLETE_BODY }), "utf8");
    let out = "";
    const code = await runCli(["--input", p, "--expected-issue", "456"], {
      stdout: { write: (s) => { out += s; } },
      stderr: { write: () => {} },
    });
    assert.equal(code, 1);
    const parsed = JSON.parse(out);
    assert.equal(parsed.ok, false);
    assert.ok(parsed.errors.some((e) => e.code === "closes_wrong_issue"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parseValidatePrBodySpecCliArgs parses --no-issue", () => {
  const opts = parseValidatePrBodySpecCliArgs(["--repo", "owner/name", "--pr", "7", "--no-issue"]);
  assert.equal(opts.noIssue, true);
});

test("parseValidatePrBodySpecCliArgs rejects --no-issue combined with --expected-issue", () => {
  assert.throws(
    () => parseValidatePrBodySpecCliArgs(["--repo", "owner/name", "--pr", "7", "--no-issue", "--expected-issue", "123"]),
    /mutually exclusive/i,
  );
});

test("runCli --input --no-issue: a spec-complete body with NO Closes reference exits 0 (AC1)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pr-body-spec-"));
  try {
    const body = COMPLETE_BODY.replace("Closes #123\n\n", "");
    const p = path.join(dir, "issueless.json");
    await writeFile(p, JSON.stringify({ body }), "utf8");
    let out = "";
    const code = await runCli(["--input", p, "--no-issue"], {
      stdout: { write: (s) => { out += s; } },
      stderr: { write: () => {} },
    });
    assert.equal(code, 0);
    const parsed = JSON.parse(out);
    assert.equal(parsed.ok, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runCli --input --no-issue: a Closes reference present fails closed with unexpected_closing_issue_reference", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pr-body-spec-"));
  try {
    const p = path.join(dir, "issueless-with-closes.json");
    await writeFile(p, JSON.stringify({ body: COMPLETE_BODY }), "utf8");
    let out = "";
    const code = await runCli(["--input", p, "--no-issue"], {
      stdout: { write: (s) => { out += s; } },
      stderr: { write: () => {} },
    });
    assert.equal(code, 1);
    const parsed = JSON.parse(out);
    assert.equal(parsed.ok, false);
    assert.ok(parsed.errors.some((e) => e.code === "unexpected_closing_issue_reference"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runCli --input exits 0 for a complete body", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pr-body-spec-"));
  try {
    const p = path.join(dir, "complete.json");
    await writeFile(p, JSON.stringify({ body: COMPLETE_BODY }), "utf8");
    let out = "";
    const code = await runCli(["--input", p], {
      stdout: { write: (s) => { out += s; } },
      stderr: { write: () => {} },
    });
    assert.equal(code, 0);
    assert.equal(JSON.parse(out).ok, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
