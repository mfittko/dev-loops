import assert from "node:assert/strict";
import { test } from "bun:test";

// Deterministic, dependency-free model of the two concurrency groups
// introduced by the gate-evidence reporter split (#2262, docs/decisions/0075),
// simulating a "cancelling burst" of N review/comment events at a clean PR
// close.
//
// Detector group (`gate-evidence-runner`): job-level concurrency,
// cancel-in-progress=true. A run superseded by a later overlapping run is
// CANCELLED and contributes no evidence_state output, and posts nothing
// (it never owned the status even before the split's design point: this
// module encodes the worst case from the issue, where every run in the
// burst — INCLUDING THE LAST-TRIGGERED ONE — is cancelled).
//
// Reporter group (`gate-evidence-reporter`): job-level concurrency,
// cancel-in-progress=false. A run still QUEUED (not yet started) when a
// newer run is queued is superseded and dropped WITHOUT EXECUTING (it would
// only post a state a newer event already supersedes); a run already
// RUNNING is never killed and always finishes. Nothing is queued after the
// FINAL event's reporter run, so it is always the one that gets to execute
// and post — the design invariant that closes the issue.
function runBurst({ eventCount, detectorCompletes = new Set(), liveEvidenceState }) {
  if (eventCount < 1) throw new Error("eventCount must be >= 1");

  // Detector: only the indices in `detectorCompletes` produce an
  // evidence_state output; every other run was cancelled and posts nothing.
  const detectorOutputs = Array.from({ length: eventCount }, (_, i) => (detectorCompletes.has(i) ? liveEvidenceState : null));
  const detectorPosts = []; // the detector NEVER posts a status (0075) — always empty by design.

  // Reporter: the run triggered by the LAST event is the one guaranteed to
  // execute (every earlier queued run may be superseded-and-dropped while
  // still pending). It reuses its OWN detector run's output when present;
  // otherwise it recomputes by reading the live evidence directly.
  const lastIndex = eventCount - 1;
  const detectorOutputForLastReporter = detectorOutputs[lastIndex];
  const recomputed = detectorOutputForLastReporter === null;
  const effectiveEvidenceState = recomputed ? liveEvidenceState : detectorOutputForLastReporter;
  const state = effectiveEvidenceState === "satisfied" ? "success" : "failure";
  const reporterPosts = [{ eventIndex: lastIndex, state, recomputed }];

  return { detectorPosts, reporterPosts };
}

test("a cancelling burst where EVERY detector run is cancelled still ends success at the final head, via reporter recompute (#2262)", () => {
  const { detectorPosts, reporterPosts } = runBurst({
    eventCount: 6,
    detectorCompletes: new Set(), // worst case: even the last-triggered detector run is cancelled
    liveEvidenceState: "satisfied",
  });
  assert.equal(detectorPosts.length, 0, "a cancelled detector run posts nothing — no spurious failure");
  assert.equal(reporterPosts.length, 1);
  assert.equal(reporterPosts[0].eventIndex, 5, "the FINAL event's reporter is the one that posts");
  assert.equal(reporterPosts[0].recomputed, true, "with no detector output available, the reporter recomputes");
  assert.equal(reporterPosts[0].state, "success");
});

test("when the final detector run DOES complete, the reporter reuses its output instead of recomputing", () => {
  const { reporterPosts } = runBurst({
    eventCount: 3,
    detectorCompletes: new Set([2]), // only the last-triggered detector run survives
    liveEvidenceState: "satisfied",
  });
  assert.equal(reporterPosts[0].recomputed, false);
  assert.equal(reporterPosts[0].state, "success");
});

test("unsatisfied evidence still fails closed to failure after the burst, never a stale pending", () => {
  const { reporterPosts } = runBurst({
    eventCount: 4,
    detectorCompletes: new Set(),
    liveEvidenceState: "not_established",
  });
  assert.equal(reporterPosts[0].state, "failure");
  assert.notEqual(reporterPosts[0].state, "pending");
});

test("a single (non-burst) event still resolves via the same model", () => {
  const { reporterPosts } = runBurst({ eventCount: 1, liveEvidenceState: "satisfied" });
  assert.equal(reporterPosts[0].eventIndex, 0);
  assert.equal(reporterPosts[0].state, "success");
});
