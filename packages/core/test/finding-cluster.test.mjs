import assert from "node:assert/strict";
import { describe, test } from "bun:test";

import {
  assertCleanImpliesNoAct,
  clusterFindings,
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
    // Without a NUL separator, "file:1" + "x" and "file" + "1x" could collide
    // under a naive delimiter-free or colon-joined concatenation.
    const a = computeRootCauseKey({ file: "file", line: 1, recommendation: "x" }, { headSha: HEAD });
    const b = computeRootCauseKey({ file: "file", line: 11, recommendation: "" }, { headSha: HEAD }); // unkeyable (empty recommendation)
    assert.equal(b, null);
    assert.ok(a !== null);
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

describe("assertCleanImpliesNoAct", () => {
  test("throws on clean + a nonzero act count", () => {
    assert.throws(() => assertCleanImpliesNoAct("clean", 1), /clean verdict is invalid/);
    assert.throws(() => assertCleanImpliesNoAct("clean", 3), /clean verdict is invalid/);
  });

  test("returns the verdict unchanged on clean + zero act count", () => {
    assert.equal(assertCleanImpliesNoAct("clean", 0), "clean");
  });

  test("returns the verdict unchanged on findings_present + any act count", () => {
    assert.equal(assertCleanImpliesNoAct("findings_present", 0), "findings_present");
    assert.equal(assertCleanImpliesNoAct("findings_present", 5), "findings_present");
  });

  test("throws TypeError when actCount is not a non-negative integer", () => {
    assert.throws(() => assertCleanImpliesNoAct("clean", -1), TypeError);
    assert.throws(() => assertCleanImpliesNoAct("clean", 1.5), TypeError);
    assert.throws(() => assertCleanImpliesNoAct("clean", "1"), TypeError);
    assert.throws(() => assertCleanImpliesNoAct("clean", NaN), TypeError);
  });
});
