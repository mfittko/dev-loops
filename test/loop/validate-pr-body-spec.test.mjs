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

const COMPLETE_BODY = `## Objective
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
