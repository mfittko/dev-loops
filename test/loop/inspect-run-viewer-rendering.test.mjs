import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  buildInspectionMermaidGraph,
  renderInspectRunViewerHtml,
} from "../../scripts/loop/inspect-run-viewer.mjs";
import { makeSnapshot } from "./inspect-run-viewer-test-helpers.mjs";
test("renderInspectRunViewerHtml keeps the empty inbox copy generic across state and paging filters", () => {
  const html = renderInspectRunViewerHtml({
    repo: null,
    target: null,
    snapshot: null,
    inboxItems: [],
    inboxUpdatedWithinDays: null,
    inboxState: "all",
    inboxPage: 3,
    inboxTotalPages: 5,
  });

  assert.match(html, /No PR selected/);
  assert.match(html, /inspect-run remains authoritative for inspection\/status state while this UI owns inbox discovery plus read-only presentation\/prioritization/i);
  assert.match(html, /No assigned PR in all repos matched the current view yet\./);
  assert.match(html, /widen the state or updated filters, or move to another inbox page\./);
  assert.match(html, /<title>all repos PR inspection dashboard<\/title>/);
  assert.match(html, /aria-label="all repos PR inspection dashboard"/);
  assert.doesNotMatch(html, /assigned open PR/i);
  assert.doesNotMatch(html, /limit filters/i);
});

test("renderInspectRunViewerHtml keeps scope selection and retained target when repo casing differs", () => {
  const html = renderInspectRunViewerHtml({
    repo: "Owner/Repo",
    target: { repo: "owner/repo", pr: 55 },
    snapshot: makeSnapshot(),
    scopeOptions: ["owner/repo", "other/repo"],
    inboxItems: [
      {
        target: { repo: "owner/repo", pr: 55 },
        title: "Selected PR",
        snapshot: makeSnapshot(),
      },
    ],
  });

  assert.match(html, /<option value="\/\?scope=owner%2Frepo&amp;repo=owner%2Frepo&amp;pr=55&amp;state=open&amp;mode=assignee" selected>owner\/repo<\/option>/);
  assert.match(html, /<option value="\/\?scope=other%2Frepo&amp;state=open&amp;mode=assignee" >other\/repo<\/option>/);
});


test("renderInspectRunViewerHtml de-dupes scope options case-insensitively", () => {
  const html = renderInspectRunViewerHtml({
    repo: "Owner/Repo",
    target: { repo: "owner/repo", pr: 55 },
    snapshot: makeSnapshot(),
    scopeOptions: [" Owner/Repo ", "owner/repo", "other/repo"],
    inboxItems: [
      {
        target: { repo: "owner/repo", pr: 55 },
        title: "Selected PR",
        snapshot: makeSnapshot(),
      },
    ],
  });

  assert.equal(html.match(/<option[^>]*>Owner\/Repo<\/option>/g)?.length ?? 0, 1);
  assert.equal(html.match(/<option[^>]*>owner\/repo<\/option>/g)?.length ?? 0, 0);
  assert.match(html, /<option value="\/\?scope=other%2Frepo&amp;state=open&amp;mode=assignee" >other\/repo<\/option>/);
});

test("renderInspectRunViewerHtml keeps inbox selection stable when repo casing differs", () => {
  const html = renderInspectRunViewerHtml({
    repo: "Owner/Repo",
    target: { repo: "Owner/Repo", pr: 55 },
    snapshot: makeSnapshot(),
    scopeOptions: ["owner/repo"],
    inboxItems: [
      {
        target: { repo: "owner/repo", pr: 55 },
        title: "Selected PR",
        snapshot: makeSnapshot(),
      },
    ],
  });

  assert.match(html, /class="assigned-pr-row assigned-pr-row-waiting is-selected"/);
  assert.match(html, /href="\/\?scope=Owner%2FRepo&amp;repo=owner%2Frepo&amp;pr=55&amp;state=open&amp;mode=assignee" aria-current="page"/);
});

test("renderInspectRunViewerHtml hides pagination controls in the collapsed sidebar", () => {
  const html = renderInspectRunViewerHtml({
    repo: "owner/repo",
    target: { repo: "owner/repo", pr: 55 },
    snapshot: makeSnapshot(),
    scopeOptions: ["owner/repo"],
    inboxItems: [
      {
        target: { repo: "owner/repo", pr: 55 },
        title: "Selected PR",
        snapshot: makeSnapshot(),
      },
    ],
    inboxTotalPages: 2,
  });

  assert.match(html, /\.assigned-pr-inbox\[data-sidebar-collapsed="true"\] \.assigned-pr-pagination \{ display: none; \}/);
});

test("renderInspectRunViewerHtml keeps overview first and tab buttons aligned with tab panels", () => {
  const html = renderInspectRunViewerHtml({
    repo: "owner/repo",
    target: { repo: "owner/repo", pr: 55 },
    snapshot: makeSnapshot(),
    inboxItems: [
      {
        target: { repo: "owner/repo", pr: 55 },
        title: "Selected PR",
        snapshot: makeSnapshot(),
      },
    ],
  });

  assert.match(html, /<button id="tab-btn-overview" class="viewer-tab active"[^>]*aria-controls="tab-overview"[^>]*>Overview<\/button>\s*<button id="tab-btn-graph" class="viewer-tab"[^>]*aria-controls="tab-graph"[^>]*>Graph<\/button>\s*<button id="tab-btn-layers" class="viewer-tab"[^>]*aria-controls="tab-layers"[^>]*>Layers<\/button>\s*<button id="tab-btn-handoff" class="viewer-tab"[^>]*aria-controls="tab-handoff"[^>]*>Agent handoff<\/button>/);
  assert.match(html, /<div class="tab-content active" id="tab-overview" role="tabpanel" aria-labelledby="tab-btn-overview">/);
  assert.match(html, /<div class="tab-content" id="tab-graph" role="tabpanel" aria-labelledby="tab-btn-graph">/);
  assert.match(html, /document\.dispatchEvent\(new CustomEvent\('inspect-run-viewer:tabchange', \{ detail: \{ tabName \} \}\)\);/);
  assert.match(html, /document\.addEventListener\("inspect-run-viewer:tabchange", \(\) => \{/);
});

test("renderInspectRunViewerHtml renders required top-level fields for authoritative snapshot and links to raw JSON", () => {
  const html = renderInspectRunViewerHtml({
    repo: "owner/repo",
    target: { repo: "owner/repo", pr: 55 },
    snapshot: makeSnapshot(),
    inboxItems: [
      {
        target: { repo: "owner/repo", pr: 55 },
        title: "Selected PR",
        snapshot: makeSnapshot(),
      },
      {
        target: { repo: "other/repo", pr: 77 },
        title: "Waiting PR",
        snapshot: makeSnapshot({
          target: { repo: "other/repo", pr: 77 },
          statusClass: "blocked",
          needsAttention: true,
          layers: {
            copilot: {
              currentState: "unresolved_feedback_present",
              allowedTransitions: ["already_fixed_needs_reply_resolve"],
            },
            reviewer: {
              currentState: "waiting_for_author_followup",
              scope: { mode: "all_reviewers", reviewerLogin: null },
              allowedTransitions: ["waiting_for_re_request"],
            },
            steering: { status: "unavailable", reason: "no_steering_locator" },
          },
        }),
      },
    ],
    inboxPage: 1,
    inboxTotalPages: 2,
  });

  assert.match(html, /PR inspection dashboard/);
  assert.match(html, /Search PRs/);
  assert.match(html, /id="assigned-pr-mode-select"[^>]*aria-label="Assignment mode"/);
  assert.match(html, /<label class="assigned-pr-filter-label" for="assigned-pr-state-select">State<\/label>/);
  assert.match(html, /id="assigned-pr-updated-select"[^>]*aria-label="Updated window"/);
  assert.match(html, /grid-template-columns: auto minmax\(0, 1fr\)/);
  assert.match(html, /\.assigned-pr-inbox \{[^}]*width: 22rem;[^}]*box-sizing: border-box;/);
  assert.match(html, /\.assigned-pr-row\.is-selected \.assigned-pr-link \{ box-shadow: inset 0 0 0 1px #1565c0; border-radius: 0\.3rem; \}/);
  assert.doesNotMatch(html, /\.assigned-pr-row\.is-selected \{[^}]*border-color:/);
  assert.match(html, /data-inbox-search/);
  assert.match(html, /inbox-collapse-toggle/);
  assert.match(html, />◀<\/button>/);
  assert.match(html, /\.inbox-collapse-toggle \{[^}]*background: #355061;[^}]*color: #fff;/);
  assert.match(html, /data-inbox-item/);
  assert.match(html, /data-empty-default="No assigned PRs are visible in this view\."/);
  assert.match(html, /data-empty-search="No assigned PRs match this search\."/);
  assert.match(html, /aria-current="page"/);
  assert.ok(html.indexOf('class="assigned-pr-list"') < html.indexOf('class="assigned-pr-pagination"'));
  assert.match(html, /aria-label="Previous page"/);
  assert.match(html, /aria-label="Next page"/);
  assert.doesNotMatch(html, /assigned-pr-title-indicator/);
  assert.match(html, /pr=77/);
  assert.match(html, /<a href="https:\/\/github\.com\/owner\/repo\/pull\/55">owner\/repo#55<\/a>/);
  assert.match(html, /<h1>Selected PR<\/h1>/);
  assert.match(html, /aria-label="PR #55"/);
  assert.match(html, /<div class="current-pr-state-copy-flow">/);
  assert.match(html, /class="viewer-card-body"/);
  assert.match(html, /title="Waiting state"/);
  assert.match(html, /⏳/);
  assert.match(html, /Waiting for Copilot review/);
  assert.match(html, /Copilot review has been requested and the PR is waiting for new review activity/);
  assert.match(html, /status class/);
  assert.match(html, /outer state/);
  assert.match(html, /outerAction/);
  assert.match(html, /Copilot state/);
  assert.match(html, /reviewer state/);
  assert.match(html, /reviewer verdict/);
  assert.match(html, /Next action and key metrics/);
  assert.match(html, /Graph guide and lane details/);
  assert.match(html, /data-tab="graph"/);
  assert.match(html, /data-tab="overview"/);
  assert.match(html, /data-tab="layers"/);
  assert.match(html, /data-tab="handoff"/);
  assert.match(html, /Graph<\/button>/);
  assert.match(html, /Overview<\/button>/);
  assert.match(html, /Layers<\/button>/);
  assert.doesNotMatch(html, /Live view/);
  assert.match(html, /owner\/repo#55/);
  assert.match(html, /pr-55/);
  assert.match(html, /activeStateFamily/);
  assert.match(html, /outerAction/);
  assert.match(html, /activeFamilyState/);
  assert.match(html, /statusClass/);
  assert.match(html, /needsAttention/);
  assert.match(html, /sourceMode/);
  assert.match(html, /markers\.missing/);
  assert.match(html, /markers\.stale/);
  assert.match(html, /markers\.conflicts/);
  assert.doesNotMatch(html, /authoritative graph view from the current inspection snapshot/i);
  assert.match(html, /class="state-graph-cues"/);
  assert.match(html, /class="mermaid-state-graph mermaid"/);
  assert.match(html, /data-graph-zoom-in/);
  assert.match(html, /data-graph-zoom-out/);
  assert.match(html, /data-graph-zoom-reset/);
  assert.match(html, /data-graph-fullscreen/);
  assert.match(html, /if \(!svg\) \{\s*resolve\(false\);\s*return;\s*\}/);
  assert.match(html, /if \(targetRects\.length === 0\) \{\s*resolve\(false\);\s*return;\s*\}/);
  assert.match(html, /const \[firstRect, \.\.\.remainingRects\] = targetRects;/);
  assert.match(html, /cursor: grab/);
  assert.match(html, /data-dragging="true"/);
  assert.match(html, /\.viewer-card-body,/);
  assert.match(html, /\.current-pr-state-copy-flow \{ display: grid; gap: 0\.7rem; min-width: 0; \}/);
  assert.match(html, /pre \{ margin: 0; padding: 0\.95rem 1rem;/);
  assert.match(html, /assets\/mermaid\.min\.js/);
  assert.match(html, /Start/);
  assert.match(html, /End/);
  assert.match(html, /Next/);
  assert.match(html, /🔁/);
  assert.match(html, /outer-loop family:[\s\S]*current <code>continue_current_wait<\/code>; continue_current_wait; full authoritative state machine shown; continue_current_wait, handoff_to_copilot_loop, handoff_to_reviewer_loop, stay_with_current_live_owner, stop_needs_human, done_terminal, needs_reconcile/);
  assert.match(html, /copilot layer:[\s\S]*full authoritative state machine shown; unresolved_feedback_present, ready_to_rerequest_review, waiting_for_ci/);
  assert.match(html, /reviewer layer:[\s\S]*full authoritative state machine shown; waiting_for_re_request, waiting_for_review_request/);
  assert.match(html, /Dimmed nodes are still part of the authoritative state machine/);
  assert.ok(html.indexOf('class="mermaid-state-graph mermaid"') < html.indexOf('class="state-graph-cues"'));
  assert.match(html, /outer lane comes from the shared authoritative outer-loop graph contract/);
  assert.match(html, /Outer-loop/);
  assert.match(html, /Copilot loop iterations/);
  assert.match(html, /4 completed, 1 pending/);
  assert.match(html, /fix commits: 3/);
  assert.match(html, /Copilot/);
  assert.match(html, /Reviewer/);
  assert.match(html, /Steering/);
  assert.doesNotMatch(html, /Connected state map/);
  assert.doesNotMatch(html, /"schemaVersion": 1/);
  assert.doesNotMatch(html, /"ok": true/);
});

test("renderInspectRunViewerHtml escapes selected titles before inserting the banner heading", () => {
  const html = renderInspectRunViewerHtml({
    repo: "owner/repo",
    target: { repo: "owner/repo", pr: 55 },
    snapshot: makeSnapshot(),
    selectedTitle: '<img src=x onerror="alert(1)">',
  });

  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.doesNotMatch(html, /<h1><img src=x onerror="alert\(1\)"><\/h1>/);
});

test("renderInspectRunViewerHtml keeps selected handoff-to-copilot rows on the attention border", () => {
  const html = renderInspectRunViewerHtml({
    repo: null,
    target: { repo: "owner/repo", pr: 3 },
    snapshot: makeSnapshot({
      target: { repo: "owner/repo", pr: 3 },
      outerState: "handoff_to_copilot_loop",
      outerAction: "reenter_copilot_loop",
      activeFamilyState: "reenter_copilot_loop",
      statusClass: "active",
      needsAttention: false,
      layers: {
        copilot: {
          currentState: "review_requested",
          allowedTransitions: ["determine_review_plan"],
        },
        reviewer: {
          currentState: "waiting_for_review_request",
          scope: { mode: "all_reviewers", reviewerLogin: null },
          allowedTransitions: ["review_requested"],
        },
        steering: { status: "unavailable", reason: "no_steering_locator" },
      },
    }),
    inboxItems: [
      { target: { repo: "owner/repo", pr: 3 }, title: "docs: add IAM policy guide", updatedAt: "2026-05-22T00:00:00Z" },
    ],
  });

  assert.match(html, /assigned-pr-row-attention/);
  assert.match(html, /is-selected/);
  assert.match(html, /Copilot loop needs action/);
  assert.match(html, /title="Active loop"/);
  assert.match(html, /🔁/);
});

test("renderInspectRunViewerHtml shows waiting inbox signal when outer routing hands off a waiting Copilot state", () => {
  const waitingSnapshot = makeSnapshot({
    target: { repo: "owner/repo", pr: 3 },
    outerState: "handoff_to_reviewer_loop",
    outerAction: "reenter_reviewer_loop",
    activeFamilyState: "reenter_reviewer_loop",
    statusClass: "active",
    needsAttention: false,
    layers: {
      copilot: {
        currentState: "waiting_for_copilot_review",
        allowedTransitions: ["unresolved_feedback_present", "ready_to_rerequest_review", "waiting_for_ci"],
      },
      reviewer: {
        currentState: "review_requested",
        scope: { mode: "all_reviewers", reviewerLogin: null },
        allowedTransitions: ["waiting_for_author_followup"],
      },
      steering: { status: "unavailable", reason: "no_steering_locator" },
    },
  });
  const html = renderInspectRunViewerHtml({
    repo: null,
    target: { repo: "owner/repo", pr: 3 },
    snapshot: waitingSnapshot,
    inboxItems: [
      { target: { repo: "owner/repo", pr: 3 }, title: "fix: wait signal", updatedAt: "2026-05-22T00:00:00Z", snapshot: waitingSnapshot },
    ],
  });

  assert.match(html, /assigned-pr-row assigned-pr-row-waiting is-selected/);
  assert.match(html, /data-inbox-signal="waiting"/);
  assert.match(html, /<span class="assigned-pr-signal-emoji" aria-label="Waiting">⏳<\/span>/);
  assert.match(html, /title="Waiting state"/);
});

test("renderInspectRunViewerHtml does not headline waiting_for_ci when reviewer loop is the authoritative owner", () => {
  const reviewerActiveSnapshot = makeSnapshot({
    target: { repo: "owner/repo", pr: 7 },
    outerState: "handoff_to_reviewer_loop",
    outerAction: "reenter_reviewer_loop",
    activeFamilyState: "reenter_reviewer_loop",
    statusClass: "active",
    needsAttention: false,
    layers: {
      copilot: {
        currentState: "waiting_for_ci",
        allowedTransitions: ["ready_to_rerequest_review"],
      },
      reviewer: {
        currentState: "review_requested",
        scope: { mode: "all_reviewers", reviewerLogin: null },
        allowedTransitions: ["determine_review_plan"],
        submittedReviewState: "APPROVED",
      },
      steering: { status: "unavailable", reason: "no_steering_locator" },
    },
  });

  const html = renderInspectRunViewerHtml({
    repo: null,
    target: { repo: "owner/repo", pr: 7 },
    snapshot: reviewerActiveSnapshot,
    inboxItems: [
      { target: { repo: "owner/repo", pr: 7 }, title: "fix: reviewer beats ci wait", updatedAt: "2026-05-22T00:00:00Z", snapshot: reviewerActiveSnapshot },
    ],
  });

  assert.match(html, /<p class="current-pr-state-summary-headline"><strong>Reviewer loop active<\/strong><\/p>/);
  assert.match(html, /<span class="assigned-pr-headline">Reviewer loop active<\/span>/);
  assert.doesNotMatch(html, /<p class="current-pr-state-summary-headline"><strong>Waiting for CI<\/strong><\/p>/);
  assert.doesNotMatch(html, /<span class="assigned-pr-headline">Waiting for CI<\/span>/);
});

test("renderInspectRunViewerHtml uses a gate inbox signal when clean convergence still needs gate evidence", () => {
  const gateSnapshot = makeSnapshot({
    target: { repo: "owner/repo", pr: 55 },
    outerState: "continue_current_wait",
    outerAction: "continue_wait",
    activeFamilyState: "continue_wait",
    statusClass: "waiting",
    needsAttention: false,
    layers: {
      copilot: {
        currentState: "ready_to_rerequest_review",
        allowedTransitions: ["waiting_for_copilot_review", "review_request_unavailable", "done"],
        sameHeadCleanConverged: true,
        loopDisposition: "clean_converged",
        terminal: true,
      },
      reviewer: {
        currentState: "waiting_for_author_followup",
        submittedReviewState: "APPROVED",
        approvedOnCurrentHead: true,
        scope: { mode: "all_reviewers", reviewerLogin: null },
        allowedTransitions: ["waiting_for_re_request", "waiting_for_review_request"],
      },
      steering: { status: "unavailable", reason: "no_steering_locator" },
    },
  });

  const html = renderInspectRunViewerHtml({
    repo: null,
    target: { repo: "owner/repo", pr: 55 },
    snapshot: gateSnapshot,
    inboxItems: [
      { target: { repo: "owner/repo", pr: 55 }, title: "fix: gate signal", updatedAt: "2026-05-22T00:00:00Z", snapshot: gateSnapshot },
    ],
  });

  assert.match(html, /assigned-pr-row assigned-pr-row-gate is-selected/);
  assert.match(html, /data-inbox-signal="gate"/);
  assert.match(html, /<span class="assigned-pr-signal-emoji" aria-label="Gate review required">🛡️<\/span>/);
  assert.match(html, /Gate review required/);
});

test("renderInspectRunViewerHtml keeps hard attention ahead of waiting layer inbox signals", () => {
  const attentionSnapshot = makeSnapshot({
    target: { repo: "owner/repo", pr: 3 },
    outerState: "needs_reconcile",
    outerAction: "stop",
    activeFamilyState: "stop",
    statusClass: "blocked",
    needsAttention: true,
    layers: {
      copilot: {
        currentState: "waiting_for_copilot_review",
        allowedTransitions: ["unresolved_feedback_present", "ready_to_rerequest_review", "waiting_for_ci"],
      },
      reviewer: {
        currentState: "waiting_for_author_followup",
        scope: { mode: "all_reviewers", reviewerLogin: null },
        allowedTransitions: ["waiting_for_re_request"],
      },
      steering: { status: "unavailable", reason: "no_steering_locator" },
    },
  });
  const html = renderInspectRunViewerHtml({
    repo: null,
    target: { repo: "owner/repo", pr: 3 },
    snapshot: attentionSnapshot,
    inboxItems: [
      { target: { repo: "owner/repo", pr: 3 }, title: "fix: attention signal", updatedAt: "2026-05-22T00:00:00Z", snapshot: attentionSnapshot },
    ],
  });

  assert.match(html, /assigned-pr-row assigned-pr-row-attention is-selected/);
  assert.match(html, /data-inbox-signal="attention"/);
  assert.match(html, /<span class="assigned-pr-signal-emoji" aria-label="Needs attention">🔴<\/span>/);
});

test("renderInspectRunViewerHtml keeps selected closed inbox rows on the closed border", () => {
  const html = renderInspectRunViewerHtml({
    repo: null,
    target: { repo: "owner/repo", pr: 3 },
    snapshot: makeSnapshot({
      target: { repo: "owner/repo", pr: 3 },
      outerState: "continue_current_wait",
      outerAction: "continue_wait",
      activeFamilyState: "continue_wait",
      statusClass: "waiting",
      needsAttention: false,
    }),
    inboxItems: [
      {
        target: { repo: "owner/repo", pr: 3 },
        title: "docs: add IAM policy guide",
        updatedAt: "2026-05-22T00:00:00Z",
        signal: "closed",
        snapshot: makeSnapshot({
          target: { repo: "owner/repo", pr: 3 },
          outerState: "continue_current_wait",
          outerAction: "continue_wait",
          activeFamilyState: "continue_wait",
          statusClass: "waiting",
          needsAttention: false,
        }),
      },
    ],
  });

  assert.match(html, /assigned-pr-row-closed/);
  assert.match(html, /data-inbox-signal="closed"/);
  assert.match(html, /is-selected/);
  assert.match(html, /Waiting for Copilot review/);
});

test("renderInspectRunViewerHtml renders checkpoint-only \/ degraded cues and absent sections", () => {
  const html = renderInspectRunViewerHtml({
    repo: "owner/repo",
    target: { repo: "owner/repo", pr: 55 },
    snapshot: makeSnapshot({
      sourceMode: "checkpoint-only",
      trust: "checkpoint",
      needsAttention: true,
      outerState: "unknown",
      allowedTransitions: undefined,
      outerAction: "unknown",
      activeFamilyState: "unknown",
      statusClass: "unknown",
      loopIterations: {
        available: false,
        source: "github_pr_timeline",
        reason: "no_copilot_review_history",
      },
      layers: {
        steering: { status: "unavailable", reason: "no_steering_file" },
      },
    }),
  });

  assert.match(html, /checkpoint-only/);
  assert.doesNotMatch(html, /checkpoint-only graph view[\s\S]*current and next highlights are advisory until live inspection is available\./i);
  assert.match(html, /Needs attention/);
  assert.match(html, /The current snapshot is not authoritative enough to collapse to one trusted outer state/);
  assert.match(html, /class="mermaid-state-graph mermaid"/);
  assert.match(html, /current state unavailable/);
  assert.match(html, /not present \/ unavailable/);
  assert.match(html, /copilot layer:[\s\S]*full authoritative state machine shown; transition data unavailable in this snapshot/);
  assert.match(html, /reviewer layer:[\s\S]*full authoritative state machine shown; transition data unavailable in this snapshot/);
  assert.match(html, /no_copilot_review_history/);
  assert.match(html, /no_steering_file/);
});

test("renderInspectRunViewerHtml distinguishes empty transitions from unavailable transition data", () => {
  const html = renderInspectRunViewerHtml({
    repo: "owner/repo",
    target: { repo: "owner/repo", pr: 55 },
    snapshot: makeSnapshot({
      layers: {
        copilot: {
          currentState: "waiting_for_copilot_review",
          allowedTransitions: [],
        },
        reviewer: {
          currentState: "waiting_for_author_followup",
          scope: { mode: "all_reviewers", reviewerLogin: null },
          allowedTransitions: ["waiting_for_re_request"],
        },
        steering: { status: "unavailable", reason: "no_steering_locator" },
      },
    }),
  });

  assert.match(html, /copilot layer:[\s\S]*full authoritative state machine shown; no allowed transitions/);
  assert.doesNotMatch(html, /copilot layer:[\s\S]*full authoritative state machine shown; transition data unavailable in this snapshot/);
});

test("renderInspectRunViewerHtml highlights terminal merged states", () => {
  const html = renderInspectRunViewerHtml({
    repo: "owner/repo",
    target: { repo: "owner/repo", pr: 55 },
    snapshot: makeSnapshot({
      outerState: "done_terminal",
      activeFamilyState: "done",
      outerAction: "done",
      statusClass: "done",
      layers: {
        copilot: {
          currentState: "done",
          allowedTransitions: [],
        },
        reviewer: {
          currentState: "waiting_for_review_request",
          scope: { mode: "all_reviewers", reviewerLogin: null },
          allowedTransitions: [],
        },
        steering: { status: "unavailable", reason: "no_steering_locator" },
      },
    }),
  });

  assert.match(html, /<a href="https:\/\/github\.com\/owner\/repo\/pull\/55">owner\/repo#55<\/a>/);
  assert.match(html, /PR complete/);
  assert.match(html, /The current inspection says this PR is in a terminal done state/);
  assert.match(html, /status class[\s\S]*<code>done<\/code>/);
  assert.match(html, /outerAction \(compatibility\)[\s\S]*<code>done<\/code>/);

  const graph = buildInspectionMermaidGraph(makeSnapshot({
    outerState: "done_terminal",
    activeFamilyState: "done",
    outerAction: "done",
    statusClass: "done",
    layers: {
      copilot: {
        currentState: "done",
        allowedTransitions: [],
      },
      reviewer: {
        currentState: "waiting_for_review_request",
        scope: { mode: "all_reviewers", reviewerLogin: null },
        allowedTransitions: [],
      },
      steering: { status: "unavailable", reason: "no_steering_locator" },
    },
  }));

  assert.ok(graph);
  assert.match(graph.definition, /class outer_loop_family_done_terminal,copilot_layer_done currentTerminal;/);
  assert.match(graph.definition, /copilot_layer_done --> copilot_layer_end/);
  assert.match(html, /copilot layer:[\s\S]*current <code>done<\/code>; done; full authoritative state machine shown; no allowed transitions/);
});

test("renderInspectRunViewerHtml keeps stale approved snapshots on waiting until Copilot is re-requested", () => {
  const staleApprovedSnapshot = makeSnapshot({
    target: { repo: "owner/repo", pr: 57 },
    outerState: "continue_current_wait",
    outerAction: "continue_wait",
    activeFamilyState: "continue_wait",
    statusClass: "waiting",
    needsAttention: false,
    layers: {
      copilot: {
        currentState: "ready_to_rerequest_review",
        allowedTransitions: ["waiting_for_copilot_review", "review_request_unavailable", "done"],
        sameHeadCleanConverged: false,
        loopDisposition: "pending",
        terminal: false,
      },
      reviewer: {
        currentState: "waiting_for_author_followup",
        submittedReviewState: "APPROVED",
        approvedOnCurrentHead: true,
        scope: { mode: "all_reviewers", reviewerLogin: null },
        allowedTransitions: ["waiting_for_re_request", "waiting_for_review_request"],
      },
      steering: { status: "unavailable", reason: "no_steering_locator" },
    },
  });

  const html = renderInspectRunViewerHtml({
    repo: null,
    target: { repo: "owner/repo", pr: 57 },
    snapshot: staleApprovedSnapshot,
    inboxItems: [
      { target: { repo: "owner/repo", pr: 57 }, title: "fix: stale approved signal", updatedAt: "2026-05-22T00:00:00Z", snapshot: staleApprovedSnapshot },
    ],
  });

  assert.match(html, /assigned-pr-row assigned-pr-row-waiting is-selected/);
  assert.match(html, /data-inbox-signal="waiting"/);
  assert.doesNotMatch(html, /Gate review required/);
});

test("renderInspectRunViewerHtml keeps completed snapshots on the ready inbox signal", () => {
  const doneSnapshot = makeSnapshot({
    target: { repo: "owner/repo", pr: 56 },
    outerState: "done_terminal",
    outerAction: "done",
    activeFamilyState: "done",
    statusClass: "done",
    needsAttention: false,
    layers: {
      copilot: {
        currentState: "done",
        allowedTransitions: [],
        sameHeadCleanConverged: false,
        loopDisposition: "done",
        terminal: true,
      },
      reviewer: {
        currentState: "waiting_for_review_request",
        scope: { mode: "all_reviewers", reviewerLogin: null },
        allowedTransitions: [],
      },
      steering: { status: "unavailable", reason: "no_steering_locator" },
    },
  });

  const html = renderInspectRunViewerHtml({
    repo: null,
    target: { repo: "owner/repo", pr: 56 },
    snapshot: doneSnapshot,
    inboxItems: [
      { target: { repo: "owner/repo", pr: 56 }, title: "fix: done signal", updatedAt: "2026-05-22T00:00:00Z", snapshot: doneSnapshot },
    ],
  });

  assert.match(html, /assigned-pr-row assigned-pr-row-ready is-selected/);
  assert.match(html, /data-inbox-signal="ready"/);
  assert.doesNotMatch(html, /data-inbox-signal="gate"/);
});

test("renderInspectRunViewerHtml requires explicit gate evidence before framing clean convergence as approval-ready", () => {
  const html = renderInspectRunViewerHtml({
    repo: "owner/repo",
    target: { repo: "owner/repo", pr: 55 },
    snapshot: makeSnapshot({
      outerState: "continue_current_wait",
      outerAction: "continue_wait",
      statusClass: "waiting",
      layers: {
        copilot: {
          currentState: "ready_to_rerequest_review",
          allowedTransitions: ["waiting_for_copilot_review", "review_request_unavailable", "done"],
          sameHeadCleanConverged: true,
          loopDisposition: "clean_converged",
          terminal: true,
        },
        reviewer: {
          currentState: "waiting_for_author_followup",
          submittedReviewState: "APPROVED",
          approvedOnCurrentHead: true,
          scope: { mode: "all_reviewers", reviewerLogin: null },
          allowedTransitions: ["waiting_for_re_request", "waiting_for_review_request"],
        },
        steering: { status: "unavailable", reason: "no_steering_locator" },
      },
    }),
  });

  assert.match(html, /Clean reviews present; gate evidence still required/);
  assert.match(html, /clean submitted Copilot review and an approved human review, but approval or merge suggestions still require explicit current-head pre_approval_gate evidence/i);
  assert.match(html, /Confirm or rerun the current-head pre_approval_gate before any approval or merge recommendation/i);
  assert.match(html, /reviewer verdict[\s\S]*approved on current head/i);
  assert.doesNotMatch(html, /Approved current head/);
  assert.doesNotMatch(html, /Proceed to merge if authorized/i);
});

test("renderInspectRunViewerHtml blocks approval-oriented language for same-head clean Copilot reviews without gate evidence", () => {
  const html = renderInspectRunViewerHtml({
    repo: "owner/repo",
    target: { repo: "owner/repo", pr: 55 },
    snapshot: makeSnapshot({
      outerState: "continue_current_wait",
      outerAction: "continue_wait",
      statusClass: "waiting",
      layers: {
        copilot: {
          currentState: "ready_to_rerequest_review",
          allowedTransitions: ["waiting_for_copilot_review", "review_request_unavailable", "done"],
          sameHeadCleanConverged: true,
          loopDisposition: "clean_converged",
          terminal: true,
        },
        reviewer: {
          currentState: "waiting_for_author_followup",
          scope: { mode: "all_reviewers", reviewerLogin: null },
          allowedTransitions: ["waiting_for_re_request", "waiting_for_review_request"],
        },
        steering: { status: "unavailable", reason: "no_steering_locator" },
      },
    }),
  });

  assert.match(html, /Copilot pass complete; gate evidence still required/);
  assert.match(html, /current head already has a clean submitted Copilot review with no unresolved feedback, but that alone is not enough for an approval or merge suggestion/i);
  assert.match(html, /Confirm or rerun the current-head pre_approval_gate before any approval or merge recommendation, or wait for a meaningful remediation event before requesting another Copilot pass/i);
  assert.doesNotMatch(html, /Proceed to final human review or approval/i);
  assert.doesNotMatch(html, /Ready to re-request Copilot review/);
});

test("renderInspectRunViewerHtml shows round-cap messaging for round_cap_reached state", () => {
  const html = renderInspectRunViewerHtml({
    repo: "owner/repo",
    target: { repo: "owner/repo", pr: 55 },
    snapshot: makeSnapshot({
      outerState: "continue_current_wait",
      outerAction: "reenter_copilot_loop",
      statusClass: "blocked",
      layers: {
        copilot: {
          currentState: "round_cap_reached",
          allowedTransitions: [],
          loopDisposition: "blocked",
          terminal: true,
        },
        reviewer: {
          currentState: "waiting_for_review_request",
          scope: { mode: "all_reviewers", reviewerLogin: null },
          allowedTransitions: ["review_requested"],
        },
        steering: { status: "unavailable", reason: "no_steering_locator" },
      },
    }),
  });

  assert.match(html, /Round cap reached/);
  assert.match(html, /unresolved feedback or CI problems still block convergence/i);
  assert.match(html, /no further Copilot re-requests are possible/i);
  assert.doesNotMatch(html, /Ready to re-request Copilot review/);
});

test("renderInspectRunViewerHtml shows round-cap fallback messaging for round_cap_clean_fallback", () => {
  const html = renderInspectRunViewerHtml({
    repo: "owner/repo",
    target: { repo: "owner/repo", pr: 55 },
    snapshot: makeSnapshot({
      outerState: "continue_current_wait",
      outerAction: "reenter_copilot_loop",
      statusClass: "done",
      layers: {
        copilot: {
          currentState: "round_cap_clean_fallback",
          allowedTransitions: [],
          loopDisposition: "done",
          terminal: true,
        },
        reviewer: {
          currentState: "waiting_for_review_request",
          scope: { mode: "all_reviewers", reviewerLogin: null },
          allowedTransitions: ["review_requested"],
        },
        steering: { status: "unavailable", reason: "no_steering_locator" },
      },
    }),
  });

  assert.match(html, /Round cap reached/);
  assert.match(html, /move to pre_approval_gate instead of requesting another Copilot review/i);
  assert.doesNotMatch(html, /Ready to re-request Copilot review/);
});

test("renderInspectRunViewerHtml preserves stay_with_current_live_owner and needs_reconcile in the banner", () => {
  const liveOwnerHtml = renderInspectRunViewerHtml({
    repo: "owner/repo",
    target: { repo: "owner/repo", pr: 55 },
    snapshot: makeSnapshot({
      outerState: "stay_with_current_live_owner",
      outerAction: "continue_wait",
      layers: {
        copilot: {
          currentState: "round_cap_clean_fallback",
          allowedTransitions: [],
          loopDisposition: "done",
          terminal: true,
        },
        reviewer: {
          currentState: "review_requested",
          scope: { mode: "all_reviewers", reviewerLogin: null },
          allowedTransitions: ["determine_review_plan", "blocked_needs_user_decision"],
        },
        steering: { status: "unavailable", reason: "no_steering_locator" },
      },
    }),
  });

  assert.match(liveOwnerHtml, /Live owner already active/);
  assert.match(liveOwnerHtml, /stay_with_current_live_owner/);
  assert.doesNotMatch(liveOwnerHtml, /Reviewer loop active/);

  const reconcileHtml = renderInspectRunViewerHtml({
    repo: "owner/repo",
    target: { repo: "owner/repo", pr: 55 },
    snapshot: makeSnapshot({
      outerState: "needs_reconcile",
      outerAction: "stop",
      statusClass: "blocked",
      needsAttention: true,
      layers: {
        copilot: {
          currentState: "round_cap_clean_fallback",
          allowedTransitions: [],
          loopDisposition: "done",
          terminal: true,
        },
        reviewer: {
          currentState: "waiting_for_review_request",
          scope: { mode: "all_reviewers", reviewerLogin: null },
          allowedTransitions: ["review_requested"],
        },
        steering: { status: "unavailable", reason: "no_steering_locator" },
      },
    }),
  });

  assert.match(reconcileHtml, /Needs reconcile/);
  assert.match(reconcileHtml, /needs_reconcile/);
  assert.doesNotMatch(reconcileHtml, /The inspection found a blocked or stop-like state/);
});

test("renderInspectRunViewerHtml renders conflicting snapshot cues", () => {
  const html = renderInspectRunViewerHtml({
    repo: "owner/repo",
    target: { repo: "owner/repo", pr: 55 },
    snapshot: makeSnapshot({
      needsAttention: true,
      markers: {
        missing: [],
        stale: [],
        conflicts: ["checkpoint outerAction 'continue_wait' differs from live-derived 'reenter_copilot_loop'"],
      },
    }),
  });

  assert.match(html, /handoff-badge-danger">conflicting<\/span>/);
  assert.doesNotMatch(html, /Conflicting graph view[\s\S]*resolve the evidence conflict before trusting the highlights\./i);
  assert.match(html, /checkpoint outerAction/);
});

test("renderInspectRunViewerHtml renders unavailable snapshot and malformed target load errors explicitly", () => {
  const html = renderInspectRunViewerHtml({
    repo: "owner/repo",
    target: { repo: "bad target", pr: "x" },
    snapshot: null,
    error: new Error("target.pr must be a positive integer"),
  });

  assert.match(html, /Snapshot unavailable/);
  assert.match(html, /target\.pr must be a positive integer/);
  assert.match(html, /no state graph can be rendered yet/i);
  assert.match(html, /Use the Reload snapshot control to refresh/i);
});


test("renderInspectRunViewerHtml treats undefined snapshots as unavailable", () => {
  const html = renderInspectRunViewerHtml({
    repo: "owner/repo",
    target: { repo: "owner/repo", pr: 55 },
    snapshot: undefined,
  });

  assert.match(html, /Snapshot unavailable/);
  assert.match(html, /Unable to load inspect-run snapshot/);
});

test("buildInspectionMermaidGraph suppresses graph rendering for sourceMode unavailable even with conflicting markers", () => {
  const graph = buildInspectionMermaidGraph(makeSnapshot({
    sourceMode: "unavailable",
    trust: "unknown",
    markers: {
      missing: [],
      stale: [],
      conflicts: ["live and checkpoint disagree"],
    },
  }));

  assert.equal(graph, null);
});

test("renderInspectRunViewerHtml includes deterministic Mermaid asset fallback messaging", () => {
  const html = renderInspectRunViewerHtml({
    repo: "owner/repo",
    target: { repo: "owner/repo", pr: 55 },
    snapshot: makeSnapshot(),
  });

  assert.match(html, /Graph renderer unavailable\. Use the details below or open \/snapshot\.json\./);
});
test("renderInspectRunViewerHtml fail-closes the graph for unavailable snapshots", () => {
  const html = renderInspectRunViewerHtml({
    repo: "owner/repo",
    target: { repo: "owner/repo", pr: 55 },
    snapshot: makeSnapshot({
      sourceMode: "unavailable",
      trust: "unknown",
      activeFamilyState: "unknown",
      layers: {
        steering: { status: "unavailable", reason: "no_steering_locator" },
      },
    }),
  });

  assert.match(html, /Snapshot unavailable, so no state graph can be rendered yet/);
  assert.doesNotMatch(html, /class="mermaid-state-graph mermaid"/);
});
