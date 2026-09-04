import assert from "node:assert/strict";
import { describe, test } from "bun:test";

import { clusterSignals, clusterSignalsEnriched } from "../src/debt/cluster.mjs";

// Helper: create a synthetic signal
function sig(id, opts = {}) {
  return {
    id,
    sourceType: "pr_review_deep_persona",
    signalKind: opts.signalKind || "file_size",
    location: opts.location || {},
    severityHint: opts.severityHint || "medium",
    timestamp: "2024-06-03T12:00:00Z",
    confidence: opts.confidence ?? 1,
  };
}

const uuid = (n) => `00000000-0000-4000-a000-${String(n).padStart(12, "0")}`;

describe("debt-cluster", () => {
  describe("file clustering (pass 1)", () => {
    test("signals sharing same filePath form a cluster", () => {
      const signals = [
        sig(uuid(1), { location: { filePath: "src/a.mjs" }, signalKind: "file_size" }),
        sig(uuid(2), { location: { filePath: "src/a.mjs" }, signalKind: "spaghetti_branching" }),
      ];
      const findings = clusterSignals(signals);
      assert.equal(findings.length, 1);
      assert.equal(findings[0].signalIds.length, 2);
      assert.ok(findings[0].title.startsWith("file:"));
    });

    test("signals on different files stay separate when no other dimension matches", () => {
      const signals = [
        sig(uuid(1), { location: { filePath: "src/auth/a.mjs" }, signalKind: "file_size" }),
        sig(uuid(2), { location: { filePath: "scripts/b.mjs" }, signalKind: "thin_wrapper" }),
      ];
      const findings = clusterSignals(signals);
      assert.equal(findings.length, 2);
      for (const f of findings) {
        assert.equal(f.signalIds.length, 1);
      }
    });
  });

  describe("module clustering (pass 2)", () => {
    test("signals in same directory but different files group by module", () => {
      const signals = [
        sig(uuid(1), { location: { filePath: "src/auth/login.mjs" }, signalKind: "file_size" }),
        sig(uuid(2), { location: { filePath: "src/auth/logout.mjs" }, signalKind: "spaghetti_branching" }),
      ];
      const findings = clusterSignals(signals);
      // Same module "src/auth", different files, different themes
      // File pass: each file has 1 signal → deferred
      // Module pass: "src/auth" has 2 signals → clustered
      assert.equal(findings.length, 1);
      assert.equal(findings[0].signalIds.length, 2);
      assert.ok(findings[0].title.startsWith("module:"));
    });
  });

  describe("theme clustering (pass 3)", () => {
    test("signals with same signalKind but different files/modules group by theme", () => {
      const signals = [
        sig(uuid(1), { location: { filePath: "src/a.mjs" }, signalKind: "spaghetti_branching" }),
        sig(uuid(2), { location: { filePath: "scripts/b.mjs" }, signalKind: "spaghetti_branching" }),
      ];
      const findings = clusterSignals(signals);
      // File pass: each has 1 signal → deferred
      // Module pass: "src" 1, "scripts" 1 → deferred
      // Theme pass: "spaghetti_branching" 2 → clustered
      assert.equal(findings.length, 1);
      assert.equal(findings[0].signalIds.length, 2);
      assert.ok(findings[0].title.startsWith("theme:"));
    });
  });

  describe("singleton handling", () => {
    test("signal with no file, module, or theme match becomes singleton", () => {
      const signals = [
        sig(uuid(1), { signalKind: "unique_category" }),
      ];
      const findings = clusterSignals(signals);
      assert.equal(findings.length, 1);
      assert.equal(findings[0].signalIds.length, 1);
    });

    test("orphan signals with no location or signalKind become singletons", () => {
      const signals = [
        { id: uuid(1), sourceType: "manual_review", signalKind: "", location: {}, severityHint: "low", timestamp: "2024-06-03T12:00:00Z" },
      ];
      const findings = clusterSignals(signals);
      assert.equal(findings.length, 1);
      assert.equal(findings[0].signalIds.length, 1);
    });
  });

  describe("precedence", () => {
    test("file-level clustering takes precedence over module", () => {
      const signals = [
        sig(uuid(1), { location: { filePath: "src/auth/login.mjs" }, signalKind: "file_size" }),
        sig(uuid(2), { location: { filePath: "src/auth/login.mjs" }, signalKind: "spaghetti_branching" }),
        sig(uuid(3), { location: { filePath: "src/auth/logout.mjs" }, signalKind: "thin_wrapper" }),
      ];
      const findings = clusterSignals(signals);
      // Pass 1 file: login.mjs has 2 → cluster; logout.mjs has 1 → remaining
      // Pass 2 module: "src/auth" has only logout.mjs (1 signal) → deferred → singleton
      assert.equal(findings.length, 2);
      const fileFinding = findings.find(f => f.signalIds.length === 2);
      assert.ok(fileFinding);
      assert.ok(fileFinding.title.startsWith("file:"));
    });

    test("module clustering takes precedence over theme", () => {
      const signals = [
        sig(uuid(1), { location: { filePath: "src/x/a.mjs" }, signalKind: "spaghetti_branching" }),
        sig(uuid(2), { location: { filePath: "src/x/b.mjs" }, signalKind: "file_size" }),
        sig(uuid(3), { location: { filePath: "scripts/c.mjs" }, signalKind: "spaghetti_branching" }),
      ];
      const findings = clusterSignals(signals);
      // File pass: each file 1 signal → all deferred
      // Module pass: "src/x" has 2 → cluster; "scripts" has 1 → deferred
      // Theme pass: "spaghetti_branching" has only scripts/c.mjs (1) → singleton
      assert.equal(findings.length, 2);
      const moduleFinding = findings.find(f => f.signalIds.length === 2);
      assert.ok(moduleFinding);
      assert.ok(moduleFinding.title.startsWith("module:"));
    });
  });

  describe("no duplicate signals", () => {
    test("each signal appears in exactly one finding", () => {
      const signals = [
        sig(uuid(1), { location: { filePath: "src/a.mjs" }, signalKind: "x" }),
        sig(uuid(2), { location: { filePath: "src/a.mjs" }, signalKind: "x" }),
        sig(uuid(3), { location: { filePath: "src/b.mjs" }, signalKind: "y" }),
        sig(uuid(4), { location: { filePath: "src/c.mjs" }, signalKind: "y" }),
        sig(uuid(5), { location: { filePath: "scripts/d.mjs" }, signalKind: "z" }),
      ];
      const findings = clusterSignals(signals);
      const allSignalIds = findings.flatMap(f => f.signalIds);
      assert.equal(allSignalIds.length, signals.length);
      assert.equal(new Set(allSignalIds).size, signals.length);
    });
  });

  describe("empty / edge cases", () => {
    test("empty array returns empty array", () => {
      assert.deepEqual(clusterSignals([]), []);
    });

    test("non-array returns empty array", () => {
      assert.deepEqual(clusterSignals(null), []);
      assert.deepEqual(clusterSignals(undefined), []);
    });
  });

  describe("enriched clustering", () => {
    test("clusterSignalsEnriched includes _clusterReason and _signalCount", () => {
      const signals = [
        sig(uuid(1), { location: { filePath: "src/a.mjs" }, signalKind: "file_size" }),
        sig(uuid(2), { location: { filePath: "src/a.mjs" }, signalKind: "spaghetti_branching" }),
      ];
      const findings = clusterSignalsEnriched(signals);
      assert.equal(findings.length, 1);
      assert.equal(findings[0]._clusterReason, "file");
      assert.equal(findings[0]._signalCount, 2);
    });
  });

  describe("findings have required fields", () => {
    test("each finding has id, signalIds, score, title, createdAt, updatedAt", () => {
      const signals = [
        sig(uuid(1), { signalKind: "test_cat" }),
        sig(uuid(2), { signalKind: "test_cat" }),
      ];
      const findings = clusterSignals(signals);
      for (const f of findings) {
        assert.ok(f.id);
        assert.ok(Array.isArray(f.signalIds));
        assert.ok(f.signalIds.length > 0);
        assert.ok(typeof f.score === "number");
        assert.ok(f.title.length > 0);
        assert.ok(f.createdAt);
        assert.ok(f.updatedAt);
        assert.equal(f.validationStatus, "pending");
      }
    });
  });
});
