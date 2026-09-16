import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import {
  createInspectionViewerAdapter,
  describeRetryAfter,
  isRateLimitError,
  parseGhJsonOutput,
  readRateLimitResetMs,
} from "../../scripts/loop/_inspect-run-viewer-adapter.mjs";
import {
  buildInspectionMermaidGraph,
  formatInspectRunViewerUrl,
  listListeningPidsForPort,
  loadMermaidBrowserScript,
  parseInspectRunViewerCliArgs,
  renderInspectRunViewerHtml,
  resetMermaidBrowserScriptCache,
  restartExistingPortListener,
  runCli,
} from "../../scripts/loop/inspect-run-viewer.mjs";
import {
  STATE as COPILOT_STATE,
  TRANSITIONS as COPILOT_TRANSITIONS,
} from "../../packages/core/src/loop/copilot-loop-state.mjs";
import {
  OUTER_STATE,
  OUTER_TRANSITIONS,
} from "../../packages/core/src/loop/conductor-routing.mjs";
import {
  REVIEWER_STATE,
  REVIEWER_TRANSITIONS,
} from "../../packages/core/src/loop/reviewer-loop-state.mjs";
import { MERMAID_BROWSER_ASSET_PATH } from "../../scripts/loop/inspect-run-viewer/constants.mjs";
import { makeSnapshot } from "./inspect-run-viewer-test-helpers.mjs";
test("createInspectionViewerAdapter loadSnapshot validates target deterministically", async () => {
  const adapter = createInspectionViewerAdapter({
    inspectRunImpl: async () => ({ ok: true }),
  });

  await assert.rejects(
    () => adapter.loadSnapshot({ repo: "owner/repo", pr: "nope" }),
    /positive integer/,
  );
  await assert.rejects(
    () => adapter.loadSnapshot({ repo: "../../bad", pr: 55 }),
    /target\.repo must match <owner\/name>/,
  );
});

test("createInspectionViewerAdapter keeps normalized target authoritative over options", async () => {
  let inspectRunCall;
  const adapter = createInspectionViewerAdapter({
    inspectRunImpl: async (input) => {
      inspectRunCall = input;
      return { ok: true };
    },
  });

  await adapter.loadSnapshot(
    { repo: "owner/repo", pr: "55" },
    { repo: "other/repo", pr: 99, reviewerLogin: "reviewer" },
  );

  assert.deepEqual(inspectRunCall, {
    repo: "owner/repo",
    pr: 55,
    reviewerLogin: "reviewer",
  });
});

test("rate-limit failures carry a retry-at hint read from the live reset header", async () => {
  assert.equal(isRateLimitError(new Error("gh command failed: GraphQL: API rate limit already exceeded")), true);
  assert.equal(isRateLimitError(new Error("You have exceeded a secondary rate limit")), true);
  assert.equal(isRateLimitError(new Error("gh command failed: not found")), false);
  // A PR title or proxy body echoing the phrase is not a rate limit, and showing
  // the operator a retry time for it is wrong guidance.
  assert.equal(isRateLimitError(new Error('gh command failed: no results for "raise the rate limit doc"')), false);

  // The failing inbox call spends the SEARCH budget, so only a reading that says
  // it came from the search resource may drive the hint.
  const probedArgs = [];
  const resetMs = await readRateLimitResetMs({
    runChildImpl: async (_command, args) => {
      probedArgs.push(args);
      return {
        code: 0,
        stdout: "HTTP/2.0 200 OK\r\nX-RateLimit-Resource: search\r\nX-RateLimit-Reset: 1789568063\r\n",
        stderr: "",
      };
    },
  });
  assert.equal(resetMs, 1789568063000);
  assert.match(probedArgs[0].join(" "), /search/, "the probe must hit the resource the failing call spends");

  // graphql resets hourly while search resets per minute, so a graphql reading
  // would tell the operator "~47 min" for a limit clearing in seconds.
  assert.equal(
    await readRateLimitResetMs({
      runChildImpl: async () => ({
        code: 0,
        stdout: "HTTP/2.0 200 OK\r\nX-RateLimit-Resource: graphql\r\nX-RateLimit-Reset: 1789568063\r\n",
        stderr: "",
      }),
    }),
    null,
  );

  // An unterminated stdout must not merge its last line into stderr's first and
  // silently break the anchored header match.
  assert.equal(
    await readRateLimitResetMs({
      runChildImpl: async () => ({
        code: 0,
        stdout: "HTTP/2.0 200 OK\r\nx-ratelimit-resource: search",
        stderr: "x-ratelimit-reset: 1789568063\n",
      }),
    }),
    1789568063000,
  );

  // A probe that never settles must not hang the request path it is awaited on.
  assert.equal(
    await readRateLimitResetMs({ timeoutMs: 20, runChildImpl: () => new Promise(() => {}) }),
    null,
  );

  // A reset a year out is a bad header, not a rate limit, and must not reach
  // `new Date(...).toISOString()` where an absurd value throws RangeError.
  assert.equal(describeRetryAfter(Date.now() + (400 * 24 * 60 * 60 * 1000)), null);
  assert.equal(describeRetryAfter(Number.MAX_SAFE_INTEGER), null);

  assert.equal(
    describeRetryAfter(1789568063000, 1789568063000 - (14 * 60_000)),
    "Retry in ~14 min (resets at 14:14 UTC).",
  );
  // A reset already in the past yields no hint rather than a negative countdown.
  assert.equal(describeRetryAfter(1789568063000, 1789568063000 + 1), null);
  assert.equal(describeRetryAfter(null), null);

  // A probe that cannot run degrades to "no hint", never throws.
  assert.equal(await readRateLimitResetMs({ runChildImpl: async () => { throw new Error("gh missing"); } }), null);
  assert.equal(await readRateLimitResetMs({ runChildImpl: async () => ({ code: 0, stdout: "no headers", stderr: "" }) }), null);
});

test("createInspectionViewerAdapter caches snapshots per target, coalesces concurrent loads, and honors refresh", async () => {
  let nowMs = Date.parse("2026-05-21T00:00:00.000Z");
  let inspectRunCalls = 0;
  const adapter = createInspectionViewerAdapter({
    nowImpl: () => nowMs,
    inspectRunImpl: async () => {
      inspectRunCalls += 1;
      return { ok: true };
    },
  });
  const target = { repo: "owner/repo", pr: 55 };

  await Promise.all([adapter.loadSnapshot(target), adapter.loadSnapshot(target)]);
  assert.equal(inspectRunCalls, 1, "concurrent loads of one target share a single gh fan-out");

  await adapter.loadSnapshot(target);
  assert.equal(inspectRunCalls, 1, "a repeat load inside the TTL is served from cache");

  await adapter.loadSnapshot({ repo: "owner/repo", pr: 56 });
  assert.equal(inspectRunCalls, 2, "a different PR is cached separately");

  await adapter.loadSnapshot(target, { refresh: true });
  assert.equal(inspectRunCalls, 3, "refresh bypasses the cache for the selected target only");

  await adapter.loadSnapshot(target);
  assert.equal(inspectRunCalls, 3, "the forced refresh repopulates the cache");

  nowMs += 16_000;
  await adapter.loadSnapshot(target);
  assert.equal(inspectRunCalls, 4, "an expired entry refetches");

  // `includeLoopIterations` is part of the cache key, so a deferred page-render
  // snapshot can never be served to `/snapshot.json`, which asks for the full one.
  await adapter.loadSnapshot(target, { includeLoopIterations: false });
  assert.equal(inspectRunCalls, 5, "a deferred load must not be answered from the full-snapshot entry");
  await adapter.loadSnapshot(target);
  assert.equal(inspectRunCalls, 5, "the full-snapshot entry is untouched by the deferred one");
});

test("createInspectionViewerAdapter fetches round metrics alone and caches them apart from the snapshot", async () => {
  let loopIterationCalls = 0;
  const adapter = createInspectionViewerAdapter({
    inspectRunImpl: async () => ({ ok: true }),
    inspectRunLoopIterationsImpl: async (options) => {
      loopIterationCalls += 1;
      return { available: true, source: "github_pr_timeline", target: `${options.repo}#${options.pr}` };
    },
  });
  const target = { repo: "owner/repo", pr: 55 };

  const [first, second] = await Promise.all([
    adapter.loadLoopIterations(target),
    adapter.loadLoopIterations(target),
  ]);
  assert.equal(loopIterationCalls, 1, "concurrent round-metrics fetches share one fan-out");
  assert.equal(first.target, "owner/repo#55");
  assert.deepEqual(first, second);

  await adapter.loadLoopIterations({ repo: "owner/repo", pr: 56 });
  assert.equal(loopIterationCalls, 2, "a different PR is cached separately");

  // Round metrics never come out of the snapshot entry, and vice versa.
  await adapter.loadSnapshot(target);
  await adapter.loadLoopIterations(target);
  assert.equal(loopIterationCalls, 2);
});

test("createInspectionViewerAdapter keeps an in-flight snapshot cached past the TTL instead of sweeping it mid-load", async () => {
  let nowMs = Date.parse("2026-05-21T00:00:00.000Z");
  let inspectRunCalls = 0;
  let release;
  const adapter = createInspectionViewerAdapter({
    nowImpl: () => nowMs,
    inspectRunImpl: async () => {
      inspectRunCalls += 1;
      await new Promise((resolve) => { release = resolve; });
      return { ok: true };
    },
  });
  const target = { repo: "owner/repo", pr: 55 };

  const slowLoad = adapter.loadSnapshot(target);
  // The load is still running when the TTL elapses: a second caller must join it
  // rather than start another full ~20-call fan-out.
  nowMs += 16_000;
  const joined = adapter.loadSnapshot(target);
  release();
  await Promise.all([slowLoad, joined]);
  assert.equal(inspectRunCalls, 1);
});

test("createInspectionViewerAdapter sweeps an in-flight snapshot that never settles", async () => {
  // `gh` children carry no timeout, so a hung handshake produces a promise that
  // neither resolves nor rejects. Without the in-flight ceiling that entry owns
  // its key for the process lifetime and every later render for that PR joins
  // the hung promise — a wedge the pre-cache behavior never had.
  let nowMs = Date.parse("2026-05-21T00:00:00.000Z");
  let inspectRunCalls = 0;
  const adapter = createInspectionViewerAdapter({
    nowImpl: () => nowMs,
    snapshotInflightCeilingMs: 60_000,
    inspectRunImpl: () => {
      inspectRunCalls += 1;
      return new Promise(() => {});
    },
  });
  const target = { repo: "owner/repo", pr: 55 };

  void adapter.loadSnapshot(target);
  assert.equal(inspectRunCalls, 1);

  nowMs += 30_000;
  void adapter.loadSnapshot(target);
  assert.equal(inspectRunCalls, 1, "inside the ceiling a later caller still joins the in-flight load");

  nowMs += 31_000;
  void adapter.loadSnapshot(target);
  assert.equal(inspectRunCalls, 2, "past the ceiling the wedged entry is swept and the load retries live");
});

test("createInspectionViewerAdapter never caches a failed snapshot load", async () => {
  let inspectRunCalls = 0;
  const adapter = createInspectionViewerAdapter({
    inspectRunImpl: async () => {
      inspectRunCalls += 1;
      throw new Error("gh exploded");
    },
  });
  const target = { repo: "owner/repo", pr: 55 };

  await assert.rejects(() => adapter.loadSnapshot(target), /gh exploded/);
  await assert.rejects(() => adapter.loadSnapshot(target), /gh exploded/);
  assert.equal(inspectRunCalls, 2);
});

test("createInspectionViewerAdapter caching can be disabled with snapshotCacheTtlMs 0", async () => {
  let inspectRunCalls = 0;
  const adapter = createInspectionViewerAdapter({
    snapshotCacheTtlMs: 0,
    inspectRunImpl: async () => {
      inspectRunCalls += 1;
      return { ok: true };
    },
  });

  await adapter.loadSnapshot({ repo: "owner/repo", pr: 55 });
  await adapter.loadSnapshot({ repo: "owner/repo", pr: 55 });
  assert.equal(inspectRunCalls, 2);
});

test("createInspectionViewerAdapter omits --updated when updatedWithinDays is null", async () => {
  const seenArgs = [];
  const adapter = createInspectionViewerAdapter({
    inspectRunImpl: async () => ({ ok: true }),
    runGhJsonImpl: async (args) => {
      seenArgs.push(args);
      return [];
    },
  });

  await adapter.listAssignedPullRequests({ repo: "owner/repo", updatedWithinDays: null });

  assert.deepEqual(seenArgs[0], [
    "search",
    "prs",
    "--assignee",
    "@me",
    "--repo",
    "owner/repo",
    "--state",
    "open",
    "--sort",
    "updated",
    "--order",
    "desc",
    "--limit",
    "25",
    "--json",
    "number,title,repository,updatedAt,state,isDraft",
  ]);
  for (const args of seenArgs) {
    assert.equal(args.includes("--updated"), false);
  }
});

test("createInspectionViewerAdapter shares one dot-signal fan-out between concurrent list refreshes", async () => {
  let signalCalls = 0;
  const adapter = createInspectionViewerAdapter({
    inspectRunImpl: async () => ({ ok: true }),
    runGhJsonImpl: async (args) => {
      if (args.includes("changes_requested") || args.includes("failure") || args.includes("pending") || args.includes("approved")) {
        signalCalls += 1;
        return [];
      }
      return [];
    },
  });

  // A page render overlapping an auto-reload tick must fire the 4 dot-signal
  // searches once, not twice.
  await Promise.all([
    adapter.listAssignedPullRequests({ repo: "owner/repo" }),
    adapter.listAssignedPullRequests({ repo: "owner/repo" }),
  ]);
  assert.equal(signalCalls, 4);
});

test("createInspectionViewerAdapter never caches a failed dot-signal fan-out", async () => {
  let signalCalls = 0;
  let failNextSignalQuery = true;
  const adapter = createInspectionViewerAdapter({
    inspectRunImpl: async () => ({ ok: true }),
    runGhJsonImpl: async (args) => {
      if (args.includes("changes_requested") || args.includes("failure") || args.includes("pending") || args.includes("approved")) {
        signalCalls += 1;
        if (failNextSignalQuery) {
          failNextSignalQuery = false;
          throw new Error("gh command failed: API rate limit exceeded");
        }
      }
      return [];
    },
  });

  // Without the eviction the rejected PROMISE stays cached for 5 minutes, so one
  // transient failure keeps the `⚠️ PR lookup failed` sidebar up long after the
  // limit cleared.
  await assert.rejects(
    adapter.listAssignedPullRequests({ repo: "owner/repo" }),
    /API rate limit exceeded/,
  );
  signalCalls = 0;

  await adapter.listAssignedPullRequests({ repo: "owner/repo" });
  assert.equal(signalCalls, 4);
});

test("createInspectionViewerAdapter refreshes expired assigned PR cache entries", async () => {
  let nowMs = Date.parse("2026-05-21T00:00:00.000Z");
  let ghCalls = 0;
  const adapter = createInspectionViewerAdapter({
    inspectRunImpl: async () => ({ ok: true }),
    nowImpl: () => nowMs,
    runGhJsonImpl: async (args) => {
      ghCalls += 1;
      if (args.includes("changes_requested") || args.includes("failure") || args.includes("pending") || args.includes("approved")) {
        return [];
      }
      return [
        {
          number: 55,
          title: "Primary PR",
          repository: { nameWithOwner: "owner/repo" },
          state: "OPEN",
          isDraft: false,
        },
      ];
    },
  });

  await adapter.listAssignedPullRequests({ repo: "owner/repo" });
  assert.equal(ghCalls, 5);

  await adapter.listAssignedPullRequests({ repo: "owner/repo" });
  assert.equal(ghCalls, 5);

  // List TTL expired, signal TTL (5 min) still fresh: the refresh costs the one
  // list query, not the full five.
  nowMs += 16_000;
  await adapter.listAssignedPullRequests({ repo: "owner/repo" });
  assert.equal(ghCalls, 6);

  // Past the signal TTL the four dot-signal queries refresh too.
  nowMs += 5 * 60_000;
  await adapter.listAssignedPullRequests({ repo: "owner/repo" });
  assert.equal(ghCalls, 11);
});

test("createInspectionViewerAdapter lists assigned open PRs for the current user", async () => {
  const seenArgs = [];
  const adapter = createInspectionViewerAdapter({
    inspectRunImpl: async () => ({ ok: true }),
    nowImpl: () => Date.parse("2026-05-21T00:00:00.000Z"),
    runGhJsonImpl: async (args) => {
      seenArgs.push(args);
      if (args.includes("changes_requested")) {
        return [
          { number: 77, repository: { owner: { login: "other" }, name: "repo" } },
        ];
      }
      if (args.includes("failure")) {
        return [];
      }
      if (args.includes("pending")) {
        return [];
      }
      if (args.includes("approved")) {
        return [
          { number: 55, repository: { nameWithOwner: "owner/repo" } },
        ];
      }
      return [
        {
          number: 77,
          title: "Needs attention PR",
          repository: { owner: { login: "other" }, name: "repo" },
          state: "OPEN",
          isDraft: false,
        },
        {
          number: 55,
          title: "Primary PR",
          repository: { nameWithOwner: "owner/repo" },
          state: "OPEN",
          isDraft: false,
        },
      ];
    },
  });

  const assigned = await adapter.listAssignedPullRequests({ repo: "owner/repo" });

  assert.deepEqual(seenArgs[0], [
    "search",
    "prs",
    "--assignee",
    "@me",
    "--repo",
    "owner/repo",
    "--state",
    "open",
    "--sort",
    "updated",
    "--order",
    "desc",
    "--updated",
    ">=2026-05-14",
    "--limit",
    "25",
    "--json",
    "number,title,repository,updatedAt,state,isDraft",
  ]);
  assert.equal(seenArgs.length, 5);
  assert.deepEqual(assigned, [
    { target: { repo: "other/repo", pr: 77 }, title: "Needs attention PR", updatedAt: null, signal: "attention" },
    { target: { repo: "owner/repo", pr: 55 }, title: "Primary PR", updatedAt: null, signal: "ready" },
  ]);
});

test("parseGhJsonOutput wraps invalid gh JSON deterministically", () => {
  assert.throws(
    () => parseGhJsonOutput("not json\n"),
    /Invalid JSON from gh: not json/,
  );
});

test("createInspectionViewerAdapter listAssignedPullRequests reports invalid gh JSON deterministically", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "inspect-viewer-gh-"));

  try {
    const fakeGh = path.join(dir, "fake-gh.sh");
    await writeFile(fakeGh, "#!/bin/sh\nprintf 'not json\n'\n", "utf8");
    await chmod(fakeGh, 0o755);

    const adapter = createInspectionViewerAdapter({
      inspectRunImpl: async () => ({ ok: true }),
    });

    await assert.rejects(
      () => adapter.listAssignedPullRequests({ repo: "owner/repo", ghCommand: fakeGh }),
      /Invalid JSON from gh: not json/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test("createInspectionViewerAdapter listAssignedPullRequests wraps malformed repo filters deterministically", async () => {
  const adapter = createInspectionViewerAdapter({
    inspectRunImpl: async () => ({ ok: true }),
    runGhJsonImpl: async () => {
      throw new Error("should not reach gh");
    },
  });

  await assert.rejects(
    () => adapter.listAssignedPullRequests({ repo: "owner" }),
    (error) => error?.code === "MALFORMED_TARGET" && /repo must match <owner\/name>/.test(String(error?.message)),
  );
});

test("createInspectionViewerAdapter listAssignedPullRequests skips malformed search rows", async () => {
  const adapter = createInspectionViewerAdapter({
    inspectRunImpl: async () => ({ ok: true }),
    runGhJsonImpl: async (args) => {
      if (args.includes("changes_requested") || args.includes("failure") || args.includes("pending") || args.includes("approved")) {
        return [];
      }
      return [
        { number: 0, repository: { nameWithOwner: "owner/repo" } },
        { number: 12, repository: null },
        { number: 44, repository: { owner: { login: "owner" }, name: "repo" }, state: "OPEN", isDraft: false },
      ];
    },
  });

  const assigned = await adapter.listAssignedPullRequests({ repo: "owner/repo" });
  assert.deepEqual(assigned, [
    { target: { repo: "owner/repo", pr: 44 }, title: null, updatedAt: null, signal: "waiting" },
  ]);
});

test("buildInspectionMermaidGraph renders full authoritative Mermaid state machines with current/next/terminal cues", () => {
  const graph = buildInspectionMermaidGraph(makeSnapshot({
    layers: {
      copilot: {
        currentState: "done",
        allowedTransitions: [],
      },
      reviewer: {
        currentState: "waiting_for_author_followup",
        scope: { mode: "all_reviewers", reviewerLogin: null },
        allowedTransitions: ["review_requested"],
      },
      steering: { status: "unavailable", reason: "no_steering_locator" },
    },
  }));

  assert.ok(graph);
  assert.match(graph.definition, /flowchart TB/);
  assert.match(graph.definition, /subgraph outer_loop_family\["outer-loop family"\]/);
  assert.match(graph.definition, /outer_loop_family_start\(\["Start"\]\)/);
  assert.match(graph.definition, /outer_loop_family_end\(\("End"\)\)/);
  assert.match(graph.definition, /outer_loop_family_continue_current_wait\["continue current wait"\]/);
  assert.match(graph.definition, /copilot_layer_start\(\["Start"\]\)/);
  assert.match(graph.definition, /reviewer_layer_start\(\["Start"\]\)/);
  assert.match(graph.definition, /copilot_layer_no_pr\["no_pr"\]/);
  assert.match(graph.definition, /copilot_layer_ready_to_rerequest_review\["ready_to_rerequest_review"\]/);
  assert.match(graph.definition, /reviewer_layer_review_requested\["review_requested"\]/);
  assert.match(graph.definition, /reviewer_layer_waiting_for_re_request\["waiting_for_re_request"\]/);
  assert.match(graph.definition, /layer view/);
  assert.match(graph.definition, /next evaluation may resolve to any shown state/);
  assert.match(graph.definition, /class outer_loop_family_continue_current_wait,reviewer_layer_waiting_for_author_followup,lifecycle_layer_implementation current;/);
  assert.match(graph.definition, /class copilot_layer_done currentTerminal;/);
  assert.match(graph.definition, /class [^\n]*reviewer_layer_review_requested[^\n]* next;/);
});

test("buildInspectionMermaidGraph covers every exported outer, Copilot, and reviewer state and edge", () => {
  const graph = buildInspectionMermaidGraph(makeSnapshot());

  assert.ok(graph);

  for (const state of Object.values(OUTER_STATE)) {
    const humanized = state.replaceAll("_", " ");
    assert.match(graph.definition, new RegExp(`outer_loop_family_${state}\\["${humanized}"\\]`));
  }
  for (const [state, nextStates] of Object.entries(OUTER_TRANSITIONS)) {
    if (nextStates.length === 0) {
      assert.match(graph.definition, new RegExp(`outer_loop_family_${state} --> outer_loop_family_end`));
      continue;
    }
    for (const nextState of nextStates) {
      assert.match(graph.definition, new RegExp(`outer_loop_family_${state} --> outer_loop_family_${nextState}`));
    }
  }

  for (const state of Object.values(COPILOT_STATE)) {
    assert.match(graph.definition, new RegExp(`copilot_layer_${state}\\["${state}"\\]`));
  }
  for (const [state, nextStates] of Object.entries(COPILOT_TRANSITIONS)) {
    if (nextStates.length === 0) {
      assert.match(graph.definition, new RegExp(`copilot_layer_${state} --> copilot_layer_end`));
      continue;
    }
    for (const nextState of nextStates) {
      assert.match(graph.definition, new RegExp(`copilot_layer_${state} --> copilot_layer_${nextState}`));
    }
  }

  for (const state of Object.values(REVIEWER_STATE)) {
    assert.match(graph.definition, new RegExp(`reviewer_layer_${state}\\["${state}"\\]`));
  }
  for (const [state, nextStates] of Object.entries(REVIEWER_TRANSITIONS)) {
    if (nextStates.length === 0) {
      assert.match(graph.definition, new RegExp(`reviewer_layer_${state} --> reviewer_layer_end`));
      continue;
    }
    for (const nextState of nextStates) {
      assert.match(graph.definition, new RegExp(`reviewer_layer_${state} --> reviewer_layer_${nextState}`));
    }
  }
});

test("buildInspectionMermaidGraph fails closed for invalid next-state highlights", () => {
  const graph = buildInspectionMermaidGraph(makeSnapshot({
    layers: {
      copilot: {
        currentState: "waiting_for_copilot_review",
        allowedTransitions: ["done"],
      },
      reviewer: {
        currentState: "unknown",
        scope: { mode: "all_reviewers", reviewerLogin: null },
        allowedTransitions: ["review_requested"],
      },
      steering: { status: "unavailable", reason: "no_steering_locator" },
    },
  }));

  assert.ok(graph);
  assert.doesNotMatch(graph.definition, /class [^\n]*copilot_layer_done nextTerminal;/);
  assert.doesNotMatch(graph.definition, /class [^\n]*reviewer_layer_review_requested next;/);
});


test("buildInspectionMermaidGraph normalizes and de-duplicates transition tokens before highlighting", () => {
  const snapshot = makeSnapshot({
    layers: {
      copilot: {
        currentState: "waiting_for_copilot_review",
        allowedTransitions: [" waiting_for_ci ", "waiting_for_ci", " ready_to_rerequest_review "],
      },
      reviewer: {
        currentState: "waiting_for_author_followup",
        scope: { mode: "all_reviewers", reviewerLogin: null },
        allowedTransitions: ["waiting_for_re_request"],
      },
      steering: { status: "unavailable", reason: "no_steering_locator" },
    },
  });

  const graph = buildInspectionMermaidGraph(snapshot);
  const html = renderInspectRunViewerHtml({
    repo: "owner/repo",
    target: { repo: "owner/repo", pr: 55 },
    snapshot,
  });

  assert.ok(graph);
  assert.match(graph.definition, /class [^\n]*copilot_layer_waiting_for_ci[^\n]* next;/);
  assert.match(graph.definition, /class [^\n]*copilot_layer_ready_to_rerequest_review[^\n]* next;/);
  assert.match(html, /copilot layer:[\s\S]*full authoritative state machine shown; waiting_for_ci, ready_to_rerequest_review/);
  assert.doesNotMatch(html, /waiting_for_ci,\s*waiting_for_ci/);
});
test("MERMAID_BROWSER_ASSET_PATH points at the vendored mermaid bundle and the file matches the mermaid@11.15.0 pin", async () => {
  assert.match(MERMAID_BROWSER_ASSET_PATH, /scripts[\\/]loop[\\/]inspect-run-viewer[\\/]vendor[\\/]mermaid\.min\.js$/);
  const assetStat = await stat(MERMAID_BROWSER_ASSET_PATH);
  assert.ok(assetStat.isFile());
  // sha256 of mermaid@11.15.0 dist/mermaid.min.js — the vendored bundle pin.
  const MERMAID_11_15_0_DIST_SHA256 = "70137e77bb273bb2ef972b86e8b0400cca8be53cb25bfc45911a186dc98665de";
  const digest = createHash("sha256").update(await readFile(MERMAID_BROWSER_ASSET_PATH)).digest("hex");
  assert.equal(digest, MERMAID_11_15_0_DIST_SHA256);
});
test("loadMermaidBrowserScript clears failed cache entries so later retries can recover", async () => {
  let callCount = 0;
  resetMermaidBrowserScriptCache();

  try {
    await assert.rejects(
      () => loadMermaidBrowserScript({
        readFileImpl: async () => {
          callCount += 1;
          throw new Error("missing mermaid asset");
        },
      }),
      /missing mermaid asset/,
    );

    const firstSuccess = await loadMermaidBrowserScript({
      readFileImpl: async () => {
        callCount += 1;
        return "mermaid browser bundle";
      },
    });
    const secondSuccess = await loadMermaidBrowserScript({
      readFileImpl: async () => {
        callCount += 1;
        return "should stay cached";
      },
    });

    assert.equal(firstSuccess, "mermaid browser bundle");
    assert.equal(secondSuccess, "mermaid browser bundle");
    assert.equal(callCount, 2);
  } finally {
    resetMermaidBrowserScriptCache();
  }
});

test("parseInspectRunViewerCliArgs normalizes repo values and rejects malformed input with usage", () => {
  const parsed = parseInspectRunViewerCliArgs(["--repo", "  owner/repo  "]);
  assert.equal(parsed.repo, "owner/repo");
  assert.equal("pr" in parsed, false);

  const unscoped = parseInspectRunViewerCliArgs([]);
  assert.equal(unscoped.repo, undefined);
  assert.equal("pr" in unscoped, false);

  const bracketedIpv6Host = parseInspectRunViewerCliArgs(["--repo", "owner/repo", "--host", "[::1]"]);
  assert.equal(bracketedIpv6Host.host, "::1");

  assert.throws(
    () => parseInspectRunViewerCliArgs(["--repo", "owner/repo", "--host", "0.0.0.0"]),
    /--host must stay on localhost\/loopback unless --allow-non-localhost is set/i,
  );

  const nonLocalhostOptIn = parseInspectRunViewerCliArgs([
    "--repo",
    "owner/repo",
    "--host",
    "0.0.0.0",
    "--allow-non-localhost",
    "--restart",
  ]);
  assert.equal(nonLocalhostOptIn.host, "0.0.0.0");
  assert.equal(nonLocalhostOptIn.allowNonLocalhost, true);
  assert.equal(nonLocalhostOptIn.restart, true);

  let malformedTargetError;
  try {
    parseInspectRunViewerCliArgs(["--repo", "../../bad"]);
  } catch (error) {
    malformedTargetError = error;
  }
  assert.ok(malformedTargetError instanceof Error);
  assert.match(malformedTargetError.message, /Invalid repository slug|owner\/name|Repository slug/i);
  assert.equal(typeof malformedTargetError.usage, "string");
  assert.ok(malformedTargetError.usage.length > 0);
  assert.match(malformedTargetError.usage, /Usage: inspect-run-viewer\.mjs \[--repo <owner\/name>\]/);

  assert.throws(
    () => parseInspectRunViewerCliArgs(["--repo", "owner/repo", "--pr", "55"]),
    /--pr is no longer supported on the CLI/i,
  );
  assert.throws(
    () => parseInspectRunViewerCliArgs(["--repo", "owner/repo", "--host", "   "]),
    /--host must not be empty/i,
  );
});

test("restartExistingPortListener is a no-op when nothing is listening", async () => {
  const restarted = await restartExistingPortListener(4311, {
    listListeningPidsImpl: async () => [],
  });

  assert.deepEqual(restarted, []);
});


test("listListeningPidsForPort only treats empty-stderr lsof exit 1 as no listeners", async () => {
  const emptyResult = await listListeningPidsForPort(4311, {
    execFileImpl: async () => {
      const error = new Error("no listeners");
      error.code = 1;
      error.stderr = "";
      throw error;
    },
  });

  assert.deepEqual(emptyResult, []);

  await assert.rejects(
    () => listListeningPidsForPort(4311, {
      execFileImpl: async () => {
        const error = new Error("unsupported flag");
        error.code = 1;
        error.stderr = "lsof: illegal option";
        throw error;
      },
    }),
    /unsupported flag/,
  );
});

test("restartExistingPortListener stops existing listeners on the chosen port", async () => {
  const killed = [];
  let pollCount = 0;

  const restarted = await restartExistingPortListener(4311, {
    listListeningPidsImpl: async () => {
      pollCount += 1;
      return pollCount === 1 ? [111, 222] : [];
    },
    killProcessImpl: (pid, signal) => {
      killed.push([pid, signal]);
    },
    sleepImpl: async () => {},
  });

  assert.deepEqual(restarted, [111, 222]);
  assert.deepEqual(killed, [
    [111, "SIGTERM"],
    [222, "SIGTERM"],
  ]);
});


test("restartExistingPortListener tolerates listeners that exit before SIGTERM", async () => {
  const killed = [];
  let pollCount = 0;

  const restarted = await restartExistingPortListener(4311, {
    listListeningPidsImpl: async () => {
      pollCount += 1;
      return pollCount === 1 ? [111, 222] : [];
    },
    killProcessImpl: (pid, signal) => {
      killed.push([pid, signal]);
      if (pid === 111) {
        const error = new Error("process already exited");
        error.code = "ESRCH";
        throw error;
      }
    },
    sleepImpl: async () => {},
  });

  assert.deepEqual(restarted, [111, 222]);
  assert.deepEqual(killed, [
    [111, "SIGTERM"],
    [222, "SIGTERM"],
  ]);
});


test("restartExistingPortListener waits for the port to become free, not for the process to exit", async () => {
  const killed = [];
  let pollCount = 0;

  const restarted = await restartExistingPortListener(4311, {
    listListeningPidsImpl: async () => {
      pollCount += 1;
      return pollCount === 1 ? [111] : [];
    },
    killProcessImpl: (pid, signal) => {
      killed.push([pid, signal]);
    },
    sleepImpl: async () => {},
  });

  assert.deepEqual(restarted, [111]);
  assert.deepEqual(killed, [[111, "SIGTERM"]]);
  assert.equal(pollCount, 2);
});

test("formatInspectRunViewerUrl formats IPv4 and IPv6 hosts for copy-pasteable output", () => {
  assert.equal(formatInspectRunViewerUrl("127.0.0.1", 4311), "http://127.0.0.1:4311");
  assert.equal(formatInspectRunViewerUrl("::1", 4311), "http://[::1]:4311");
  assert.equal(formatInspectRunViewerUrl("[::1]", 4311), "http://[::1]:4311");
  assert.equal(formatInspectRunViewerUrl("0.0.0.0", 4311), "http://0.0.0.0:4311");
});
test("runCli explains missing lsof when --restart is requested", async () => {
  await assert.rejects(
    () => runCli([
      "--repo",
      "owner/repo",
      "--restart",
    ], {
      stdout: { write() {} },
      restartExistingPortListenerImpl: async () => {
        const error = new Error("spawn lsof ENOENT");
        error.code = "ENOENT";
        error.path = "lsof";
        throw error;
      },
    }),
    (error) => {
      assert.match(error.message, /--restart requires lsof\/POSIX support/i);
      assert.equal(typeof error.usage, "string");
      assert.match(error.usage, /--restart/);
      return true;
    },
  );
});
