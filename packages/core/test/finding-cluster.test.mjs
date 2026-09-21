import assert from "node:assert/strict";
import { describe, test } from "bun:test";

import {
  assertCleanImpliesNoBlockingAct,
  clusterFindings,
  clustersFromStampedIds,
  computeRootCauseKey,
  dedupeActListByCluster,
  projectClusterDisposition,
} from "../src/loop/finding-cluster.mjs";

const HEAD = "abc123def456";

function locatedFinding(over = {}) {
  return {
    angle: "correctness",
    severity: "high",
    summary: "a defect",
    file: "src/thing.mjs",
    line: 42,
    recommendation: "guard the null case",
    ...over,
  };
}

describe("computeRootCauseKey", () => {
  test("returns null when headSha is missing/empty/non-string", () => {
    assert.equal(computeRootCauseKey(locatedFinding(), {}), null);
    assert.equal(computeRootCauseKey(locatedFinding(), { headSha: "" }), null);
    assert.equal(computeRootCauseKey(locatedFinding(), { headSha: "   " }), null);
    assert.equal(computeRootCauseKey(locatedFinding(), { headSha: 123 }), null);
  });

  test("returns null when file is missing/empty", () => {
    assert.equal(computeRootCauseKey(locatedFinding({ file: undefined }), { headSha: HEAD }), null);
    assert.equal(computeRootCauseKey(locatedFinding({ file: "  " }), { headSha: HEAD }), null);
  });

  test("returns null when line is missing/non-finite", () => {
    assert.equal(computeRootCauseKey(locatedFinding({ line: undefined }), { headSha: HEAD }), null);
    assert.equal(computeRootCauseKey(locatedFinding({ line: NaN }), { headSha: HEAD }), null);
    assert.equal(computeRootCauseKey(locatedFinding({ line: Infinity }), { headSha: HEAD }), null);
    assert.equal(computeRootCauseKey(locatedFinding({ line: "42" }), { headSha: HEAD }), null);
  });

  test("returns null when recommendation is missing/empty", () => {
    assert.equal(computeRootCauseKey(locatedFinding({ recommendation: undefined }), { headSha: HEAD }), null);
    assert.equal(computeRootCauseKey(locatedFinding({ recommendation: "  " }), { headSha: HEAD }), null);
  });

  test("returns null for a non-object finding", () => {
    assert.equal(computeRootCauseKey(null, { headSha: HEAD }), null);
    assert.equal(computeRootCauseKey(undefined, { headSha: HEAD }), null);
  });

  test("returns a non-null string when every component is present", () => {
    const key = computeRootCauseKey(locatedFinding(), { headSha: HEAD });
    assert.equal(typeof key, "string");
    assert.ok(key.length > 0);
  });

  test("normalizes recommendation: trim + lowercase + collapse whitespace runs, so casing/whitespace variants collide", () => {
    const a = computeRootCauseKey(locatedFinding({ recommendation: "  Guard   the Null  case " }), { headSha: HEAD });
    const b = computeRootCauseKey(locatedFinding({ recommendation: "guard the null case" }), { headSha: HEAD });
    assert.equal(a, b);
  });

  test("a different file, line, recommendation, or head yields a different key", () => {
    const base = computeRootCauseKey(locatedFinding(), { headSha: HEAD });
    assert.notEqual(computeRootCauseKey(locatedFinding({ file: "other.mjs" }), { headSha: HEAD }), base);
    assert.notEqual(computeRootCauseKey(locatedFinding({ line: 43 }), { headSha: HEAD }), base);
    assert.notEqual(computeRootCauseKey(locatedFinding({ recommendation: "do something else" }), { headSha: HEAD }), base);
    assert.notEqual(computeRootCauseKey(locatedFinding(), { headSha: "otherhead" }), base);
  });

  test("the NUL separator prevents a component-boundary collision a plain-string join would allow", () => {
    // Without a NUL separator, "file:1" + "23abc" (location + recommendation)
    // and "file:12" + "3abc" would concatenate to the SAME string
    // ("file:123abc") under a naive delimiter-free join. The NUL separator
    // keeps the component boundary intact, so these two genuinely distinct
    // findings must key DIFFERENTLY.
    const a = computeRootCauseKey({ file: "file", line: 1, recommendation: "23abc" }, { headSha: HEAD });
    const b = computeRootCauseKey({ file: "file", line: 12, recommendation: "3abc" }, { headSha: HEAD });
    assert.ok(a !== null && b !== null);
    assert.notEqual(a, b);
    // String.fromCharCode(0), not a literal escape, so the NUL separator
    // never lands in this file's own source bytes (git would misclassify
    // the file as binary — see 40631c49).
    const NUL = String.fromCharCode(0);
    assert.ok(a.includes(NUL));
    assert.ok(b.includes(NUL));
  });

  test("FIX A regression: the real ledger shape (files: [path]) resolves to the same key as the singular file shape", () => {
    const singular = computeRootCauseKey({ file: "a.mjs", line: 3, recommendation: "guard null" }, { headSha: HEAD });
    const arrayShaped = computeRootCauseKey({ files: ["a.mjs"], line: 3, recommendation: "guard null" }, { headSha: HEAD });
    assert.ok(singular !== null);
    assert.equal(arrayShaped, singular);
  });

  test("FIX B: a non-positive-integer line (0, negative, fractional) is unkeyable", () => {
    assert.equal(computeRootCauseKey(locatedFinding({ line: 0 }), { headSha: HEAD }), null);
    assert.equal(computeRootCauseKey(locatedFinding({ line: -1 }), { headSha: HEAD }), null);
    assert.equal(computeRootCauseKey(locatedFinding({ line: 1.5 }), { headSha: HEAD }), null);
  });
});

describe("clusterFindings", () => {
  test("groups exact-duplicate keyable findings into one cluster (stable, first-appearance representative)", () => {
    const findings = [
      locatedFinding({ summary: "reported by angle A" }),
      locatedFinding({ summary: "reported by angle B", angle: "security" }),
      locatedFinding({ summary: "unrelated", file: "other.mjs" }),
    ];
    const { ok, clusters } = clusterFindings(findings, { headSha: HEAD });
    assert.equal(ok, true);
    assert.equal(clusters.length, 2);
    assert.deepEqual(clusters[0], { key: clusters[0].key, keyable: true, memberIndices: [0, 1], representativeIndex: 0 });
    assert.deepEqual(clusters[1], { key: clusters[1].key, keyable: true, memberIndices: [2], representativeIndex: 2 });
  });

  test("a finding differing in ANY key component (ambiguous/plausibly-related) stays in a separate cluster", () => {
    const findings = [
      locatedFinding(),
      locatedFinding({ recommendation: "guard the null case, differently" }),
      locatedFinding({ line: 43 }),
      locatedFinding({ file: "src/other.mjs" }),
    ];
    const { clusters } = clusterFindings(findings, { headSha: HEAD });
    assert.equal(clusters.length, 4);
    for (const cluster of clusters) assert.equal(cluster.memberIndices.length, 1);
  });

  test("every unkeyable finding is its own singleton, never grouped with another unkeyable finding even when identical", () => {
    const unkeyable = { angle: "correctness", severity: "nit", summary: "no location" };
    const findings = [unkeyable, { ...unkeyable }, { ...unkeyable }];
    const { ok, clusters } = clusterFindings(findings, { headSha: HEAD });
    assert.equal(ok, true);
    assert.equal(clusters.length, 3);
    for (const [i, cluster] of clusters.entries()) {
      assert.deepEqual(cluster, { key: null, keyable: false, memberIndices: [i], representativeIndex: i });
    }
  });

  test("deterministic order: clusters ordered by representativeIndex ascending, memberIndices ascending", () => {
    const findings = [
      locatedFinding({ file: "b.mjs" }),
      locatedFinding({ file: "a.mjs" }),
      locatedFinding({ file: "b.mjs" }),
      locatedFinding({ file: "a.mjs" }),
    ];
    const { clusters } = clusterFindings(findings, { headSha: HEAD });
    const representativeIndices = clusters.map((c) => c.representativeIndex);
    assert.deepEqual(representativeIndices, [...representativeIndices].sort((a, b) => a - b));
    for (const cluster of clusters) {
      assert.deepEqual(cluster.memberIndices, [...cluster.memberIndices].sort((a, b) => a - b));
    }
  });

  test("fail-open on a non-array findings input: ok:false, no clusters to enumerate", () => {
    for (const bad of [null, undefined, "nope", 123, {}]) {
      const result = clusterFindings(bad, { headSha: HEAD });
      assert.equal(result.ok, false);
      assert.equal(typeof result.reason, "string");
      assert.deepEqual(result.clusters, []);
    }
  });

  test("fail-open on a missing/empty/non-string headSha: one singleton per ORIGINAL finding, in input order, keyable:false", () => {
    const findings = [locatedFinding(), locatedFinding(), locatedFinding({ file: "other.mjs" })];
    for (const badHead of [undefined, "", "   ", 123]) {
      const result = clusterFindings(findings, { headSha: badHead });
      assert.equal(result.ok, false);
      assert.equal(result.clusters.length, findings.length);
      result.clusters.forEach((cluster, i) => {
        assert.deepEqual(cluster, { key: null, keyable: false, memberIndices: [i], representativeIndex: i });
      });
    }
  });

  test("clusterFindings never throws — an internal error is caught and reported fail-open", () => {
    // A getter that throws simulates an internal error mid-iteration.
    const poison = [locatedFinding(), { get file() { throw new Error("boom"); }, line: 1, recommendation: "x" }];
    assert.doesNotThrow(() => clusterFindings(poison, { headSha: HEAD }));
    const result = clusterFindings(poison, { headSha: HEAD });
    assert.equal(result.ok, false);
    assert.equal(result.clusters.length, poison.length);
  });

  test("does not mutate the input findings array or its elements (pure)", () => {
    const findings = [locatedFinding(), locatedFinding()];
    const before = JSON.stringify(findings);
    clusterFindings(findings, { headSha: HEAD });
    assert.equal(JSON.stringify(findings), before);
  });

  test("FIX A regression: the real ledger shape (files: [path], no singular file) groups duplicates into one cluster", () => {
    // toFindingsLogShape's canonical output shape — `files` is an array, not
    // a singular `file`. Without FIX A this was all unkeyable singletons.
    const findings = [
      { angle: "correctness", severity: "high", summary: "a", files: ["src/thing.mjs"], line: 42, recommendation: "guard the null case" },
      { angle: "security", severity: "high", summary: "b", files: ["src/thing.mjs"], line: 42, recommendation: "guard the null case" },
    ];
    const { ok, clusters } = clusterFindings(findings, { headSha: HEAD });
    assert.equal(ok, true);
    assert.equal(clusters.length, 1);
    assert.deepEqual(clusters[0].memberIndices, [0, 1]);
    assert.equal(clusters[0].keyable, true);
  });

  test("complete provenance survives clustering: angle, criterion, location, and the round head are all still recoverable per member", () => {
    const findings = [
      locatedFinding({ angle: "correctness", judgeCriterion: "AC-1" }),
      locatedFinding({ angle: "security", judgeCriterion: "AC-1" }),
    ];
    const { clusters } = clusterFindings(findings, { headSha: HEAD });
    assert.equal(clusters.length, 1);
    for (const memberIndex of clusters[0].memberIndices) {
      const member = findings[memberIndex];
      assert.equal(member.file, "src/thing.mjs");
      assert.equal(member.line, 42);
      assert.equal(member.judgeCriterion, "AC-1");
      assert.ok(["correctness", "security"].includes(member.angle));
    }
    // The round head itself is recoverable from the cluster key (component 1).
    assert.ok(clusters[0].key.startsWith(HEAD));
  });
});

describe("clustersFromStampedIds", () => {
  test("reconstructs the same shape clusterFindings would produce for the equivalent lossless grouping", () => {
    const findings = [
      locatedFinding({ summary: "reported by angle A" }),
      locatedFinding({ summary: "reported by angle B", angle: "security" }),
      locatedFinding({ summary: "unrelated", file: "other.mjs" }),
    ];
    const { clusters: expected } = clusterFindings(findings, { headSha: HEAD });
    // Stamp each finding with its cluster's representativeIndex, exactly as
    // consolidate-fanin.mjs does.
    const stamped = findings.map((f, index) => {
      const owner = expected.find((c) => c.memberIndices.includes(index));
      return { ...f, clusterId: owner.representativeIndex };
    });
    const reconstructed = clustersFromStampedIds(stamped);
    assert.deepEqual(
      reconstructed.map((c) => ({ memberIndices: c.memberIndices, representativeIndex: c.representativeIndex })),
      expected.map((c) => ({ memberIndices: c.memberIndices, representativeIndex: c.representativeIndex })),
    );
  });

  test("a multi-member group (two findings sharing a clusterId) yields one cluster with both memberIndices and the shared representativeIndex", () => {
    const stamped = [
      locatedFinding({ clusterId: 0 }),
      locatedFinding({ angle: "security", clusterId: 0 }),
      locatedFinding({ angle: "performance", file: "other.mjs", clusterId: 2 }),
    ];
    const clusters = clustersFromStampedIds(stamped);
    assert.equal(clusters.length, 2);
    assert.deepEqual(clusters[0], { key: null, keyable: true, memberIndices: [0, 1], representativeIndex: 0 });
    assert.deepEqual(clusters[1], { key: null, keyable: true, memberIndices: [2], representativeIndex: 2 });
  });

  test("deterministic order: clusters ordered by representativeIndex ascending, memberIndices ascending", () => {
    const stamped = [
      locatedFinding({ file: "b.mjs", clusterId: 3 }),
      locatedFinding({ file: "a.mjs", clusterId: 1 }),
      locatedFinding({ file: "b.mjs", clusterId: 3 }),
      locatedFinding({ file: "a.mjs", clusterId: 1 }),
    ];
    const clusters = clustersFromStampedIds(stamped);
    const representativeIndices = clusters.map((c) => c.representativeIndex);
    assert.deepEqual(representativeIndices, [...representativeIndices].sort((a, b) => a - b));
    for (const cluster of clusters) {
      assert.deepEqual(cluster.memberIndices, [...cluster.memberIndices].sort((a, b) => a - b));
    }
  });

  test("throws when findings is not an array", () => {
    assert.throws(() => clustersFromStampedIds(null), TypeError);
    assert.throws(() => clustersFromStampedIds("nope"), TypeError);
  });

  test("throws when any finding is missing an integer clusterId", () => {
    assert.throws(() => clustersFromStampedIds([locatedFinding({ clusterId: 0 }), locatedFinding()]), TypeError);
    assert.throws(() => clustersFromStampedIds([locatedFinding({ clusterId: "0" })]), TypeError);
  });
});

function disposedFinding(finding, judgeDisposition, extra = {}) {
  return { ...finding, judgeDisposition, judgeRationale: `rationale for ${judgeDisposition}`, ...extra };
}

describe("projectClusterDisposition", () => {
  test("projects the representative's judge fields onto every OTHER member of a multi-member cluster", () => {
    const enriched = [
      disposedFinding(locatedFinding({ angle: "correctness" }), "act", { judgeCriterion: "AC-1" }),
      disposedFinding(locatedFinding({ angle: "security" }), "reject"), // duplicate root cause, judge saw it independently
    ];
    const { clusters } = clusterFindings(enriched, { headSha: HEAD });
    const projected = projectClusterDisposition(enriched, clusters);
    assert.equal(projected.length, 2);
    for (const finding of projected) {
      assert.equal(finding.judgeDisposition, "act");
      assert.equal(finding.judgeRationale, "rationale for act");
      assert.equal(finding.judgeCriterion, "AC-1");
    }
    // Original angle identity is untouched — only the judge-owned fields move.
    assert.equal(projected[0].angle, "correctness");
    assert.equal(projected[1].angle, "security");
  });

  test("clears a projected followUpDraft/judgeCriterion the representative does not itself carry", () => {
    const enriched = [
      disposedFinding(locatedFinding(), "act"),
      disposedFinding(locatedFinding({ angle: "security" }), "defer", { followUpDraft: { title: "t", body: "b" } }),
    ];
    const { clusters } = clusterFindings(enriched, { headSha: HEAD });
    const projected = projectClusterDisposition(enriched, clusters);
    assert.equal(projected[1].judgeDisposition, "act");
    assert.equal("followUpDraft" in projected[1], false);
  });

  test("a singleton cluster is left unchanged", () => {
    const enriched = [disposedFinding(locatedFinding(), "act")];
    const { clusters } = clusterFindings(enriched, { headSha: HEAD });
    const projected = projectClusterDisposition(enriched, clusters);
    assert.deepEqual(projected, enriched);
  });

  test("is pure: deep-clones, never mutates the input array/objects", () => {
    const enriched = [disposedFinding(locatedFinding(), "act"), disposedFinding(locatedFinding({ angle: "security" }), "reject")];
    const before = JSON.stringify(enriched);
    const { clusters } = clusterFindings(enriched, { headSha: HEAD });
    const projected = projectClusterDisposition(enriched, clusters);
    assert.equal(JSON.stringify(enriched), before);
    assert.notEqual(projected, enriched);
    assert.notEqual(projected[0], enriched[0]);
  });

  test("fails closed on malformed clusters (non-array enrichedFindings/clusters, out-of-range indices)", () => {
    assert.throws(() => projectClusterDisposition(null, []), TypeError);
    assert.throws(() => projectClusterDisposition([], null), TypeError);
    assert.throws(
      () => projectClusterDisposition([{}], [{ memberIndices: [0, 1], representativeIndex: 5 }]),
      RangeError,
    );
    assert.throws(
      () => projectClusterDisposition([{}, {}], [{ memberIndices: [0, 99], representativeIndex: 0 }]),
      RangeError,
    );
    assert.throws(() => projectClusterDisposition([{}], [{ memberIndices: "nope", representativeIndex: 0 }]), TypeError);
  });

  test("FIX C: a SINGLETON cluster with an out-of-range representativeIndex still throws (no fast-path skip)", () => {
    assert.throws(
      () => projectClusterDisposition([{}], [{ memberIndices: [0], representativeIndex: 5 }]),
      RangeError,
    );
  });

  test("FIX C: a SINGLETON cluster with an out-of-range memberIndex still throws (no fast-path skip)", () => {
    assert.throws(
      () => projectClusterDisposition([{}], [{ memberIndices: [99], representativeIndex: 0 }]),
      RangeError,
    );
  });

  test("throws on an empty memberIndices (a cluster must have at least one member)", () => {
    assert.throws(
      () => projectClusterDisposition([{}], [{ memberIndices: [], representativeIndex: 0 }]),
      RangeError,
    );
  });

  test("throws when representativeIndex is not one of memberIndices", () => {
    assert.throws(
      () => projectClusterDisposition([{}, {}], [{ memberIndices: [1], representativeIndex: 0 }]),
      RangeError,
    );
  });
});

describe("dedupeActListByCluster — context-size before/after evidence", () => {
  test("a duplicate-remediation fixture yields a SHORTER act list after dedup", () => {
    const allFindings = [
      disposedFinding(locatedFinding({ angle: "correctness" }), "act"),
      disposedFinding(locatedFinding({ angle: "security" }), "act"), // same root cause, reported twice
      disposedFinding(locatedFinding({ file: "other.mjs" }), "act"), // distinct root cause
    ];
    const { clusters } = clusterFindings(allFindings, { headSha: HEAD });
    const act = allFindings.filter((f) => f.judgeDisposition === "act");
    assert.equal(act.length, 3, "before dedup: one entry per reviewer report");

    const deduped = dedupeActListByCluster(act, clusters, allFindings);
    assert.equal(deduped.length, 2, "after dedup: one remediation per acted root cause");
    assert.equal(deduped[0], allFindings[0]); // representative wins
    assert.equal(deduped[1], allFindings[2]);
  });

  test("prefers the representative when it is itself an act member", () => {
    const allFindings = [
      disposedFinding(locatedFinding(), "act"), // representative, index 0
      disposedFinding(locatedFinding({ angle: "security" }), "act"),
    ];
    const { clusters } = clusterFindings(allFindings, { headSha: HEAD });
    const act = allFindings.filter((f) => f.judgeDisposition === "act");
    const deduped = dedupeActListByCluster(act, clusters, allFindings);
    assert.deepEqual(deduped, [allFindings[0]]);
  });

  test("falls back to the earliest act member when the representative itself was not acted on", () => {
    const allFindings = [
      disposedFinding(locatedFinding(), "reject"), // representative, index 0 — not act
      disposedFinding(locatedFinding({ angle: "security" }), "act"), // earliest act member
      disposedFinding(locatedFinding({ angle: "performance" }), "act"),
    ];
    const { clusters } = clusterFindings(allFindings, { headSha: HEAD });
    const act = allFindings.filter((f) => f.judgeDisposition === "act");
    const deduped = dedupeActListByCluster(act, clusters, allFindings);
    assert.deepEqual(deduped, [allFindings[1]]);
  });

  test("a finding whose cluster cannot be resolved passes through unchanged (fail-open)", () => {
    const stray = disposedFinding(locatedFinding({ angle: "unrelated" }), "act");
    const deduped = dedupeActListByCluster([stray], [], []);
    assert.deepEqual(deduped, [stray]);
  });

  test("preserves input order and drops only later same-cluster duplicates", () => {
    const allFindings = [
      disposedFinding(locatedFinding({ angle: "a" }), "act"),
      disposedFinding(locatedFinding({ file: "distinct.mjs" }), "act"),
      disposedFinding(locatedFinding({ angle: "b" }), "act"), // duplicate of index 0's cluster
    ];
    const { clusters } = clusterFindings(allFindings, { headSha: HEAD });
    const act = allFindings.filter((f) => f.judgeDisposition === "act");
    const deduped = dedupeActListByCluster(act, clusters, allFindings);
    assert.deepEqual(deduped, [allFindings[0], allFindings[1]]);
  });

  test("throws TypeError on a non-array actFindings", () => {
    assert.throws(() => dedupeActListByCluster(null, [], []), TypeError);
  });
});

describe("assertCleanImpliesNoBlockingAct", () => {
  test("throws on clean + an act at a blocking severity", () => {
    assert.throws(() => assertCleanImpliesNoBlockingAct("clean", [{ severity: "high" }], ["high"]), /clean verdict is invalid/);
    assert.throws(
      () => assertCleanImpliesNoBlockingAct("clean", [{ severity: "medium" }, { severity: "high" }], ["high"]),
      /blocking severity \(high\)/,
    );
  });

  test("accepts clean + acts only on non-blocking severities (GATE-EXEC-BLOCKING-ONLY-FIX)", () => {
    assert.equal(assertCleanImpliesNoBlockingAct("clean", [{ severity: "medium" }, { severity: "low" }], ["high"]), "clean");
  });

  test("honors a widened blocking set (a medium act under a high+medium block set fails closed)", () => {
    assert.throws(
      () => assertCleanImpliesNoBlockingAct("clean", [{ severity: "medium" }], ["high", "medium"]),
      /clean verdict is invalid/,
    );
  });

  test("returns the verdict unchanged on clean + zero act findings", () => {
    assert.equal(assertCleanImpliesNoBlockingAct("clean", [], ["high"]), "clean");
  });

  test("returns the verdict unchanged on findings_present regardless of act severities", () => {
    assert.equal(assertCleanImpliesNoBlockingAct("findings_present", [], ["high"]), "findings_present");
    assert.equal(assertCleanImpliesNoBlockingAct("findings_present", [{ severity: "high" }], ["high"]), "findings_present");
  });

  test("defaults the blocking set to ['high'] when unspecified", () => {
    assert.throws(() => assertCleanImpliesNoBlockingAct("clean", [{ severity: "high" }]), /clean verdict is invalid/);
    assert.equal(assertCleanImpliesNoBlockingAct("clean", [{ severity: "medium" }]), "clean");
  });

  test("throws TypeError when actFindings is not an array", () => {
    assert.throws(() => assertCleanImpliesNoBlockingAct("clean", 1, ["high"]), TypeError);
    assert.throws(() => assertCleanImpliesNoBlockingAct("clean", null, ["high"]), TypeError);
  });
});
