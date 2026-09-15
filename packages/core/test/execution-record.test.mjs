import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test } from "bun:test";

import {
  EXECUTION_RECORD_SCHEMA_VERSION,
  EXECUTION_UNIT_ROLES,
  TELEMETRY_HARNESS_PROFILES,
  buildExecutionUnitRecord,
  enforceExecutionUnitRecord,
  executionRecordPath,
  validateExecutionUnitRecord,
  writeExecutionUnitRecord,
} from "../src/loop/execution-record.mjs";
import { HARNESS_VALUES } from "../src/loop/role-budget-bound.mjs";

const HEAD_SHA = "a".repeat(40);

function baseInput(overrides = {}) {
  return {
    harness: "claude",
    role: "coordinator_phase",
    identity: { headSha: HEAD_SHA, phase: "draft_gate" },
    promptBytes: 100,
    contextBytes: 200,
    turns: 3,
    toolCalls: 5,
    providerTokens: { input: 100, output: 50, cacheRead: 10 },
    localToolTimeMs: 250,
    childWallTimeMs: 1000,
    waitOwner: null,
    outcome: "ok",
    ...overrides,
  };
}

describe("buildExecutionUnitRecord", () => {
  test("TELEMETRY_HARNESS_PROFILES covers exactly HARNESS_VALUES", () => {
    assert.deepEqual(Object.keys(TELEMETRY_HARNESS_PROFILES).sort(), [...HARNESS_VALUES].sort());
  });

  test("builds a frozen record with measured claude provider tokens", () => {
    const record = buildExecutionUnitRecord(baseInput());
    assert.equal(record.schemaVersion, EXECUTION_RECORD_SCHEMA_VERSION);
    assert.equal(record.harness, "claude");
    assert.equal(record.headSha, HEAD_SHA);
    assert.equal(record.unitId, "draft_gate");
    assert.equal(record.providerTokens.input.available, true);
    assert.equal(record.providerTokens.input.value, 100);
    assert.equal(record.childWallTimeMs.available, true);
    assert.equal(record.hasUnavailableProviderMetric, false);
    assert.throws(() => { record.outcome = "mutated"; });
  });

  test("a genuine local zero (e.g. 0 turns) is a real measured zero, not unavailable", () => {
    const record = buildExecutionUnitRecord(baseInput({ turns: 0 }));
    assert.equal(record.metrics.turns, 0);
  });

  test("null provider tokens on an available-profile harness record unavailable-with-reason, not zero", () => {
    const record = buildExecutionUnitRecord(baseInput({ providerTokens: { input: null, output: null, cacheRead: null } }));
    assert.equal(record.providerTokens.input.available, false);
    assert.equal(record.providerTokens.input.value, null);
    assert.match(record.providerTokens.input.reason, /no value was reported/);
    assert.equal(record.hasUnavailableProviderMetric, true);
  });

  test("null provider tokens on pi/codex (unavailable profile) record the honest unavailable reason", () => {
    for (const harness of ["pi", "codex"]) {
      const record = buildExecutionUnitRecord(baseInput({ harness, providerTokens: { input: null, output: null, cacheRead: null } }));
      assert.equal(record.providerTokens.input.available, false);
      assert.match(record.providerTokens.input.reason, /does not expose provider token usage telemetry/);
    }
  });

  test("FAIL CLOSED: a numeric provider-token value for an unavailable-profile harness (pi/codex) throws", () => {
    for (const harness of ["pi", "codex"]) {
      assert.throws(
        () => buildExecutionUnitRecord(baseInput({ harness, providerTokens: { input: 42, output: null, cacheRead: null } })),
        /does not expose provider token usage telemetry/,
      );
    }
  });

  test("childWallTimeMs is measured-or-unavailable regardless of harness (not gated on providerTokens profile)", () => {
    const record = buildExecutionUnitRecord(baseInput({ harness: "pi", providerTokens: { input: null, output: null, cacheRead: null }, childWallTimeMs: 500 }));
    assert.equal(record.childWallTimeMs.available, true);
    assert.equal(record.childWallTimeMs.value, 500);
  });

  test("null childWallTimeMs records unavailable with an honest reason", () => {
    const record = buildExecutionUnitRecord(baseInput({ childWallTimeMs: null }));
    assert.equal(record.childWallTimeMs.available, false);
    assert.match(record.childWallTimeMs.reason, /child wall time not reported/);
  });

  test("caller-supplied reason overrides the default", () => {
    const record = buildExecutionUnitRecord(baseInput({
      providerTokens: { input: null, output: null, cacheRead: null, reasons: { input: "custom reason for input" } },
    }));
    assert.equal(record.providerTokens.input.reason, "custom reason for input");
  });

  test("rejects an unrecognized harness", () => {
    assert.throws(() => buildExecutionUnitRecord(baseInput({ harness: "gpt" })), TypeError);
  });

  test("rejects an unrecognized role", () => {
    assert.throws(() => buildExecutionUnitRecord(baseInput({ role: "unknown_role" })), TypeError);
  });

  test("rejects a non-hex headSha", () => {
    assert.throws(() => buildExecutionUnitRecord(baseInput({ identity: { headSha: "not-hex" } })), TypeError);
  });

  test("fails closed when identity carries none of unitId/unit/round/phase", () => {
    assert.throws(() => buildExecutionUnitRecord(baseInput({ identity: { headSha: HEAD_SHA } })), TypeError);
  });

  test("derives unitId from round when unitId/unit are absent", () => {
    const record = buildExecutionUnitRecord(baseInput({ role: "judge_round", identity: { headSha: HEAD_SHA, round: 2 } }));
    assert.equal(record.unitId, "2");
  });

  test("rejects a fractional local metric", () => {
    assert.throws(() => buildExecutionUnitRecord(baseInput({ turns: 1.5 })), TypeError);
  });

  test("rejects a negative local metric", () => {
    assert.throws(() => buildExecutionUnitRecord(baseInput({ toolCalls: -1 })), TypeError);
  });

  test("rejects an empty outcome", () => {
    assert.throws(() => buildExecutionUnitRecord(baseInput({ outcome: "" })), TypeError);
  });

  test("every EXECUTION_UNIT_ROLES entry is buildable", () => {
    for (const role of EXECUTION_UNIT_ROLES) {
      const record = buildExecutionUnitRecord(baseInput({ role }));
      assert.equal(record.role, role);
    }
  });
});

describe("validateExecutionUnitRecord / enforceExecutionUnitRecord", () => {
  test("accepts a well-formed record", () => {
    const record = buildExecutionUnitRecord(baseInput());
    const result = validateExecutionUnitRecord({ record });
    assert.equal(result.ok, true, JSON.stringify(result.failures));
    assert.equal(enforceExecutionUnitRecord({ record }), true);
  });

  test("never throws on a missing record", () => {
    const result = validateExecutionUnitRecord({});
    assert.equal(result.ok, false);
  });

  test("HONESTY GATE: a hand-edited record claiming available provider tokens on a pi/codex harness fails closed even though it was never built that way", () => {
    const record = buildExecutionUnitRecord(baseInput({ harness: "claude" }));
    const forged = {
      ...record,
      harness: "pi",
      providerTokens: { ...record.providerTokens, input: { available: true, value: 999, reason: null } },
    };
    const result = validateExecutionUnitRecord({ record: forged });
    assert.equal(result.ok, false);
    assert.ok(result.failures.some((f) => f.check === "providerTokens.input_honesty"));
    assert.throws(() => enforceExecutionUnitRecord({ record: forged }), /GATE-EXEC-EXECUTION-RECORD/);
  });

  test("rejects a forged hasUnavailableProviderMetric that contradicts the re-derived dimensions", () => {
    const record = buildExecutionUnitRecord(baseInput());
    const forged = { ...record, hasUnavailableProviderMetric: true };
    assert.equal(validateExecutionUnitRecord({ record: forged }).ok, false);
  });

  test("rejects a non-null value paired with available:false", () => {
    const record = buildExecutionUnitRecord(baseInput({ harness: "pi", providerTokens: { input: null, output: null, cacheRead: null } }));
    const forged = { ...record, providerTokens: { ...record.providerTokens, input: { available: false, value: 5, reason: "x" } } };
    assert.equal(validateExecutionUnitRecord({ record: forged }).ok, false);
  });
});

describe("executionRecordPath / writeExecutionUnitRecord", () => {
  test("deterministic path", () => {
    const p = executionRecordPath({ dir: "/tmp/x", role: "watch_cycle", headSha: HEAD_SHA, unitId: "run-1" });
    assert.equal(p, `/tmp/x/watch_cycle-run-1-${HEAD_SHA}.execution-record.json`);
  });

  test("rejects a malformed role/headSha/unitId/dir", () => {
    assert.throws(() => executionRecordPath({ dir: "", role: "watch_cycle", headSha: HEAD_SHA, unitId: "u" }));
    assert.throws(() => executionRecordPath({ dir: "/tmp/x", role: "nope", headSha: HEAD_SHA, unitId: "u" }));
    assert.throws(() => executionRecordPath({ dir: "/tmp/x", role: "watch_cycle", headSha: "nope", unitId: "u" }));
    assert.throws(() => executionRecordPath({ dir: "/tmp/x", role: "watch_cycle", headSha: HEAD_SHA, unitId: "" }));
  });

  test("writes a pretty-printed record with a trailing newline to its deterministic path", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "execution-record-"));
    try {
      const record = buildExecutionUnitRecord(baseInput());
      const { path: written } = await writeExecutionUnitRecord({ dir, record });
      assert.equal(written, executionRecordPath({ dir, role: record.role, headSha: record.headSha, unitId: record.unitId }));
      const raw = await readFile(written, "utf8");
      assert.ok(raw.endsWith("\n"));
      assert.deepEqual(JSON.parse(raw), record);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
