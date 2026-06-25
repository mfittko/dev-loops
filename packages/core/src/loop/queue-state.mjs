/**
 * Queue state machine — durable .pi/dev-loop-queue.json read/write/transition.
 *
 * Entry lifecycle:
 *   queued → running → waiting_review → gates_passing → merging → done
 *   any state → blocked | failed
 */

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";

// ── Schema constants ────────────────────────────────────────────────

export const QUEUE_VERSION = 1;

export const ENTRY_STATUS = Object.freeze([
  "queued",
  "running",
  "waiting_review",
  "gates_passing",
  "merging",
  "done",
  "blocked",
  "failed",
]);

export const VALID_TRANSITIONS = Object.freeze({
  queued:           ["running", "blocked"],
  running:           ["waiting_review", "blocked", "failed", "done"],
  waiting_review:    ["running", "gates_passing", "blocked", "failed", "done"],
  gates_passing:     ["merging", "blocked", "failed", "done"],
  merging:           ["done", "failed", "blocked"],
  done:              [],
  blocked:           ["queued", "running", "failed"],
  failed:            ["queued"],
});

export const RECOVERABLE_FAILURES = new Set([
  "acceptance_report_parse_failure",
  "round_cap_reached",
  "timeout",
]);

// ── Default queue shape ─────────────────────────────────────────────

function emptyQueue() {
  return { version: QUEUE_VERSION, entries: [] };
}

// ── File I/O ─────────────────────────────────────────────────────────

export function queueFilePath(repoRoot) {
  return path.join(repoRoot, ".pi", "dev-loop-queue.json");
}

export async function readQueue(repoRoot) {
  const fp = queueFilePath(repoRoot);
  try {
    const raw = await readFile(fp, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.entries)) {
      return emptyQueue();
    }
    return { version: parsed.version ?? QUEUE_VERSION, entries: parsed.entries };
  } catch {
    return emptyQueue();
  }
}

export async function writeQueue(repoRoot, queue) {
  const fp = queueFilePath(repoRoot);
  await mkdir(path.dirname(fp), { recursive: true });
  // Atomic write: write to temp file then rename
  const tmp = fp + ".tmp." + Date.now();
  await writeFile(tmp, JSON.stringify(queue, null, 2) + "\n", "utf8");
  await rename(tmp, fp);
}

// ── Entry helpers ────────────────────────────────────────────────────

export function createEntry(target, kind, dependsOn = []) {
  return {
    target,
    kind,           // "issue" | "pr"
    status: "queued",
    dependsOn: Array.isArray(dependsOn) ? dependsOn : [],
    pr: null,
    runId: null,
    retrospectiveWritten: false,
    failureReason: null,
    failureKind: null,
    retryCount: 0,
  };
}

export function snapshotEntry(entry) {
  return { ...entry };
}

export function findEntry(queue, target) {
  return queue.entries.find((e) => e.target === target);
}

export function findEntryIndex(queue, target) {
  return queue.entries.findIndex((e) => e.target === target);
}

// ── State machine ────────────────────────────────────────────────────

export function isValidTransition(from, to) {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.includes(to);
}

export function transitionEntry(entry, to, metadata = {}) {
  if (!isValidTransition(entry.status, to)) {
    throw new Error(
      `Invalid transition: ${entry.status} → ${to} for entry ${entry.target}`
    );
  }
  entry.status = to;
  if (metadata.pr != null) entry.pr = metadata.pr;
  if (metadata.runId != null) entry.runId = metadata.runId;
  if (metadata.retrospectiveWritten != null) entry.retrospectiveWritten = metadata.retrospectiveWritten;
  if (metadata.failureReason != null) entry.failureReason = metadata.failureReason;
  if (metadata.failureKind != null) entry.failureKind = metadata.failureKind;
  return entry;
}

// ── Dependency resolution ────────────────────────────────────────────

export function entryDependenciesSatisfied(queue, entry) {
  if (!entry.dependsOn || entry.dependsOn.length === 0) return true;
  return entry.dependsOn.every((depTarget) => {
    const dep = findEntry(queue, depTarget);
    return dep && dep.status === "done";
  });
}

// ── Queue ordering ───────────────────────────────────────────────────

export function topologicalOrder(entries) {
  const visited = new Set();
  const result = [];

  function visit(entry, path = new Set()) {
    if (visited.has(entry.target)) return;
    if (path.has(entry.target)) {
      throw new Error(`Circular dependency detected involving ${entry.target}`);
    }
    path.add(entry.target);
    for (const depTarget of entry.dependsOn || []) {
      const dep = entries.find((e) => e.target === depTarget);
      if (dep) visit(dep, new Set(path));
    }
    path.delete(entry.target);
    visited.add(entry.target);
    result.push(entry);
  }

  for (const entry of entries) {
    visit(entry);
  }

  return result;
}

function applyOrderHint(ordered, orderHint) {
  if (orderHint.length === 0) return ordered;
  const hinted = new Set(orderHint);
  const hintIndex = new Map(orderHint.map((target, i) => [target, i]));
  const inHint = [];
  const rest = [];
  for (const entry of ordered) {
    if (hinted.has(entry.target)) {
      inHint.push(entry);
    } else {
      rest.push(entry);
    }
  }
  inHint.sort((a, b) => hintIndex.get(a.target) - hintIndex.get(b.target));
  return [...inHint, ...rest];
}

export function nextReadyEntry(queue, maxRetries = 1, orderHint = []) {
  const ordered = topologicalOrder(queue.entries);
  const sorted = applyOrderHint(ordered, orderHint);
  for (const entry of sorted) {
    if (entry.status === "queued" && entryDependenciesSatisfied(queue, entry)) {
      return entry;
    }
    if (
      entry.status === "failed" &&
      RECOVERABLE_FAILURES.has(entry.failureKind) &&
      (entry.retryCount ?? 0) < maxRetries
    ) {
      return entry;
    }
  }
  return null;
}

export function allDone(queue) {
  return queue.entries.every((e) => e.status === "done" || e.status === "blocked");
}

export function pendingEntries(queue) {
  return queue.entries.filter(
    (e) => e.status !== "done" && e.status !== "blocked"
  );
}

// ── Board membership reconciliation ──────────────────────────────────

/**
 * Reconcile board-driven membership into the local queue (issue #864).
 *
 * A configured GitHub Projects board is the authoritative source of queue
 * MEMBERSHIP (which issues should be worked), not just ordering/status. This
 * pure helper folds the board's "Next Up" targets into the queue: for each
 * target not already present (by `findEntry`), it appends a fresh queued
 * `createEntry(target, "issue")`. Existing entries — and their status, order,
 * and metadata — are preserved untouched, and targets already present are
 * skipped (dedup).
 *
 * Pure: performs no I/O. Mutates and returns the passed `queue` object (its
 * `entries` array is appended to in place) plus the list of newly added
 * targets so the caller can log/report.
 *
 * @param {{version:number, entries:Array}} queue - the current queue.
 * @param {Array<number>} nextUpTargets - board "Next Up" issue numbers.
 * @returns {{queue:{version:number, entries:Array}, added:number[]}}
 */
export function reconcileEntriesFromBoard(queue, nextUpTargets) {
  const added = [];
  if (!queue || !Array.isArray(queue.entries)) {
    return { queue, added };
  }
  if (!Array.isArray(nextUpTargets) || nextUpTargets.length === 0) {
    return { queue, added };
  }
  for (const target of nextUpTargets) {
    // Guard against malformed/duplicate board input: only number targets,
    // and never add the same target twice (even if it repeats in the board
    // list and was not yet in the queue at the start of this loop).
    if (typeof target !== "number") continue;
    if (findEntry(queue, target)) continue;
    queue.entries.push(createEntry(target, "issue"));
    added.push(target);
  }
  return { queue, added };
}

// ── Bug injection ────────────────────────────────────────────────────

export function appendBugIssue(queue, issueNumber, dependsOn = null) {
  const entry = createEntry(issueNumber, "issue", dependsOn ? [dependsOn] : []);
  entry.status = "queued";
  queue.entries.push(entry);
  return entry;
}

// ── Serialization helpers ────────────────────────────────────────────

export function serializeQueue(queue) {
  return {
    version: queue.version,
    entries: queue.entries.map((e) => ({ ...e })),
  };
}
