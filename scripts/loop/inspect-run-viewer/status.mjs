import { OUTER_STATE } from "../../../packages/core/src/loop/conductor-routing.mjs";

import {
  escapeHtml,
  formatStateToken,
  humanizeStateToken,
  titleCaseWords,
} from "./shared.mjs";

const SNAPSHOT_BADGE_VARIANTS = {
  authoritative: "success",
  conflicting: "danger",
  degraded: "warning",
  "checkpoint-only": "warning",
  unavailable: "muted",
};

const INBOX_SIGNAL_BADGE_VARIANTS = {
  attention: "danger",
  pending: "warning",
  gate: "info",
  ready: "success",
  closed: "muted",
  unknown: "muted",
  waiting: "info",
};

function renderBadge(label, variant = "muted") {
  return `<span class="handoff-badge handoff-badge-${escapeHtml(variant)}">${escapeHtml(label)}</span>`;
}

function renderCodeValue(value, fallback = "not present") {
  return `<code>${escapeHtml(formatStateToken(value, fallback))}</code>`;
}

function renderCard({ kicker, title, body, className = "", dataField = null }) {
  return `<article class="handoff-card viewer-card${className ? ` ${escapeHtml(className)}` : ""}"${dataField ? ` data-field="${escapeHtml(dataField)}"` : ""}>
    ${kicker ? `<p class="handoff-card-kicker">${escapeHtml(kicker)}</p>` : ""}
    ${title ? `<h3>${escapeHtml(title)}</h3>` : ""}
    <div class="viewer-card-body">${body}</div>
  </article>`;
}

function renderCardEmptyState() {
  return '<p class="handoff-empty-copy">not present / unavailable</p>';
}

function renderKeyValueRows(entries, { compact = false } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return renderCardEmptyState();
  }

  return `<dl class="handoff-kv${compact ? " handoff-kv-compact" : ""}">
    ${entries.map(([label, value]) => `<div class="handoff-kv-row"><dt>${escapeHtml(label)}</dt><dd>${value}</dd></div>`).join("")}
  </dl>`;
}

function renderStatGrid(stats, { columns = "" } = {}) {
  const normalizedStats = Array.isArray(stats) ? stats.filter(Boolean) : [];
  if (normalizedStats.length === 0) {
    return renderCardEmptyState();
  }

  return `<div class="handoff-stat-grid viewer-stat-grid${columns ? ` ${escapeHtml(columns)}` : ""}">
    ${normalizedStats.map(({ label, value }) => `<div class="handoff-stat"><span class="handoff-stat-label">${escapeHtml(label)}</span><span class="handoff-stat-value">${value}</span></div>`).join("")}
  </div>`;
}

function renderCardList(items, { emptyText = "none" } = {}) {
  if (!Array.isArray(items)) {
    return `<p class="handoff-empty-copy">not present / unavailable</p>`;
  }
  if (items.length === 0) {
    return `<p class="handoff-empty-copy">${escapeHtml(emptyText)}</p>`;
  }

  return `<ul class="viewer-card-list">${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function renderCardListBlock(title, items, options = {}) {
  return `<div class="viewer-card-list-block">
    <h4>${escapeHtml(title)}</h4>
    ${renderCardList(items, options)}
  </div>`;
}

function renderCurrentStateBadge(stateLabel) {
  return renderBadge(stateLabel, SNAPSHOT_BADGE_VARIANTS[stateLabel] ?? "muted");
}

function renderInboxSignalBadge(snapshot) {
  const signal = deriveInboxSignalFromSnapshot(snapshot);
  return renderBadge(signal.replaceAll("_", " "), INBOX_SIGNAL_BADGE_VARIANTS[signal] ?? "muted");
}

function renderBooleanBadge(value, { positive = false } = {}) {
  if (value === true) {
    return renderBadge("true", positive ? "success" : "danger");
  }
  if (value === false) {
    return renderBadge("false", positive ? "muted" : "success");
  }
  return renderBadge("not present", "muted");
}

function buildCopilotLoopIterationEntries(snapshot) {
  const loopIterations = snapshot?.loopIterations;
  if (loopIterations === null || loopIterations === undefined) {
    return null;
  }

  const humanSummary = loopIterations.available
    ? [
      `state: ${snapshot?.layers?.copilot?.currentState ?? "not present"}`,
      `iterations: ${loopIterations.completedCopilotReviewRounds} completed, ${loopIterations.pendingCopilotReviewRounds} pending`,
      `comments: ${loopIterations.copilotReviewComments} produced, ${loopIterations.unresolvedReviewThreads} unresolved`,
      `fix commits: ${loopIterations.fixCommitsAfterFeedback}`,
    ].join("; ")
    : "not present / unavailable";

  return [
    ["available", escapeHtml(String(loopIterations.available))],
    ["source", escapeHtml(loopIterations.source ?? "not present")],
    ["reason", escapeHtml(loopIterations.reason ?? "not present")],
    ["completedCopilotReviewRounds", escapeHtml(String(loopIterations.completedCopilotReviewRounds ?? "not present"))],
    ["pendingCopilotReviewRounds", escapeHtml(String(loopIterations.pendingCopilotReviewRounds ?? "not present"))],
    ["copilotReviewRequests", escapeHtml(String(loopIterations.copilotReviewRequests ?? "not present"))],
    ["copilotReviewComments", escapeHtml(String(loopIterations.copilotReviewComments ?? "not present"))],
    ["resolvedReviewThreads", escapeHtml(String(loopIterations.resolvedReviewThreads ?? "not present"))],
    ["unresolvedReviewThreads", escapeHtml(String(loopIterations.unresolvedReviewThreads ?? "not present"))],
    ["fixCommitsAfterFeedback", escapeHtml(String(loopIterations.fixCommitsAfterFeedback ?? "not present"))],
    ["humanSummary", escapeHtml(humanSummary)],
  ];
}

export function renderOverviewSection(snapshot) {
  const summary = summarizeCurrentPrStatus(snapshot);
  const loopIterations = snapshot?.loopIterations;

  const stateBody = `${renderStatGrid([
    { label: "status class", value: renderCodeValue(snapshot?.statusClass) },
    { label: "outer state", value: renderCodeValue(snapshot?.outerState) },
    { label: "outerAction", value: renderCodeValue(snapshot?.outerAction) },
    { label: "Copilot state", value: renderCodeValue(snapshot?.layers?.copilot?.currentState) },
    { label: "reviewer state", value: renderCodeValue(snapshot?.layers?.reviewer?.currentState) },
    { label: "reviewer verdict", value: escapeHtml(renderReviewerVerdict(snapshot)) },
    { label: "needs attention", value: renderBooleanBadge(snapshot?.needsAttention) },
    { label: "sourceMode", value: escapeHtml(formatStateToken(snapshot?.sourceMode)) },
  ], { columns: "viewer-stat-grid-2" })}`;

  const metricsBody = `<div class="handoff-next-action viewer-next-action">
    <p><strong>${escapeHtml(summary.headline)}.</strong> ${escapeHtml(summary.nextAction)}</p>
  </div>
  ${loopIterations
    ? renderStatGrid([
      { label: "completed rounds", value: escapeHtml(String(loopIterations.completedCopilotReviewRounds ?? "not present")) },
      { label: "pending rounds", value: escapeHtml(String(loopIterations.pendingCopilotReviewRounds ?? "not present")) },
      { label: "Copilot comments", value: escapeHtml(String(loopIterations.copilotReviewComments ?? "not present")) },
      { label: "unresolved threads", value: escapeHtml(String(loopIterations.unresolvedReviewThreads ?? "not present")) },
      { label: "resolved threads", value: escapeHtml(String(loopIterations.resolvedReviewThreads ?? "not present")) },
      { label: "fix commits", value: escapeHtml(String(loopIterations.fixCommitsAfterFeedback ?? "not present")) },
    ], { columns: "viewer-stat-grid-3" })
    : renderCardEmptyState()}
  <div class="viewer-card-list-grid">
    ${renderCardListBlock("markers.missing", snapshot?.markers?.missing)}
    ${renderCardListBlock("markers.stale", snapshot?.markers?.stale)}
    ${renderCardListBlock("markers.conflicts", snapshot?.markers?.conflicts)}
  </div>`;

  return `<section class="viewer-tab-section" aria-label="Overview">
    <div class="viewer-card-grid viewer-card-grid-overview">
      ${renderCard({ kicker: "Overview", title: "Current state", body: stateBody, className: "handoff-card-tight handoff-card-emphasis", dataField: "overview-state" })}
      ${renderCard({ kicker: "Overview", title: "Next action and key metrics", body: metricsBody, className: "handoff-card-tight", dataField: "overview-metrics" })}
    </div>
  </section>`;
}

export function renderOuterLoopSummarySection(snapshot) {
  if (snapshot === null || snapshot === undefined) {
    return renderCard({ kicker: "Layers", title: "Outer-loop", body: renderCardEmptyState(), className: "handoff-card-tight", dataField: "outer-loop-summary" });
  }

  return renderCard({
    kicker: "Layers",
    title: "Outer-loop",
    className: "handoff-card-tight",
    dataField: "outer-loop-summary",
    body: `${renderStatGrid([
      { label: "activeStateFamily", value: escapeHtml(snapshot.activeStateFamily ?? "not present") },
      { label: "outerState", value: renderCodeValue(snapshot.outerState) },
      { label: "outerAction (compatibility)", value: renderCodeValue(snapshot.outerAction) },
      { label: "activeFamilyState", value: escapeHtml(snapshot.activeFamilyState ?? "not present") },
      { label: "statusClass", value: escapeHtml(snapshot.statusClass ?? "not present") },
      { label: "needsAttention", value: renderBooleanBadge(snapshot.needsAttention) },
      { label: "sourceMode", value: escapeHtml(snapshot.sourceMode ?? "not present") },
      { label: "trust", value: escapeHtml(snapshot.trust ?? "not present") },
      { label: "evidence.summary", value: escapeHtml(snapshot.evidence?.summary ?? "not present") },
    ], { columns: "viewer-stat-grid-3" })}
    <div class="viewer-card-list-grid">
      ${renderCardListBlock("evidence.authoritative", snapshot.evidence?.authoritative)}
      ${renderCardListBlock("evidence.checkpoint", snapshot.evidence?.checkpoint)}
    </div>`,
  });
}

export function renderCopilotLayerSection(layer, snapshot = null) {
  
  const loopIterationEntries = buildCopilotLoopIterationEntries(snapshot);

  if (layer === null || layer === undefined) {
    return renderCard({
      kicker: "Layers",
      title: "Copilot",
      className: "handoff-card-tight",
      dataField: "copilot-layer",
      body: `${renderCardEmptyState()}
    <div class="viewer-card-subsection">
      <h4>Copilot loop iterations</h4>
      ${loopIterationEntries ? renderKeyValueRows(loopIterationEntries, { compact: true }) : renderCardEmptyState()}
    </div>`,
    });
  }

  return renderCard({
    kicker: "Layers",
    title: "Copilot",
    className: "handoff-card-tight",
    dataField: "copilot-layer",
    body: `${renderStatGrid([
      { label: "currentState", value: renderCodeValue(layer.currentState) },
      { label: "loopDisposition", value: renderCodeValue(layer.loopDisposition) },
      { label: "sameHeadCleanConverged", value: renderBooleanBadge(layer.sameHeadCleanConverged, { positive: true }) },
      { label: "terminal", value: renderBooleanBadge(layer.terminal, { positive: true }) },
    ], { columns: "viewer-stat-grid-2" })}
    ${renderCardListBlock("allowedTransitions", layer.allowedTransitions)}
    <div class="viewer-card-subsection">
      <h4>Copilot loop iterations</h4>
      ${loopIterationEntries ? renderKeyValueRows(loopIterationEntries, { compact: true }) : renderCardEmptyState()}
    </div>`,
  });
}


export function renderReviewerLayerSection(layer) {
  if (layer === null || layer === undefined) {
    return renderCard({ kicker: "Layers", title: "Reviewer", body: renderCardEmptyState(), className: "handoff-card-tight", dataField: "reviewer-layer" });
  }

  return renderCard({
    kicker: "Layers",
    title: "Reviewer",
    className: "handoff-card-tight",
    dataField: "reviewer-layer",
    body: `${renderStatGrid([
      { label: "currentState", value: renderCodeValue(layer.currentState) },
      { label: "scope.mode", value: escapeHtml(layer.scope?.mode ?? "not present") },
      { label: "scope.reviewerLogin", value: escapeHtml(layer.scope?.reviewerLogin ?? "not present") },
      { label: "submittedReviewState", value: renderCodeValue(layer.submittedReviewState) },
      { label: "approvedOnCurrentHead", value: renderBooleanBadge(layer.approvedOnCurrentHead, { positive: true }) },
    ], { columns: "viewer-stat-grid-2" })}
    ${renderCardListBlock("allowedTransitions", layer.allowedTransitions)}`,
  });
}

export function renderSteeringSummarySection(layer) {
  if (layer === null || layer === undefined) {
    return renderCard({ kicker: "Layers", title: "Steering", body: renderCardEmptyState(), className: "handoff-card-tight", dataField: "steering-summary" });
  }

  return renderCard({
    kicker: "Layers",
    title: "Steering",
    className: "handoff-card-tight",
    dataField: "steering-summary",
    body: renderStatGrid([
      { label: "status", value: escapeHtml(layer.status ?? "not present") },
      { label: "reason", value: escapeHtml(layer.reason ?? "not present") },
    ], { columns: "viewer-stat-grid-2" }),
  });
}

function renderReviewerVerdict(snapshot) {
  if (!snapshot) {
    return "not present";
  }

  if (snapshot.layers?.reviewer?.approvedOnCurrentHead === true) {
    return "approved on current head";
  }

  return formatStateToken(snapshot.layers?.reviewer?.submittedReviewState);
}

export function summarizeCurrentPrStatus(snapshot) {
  if (!snapshot) {
    return {
      headline: "Snapshot unavailable",
      detail: "Unable to determine the current PR state yet.",
      nextAction: "Reload the snapshot or open /snapshot.json for the raw error payload.",
    };
  }

  const copilotState = formatStateToken(snapshot.layers?.copilot?.currentState);
  const reviewerState = formatStateToken(snapshot.layers?.reviewer?.currentState);
  const statusClass = formatStateToken(snapshot.statusClass, "unknown");
  const outerState = formatStateToken(snapshot.outerState, "unknown");
  const outerAction = formatStateToken(snapshot.outerAction, "unknown");
  const sameHeadCleanConverged = snapshot.layers?.copilot?.sameHeadCleanConverged === true;
  const copilotLoopDisposition = formatStateToken(snapshot.layers?.copilot?.loopDisposition);
  const copilotTerminal = snapshot.layers?.copilot?.terminal === true;
  const reviewerApprovedOnCurrentHead = snapshot.layers?.reviewer?.approvedOnCurrentHead === true;

  if (outerState === OUTER_STATE.NEEDS_RECONCILE) {
    return {
      headline: "Needs reconcile",
      detail: "The authoritative outer state is needs_reconcile, which means the current inputs are ambiguous, conflicting, or insufficient.",
      nextAction: "Reconcile the conflicting state before trusting the current routing result.",
    };
  }

  if (outerState === OUTER_STATE.STAY_WITH_CURRENT_LIVE_OWNER) {
    return {
      headline: "Live owner already active",
      detail: "The authoritative outer state is stay_with_current_live_owner, so the loop should not issue a new handoff yet.",
      nextAction: "Wait for the live owner to progress the run, then refresh the inspection.",
    };
  }

  if (outerState === OUTER_STATE.STOP_NEEDS_HUMAN) {
    return {
      headline: "Needs attention",
      detail: "The authoritative outer state is stop_needs_human, so automated progress should stop until a human resolves the blocking condition.",
      nextAction: "Read the stop reason, trust markers, and layer summaries before proceeding.",
    };
  }

  if (outerState === OUTER_STATE.DONE_TERMINAL) {
    return {
      headline: "PR complete",
      detail: "The current inspection says this PR is in a terminal done state.",
      nextAction: "Confirm merge/readiness context or inspect the raw snapshot for terminal evidence.",
    };
  }

  if (copilotState === "round_cap_clean_fallback") {
    return {
      headline: "Round cap reached",
      detail: "Copilot review rounds are exhausted for this clean PR head, so the loop should move to pre_approval_gate instead of requesting another Copilot review.",
      nextAction: "Run or confirm the current-head pre_approval_gate rather than re-requesting Copilot review.",
    };
  }

  if (copilotState === "round_cap_reached") {
    return {
      headline: "Round cap reached",
      detail: "Copilot review rounds are exhausted for this PR head while unresolved feedback or CI problems still block convergence, so no further Copilot re-requests are possible.",
      nextAction: "Resolve the remaining feedback or CI blockers without requesting another Copilot review.",
    };
  }

  if (statusClass === "done" || outerAction === "done" || copilotState === "done") {
    return {
      headline: "PR complete",
      detail: "The current inspection says this PR is in a terminal done state.",
      nextAction: "Confirm merge/readiness context or inspect the raw snapshot for terminal evidence.",
    };
  }

  if (copilotState === "unresolved_feedback_present") {
    return {
      headline: "Needs author fixes",
      detail: "Copilot has unresolved feedback on the current PR head.",
      nextAction: "Address the feedback, then reply to and resolve each addressed thread.",
    };
  }

  if (copilotState === "already_fixed_needs_reply_resolve") {
    return {
      headline: "Fixes applied; threads still need resolution",
      detail: "Local fixes appear applied, but GitHub review threads still need reply/resolve follow-up.",
      nextAction: "Reply to and resolve the addressed review threads before requesting another Copilot pass.",
    };
  }

  if (copilotState === "waiting_for_copilot_review") {
    return {
      headline: "Waiting for Copilot review",
      detail: "Copilot review has been requested and the PR is waiting for new review activity.",
      nextAction: "Wait for Copilot review or refresh the snapshot after review activity lands.",
    };
  }

  if (copilotState === "ready_to_rerequest_review" && reviewerApprovedOnCurrentHead && (sameHeadCleanConverged || copilotLoopDisposition === "clean_converged" || copilotTerminal)) {
    return {
      headline: "Clean reviews present; gate evidence still required",
      detail: "The current head has both a clean submitted Copilot review and an approved human review, but approval or merge suggestions still require explicit current-head pre_approval_gate evidence.",
      nextAction: "Confirm or rerun the current-head pre_approval_gate before any approval or merge recommendation.",
    };
  }

  if (copilotState === "ready_to_rerequest_review" && (sameHeadCleanConverged || copilotLoopDisposition === "clean_converged" || copilotTerminal)) {
    return {
      headline: "Copilot pass complete; gate evidence still required",
      detail: "The current head already has a clean submitted Copilot review with no unresolved feedback, but that alone is not enough for an approval or merge suggestion.",
      nextAction: "Confirm or rerun the current-head pre_approval_gate before any approval or merge recommendation, or wait for a meaningful remediation event before requesting another Copilot pass.",
    };
  }

  if (copilotState === "ready_to_rerequest_review") {
    return {
      headline: "Ready to re-request Copilot review",
      detail: "The current head looks clean enough for another Copilot pass or final confirmation.",
      nextAction: "Re-request Copilot review only after the smallest honest local validation is green, or confirm the PR is done.",
    };
  }

  if (reviewerState === "waiting_for_author_followup") {
    return {
      headline: "Waiting for author follow-up",
      detail: "Reviewer work is done for this round and the PR is waiting on author-side changes.",
      nextAction: "Wait for author commits or refresh after follow-up lands.",
    };
  }

  if (reviewerState === "waiting_for_re_request") {
    return {
      headline: "Waiting for reviewer re-request",
      detail: "Reviewer work is paused until a new explicit review request arrives.",
      nextAction: "Wait for a reviewer re-request after follow-up commits.",
    };
  }

  if (reviewerState === "review_requested" || reviewerState === "determine_review_plan" || reviewerState === "reviews_running" || reviewerState === "merge_results" || reviewerState === "draft_review_ready" || reviewerState === "draft_review_posted" || reviewerState === "waiting_for_user_submit" || reviewerState === "submitted_review" || reviewerState === "review_invalidated") {
    return {
      headline: "Reviewer loop active",
      detail: `Reviewer lane is currently at ${humanizeStateToken(reviewerState)}.`,
      nextAction: "Follow the reviewer lane details below and refresh after the next review event.",
    };
  }

  if (copilotState === "waiting_for_ci") {
    return {
      headline: "Waiting for CI",
      detail: "The current head has progressed past review but is still waiting on CI readiness.",
      nextAction: "Wait for CI to complete or become available.",
    };
  }

  if (outerState === "unknown" && snapshot.needsAttention) {
    return {
      headline: "Needs attention",
      detail: "The current snapshot is not authoritative enough to collapse to one trusted outer state.",
      nextAction: "Check trust markers and layer summaries before acting on this snapshot.",
    };
  }

  if (outerAction === "stop" || statusClass === "blocked") {
    return {
      headline: "Needs attention",
      detail: "The inspection found a blocked or stop-like state, but the authoritative outer state was not specific enough to classify it more narrowly here.",
      nextAction: "Read the stop reason, trust markers, and layer summaries before proceeding.",
    };
  }

  if (outerState === OUTER_STATE.CONTINUE_CURRENT_WAIT || outerAction === "continue_wait") {
    return {
      headline: "Waiting for follow-up",
      detail: "The authoritative outer state is continue_current_wait, so the loop should remain in its durable wait path for now.",
      nextAction: "Refresh after new review, CI, or author activity lands.",
    };
  }

  if (outerState === OUTER_STATE.HANDOFF_TO_COPILOT_LOOP || outerAction === "reenter_copilot_loop") {
    return {
      headline: "Copilot loop needs action",
      detail: "The authoritative outer state is handoff_to_copilot_loop, so the next meaningful work is in the Copilot lane.",
      nextAction: "Inspect the Copilot state and act on the requested follow-up.",
    };
  }

  if (outerState === OUTER_STATE.HANDOFF_TO_REVIEWER_LOOP || outerAction === "reenter_reviewer_loop") {
    return {
      headline: "Reviewer loop needs action",
      detail: "The authoritative outer state is handoff_to_reviewer_loop, so the next meaningful work is in the reviewer lane.",
      nextAction: "Inspect the reviewer state and act on the requested follow-up.",
    };
  }

  return {
    headline: titleCaseWords(humanizeStateToken(copilotState === "not present" ? (outerState === "unknown" ? outerAction : outerState) : copilotState)),
    detail: "The viewer could not collapse this to a narrower plain-English status than the current exported loop states.",
    nextAction: "Use the current-state banner fields plus the graph and summaries below.",
  };
}

function buildPullRequestHref(target) {
  if (!target?.repo || target?.pr === null || target?.pr === undefined) {
    return null;
  }
  return `https://github.com/${encodeURIComponent(target.repo).replaceAll("%2F", "/")}/pull/${encodeURIComponent(String(target.pr))}`;
}

function summarizeCurrentPrMode(snapshot) {
  if (!snapshot) {
    return null;
  }

  const copilotState = formatStateToken(snapshot.layers?.copilot?.currentState);
  const reviewerState = formatStateToken(snapshot.layers?.reviewer?.currentState);
  const outerState = formatStateToken(snapshot.outerState, "unknown");
  const outerAction = formatStateToken(snapshot.outerAction, "unknown");

  if (deriveInboxSignalFromSnapshot(snapshot) === "ready") {
    return { emoji: "✅", label: "Approved" };
  }

  if (copilotState === "waiting_for_copilot_review"
    || copilotState === "waiting_for_ci"
    || reviewerState === "waiting_for_author_followup"
    || reviewerState === "waiting_for_re_request"
    || outerState === OUTER_STATE.CONTINUE_CURRENT_WAIT
    || outerState === OUTER_STATE.STAY_WITH_CURRENT_LIVE_OWNER
    || outerAction === "continue_wait") {
    return { emoji: "⏳", label: "Waiting state" };
  }

  if (outerState === OUTER_STATE.HANDOFF_TO_COPILOT_LOOP
    || outerState === OUTER_STATE.HANDOFF_TO_REVIEWER_LOOP
    || outerAction === "reenter_copilot_loop"
    || outerAction === "reenter_reviewer_loop"
    || reviewerState === "review_requested"
    || reviewerState === "determine_review_plan"
    || reviewerState === "reviews_running"
    || reviewerState === "merge_results"
    || reviewerState === "draft_review_ready"
    || reviewerState === "draft_review_posted"
    || reviewerState === "waiting_for_user_submit"
    || reviewerState === "submitted_review"
    || reviewerState === "review_invalidated") {
    return { emoji: "🔁", label: "Active loop" };
  }

  return null;
}

export function renderCurrentStateBanner(snapshot, target, stateLabel, selectedTitle = null) {
  const summary = summarizeCurrentPrStatus(snapshot);
  const pullRequestHref = buildPullRequestHref(target);
  const mode = summarizeCurrentPrMode(snapshot);
  const heading = typeof selectedTitle === "string" && selectedTitle.trim().length > 0
    ? selectedTitle.trim()
    : `PR #${target.pr}`;
  const targetLabel = target?.repo && target?.pr !== null && target?.pr !== undefined
    ? `${target.repo}#${target.pr}`
    : `PR #${target?.pr ?? "unknown"}`;
  const autoReloadOptions = [
    { value: "off", label: "Off" },
    { value: "60000", label: "1 minute" },
    { value: "300000", label: "5 minutes" },
    { value: "900000", label: "15 minutes" },
  ];

  const metaLine = [
    snapshot?.runId ? `run ${escapeHtml(snapshot.runId)}` : null,
    snapshot?.inspectedAt ? escapeHtml(snapshot.inspectedAt) : null,
    snapshot?.sourceMode ? escapeHtml(`source: ${snapshot.sourceMode}`) : null,
  ].filter(Boolean).join(" · ");

  return `<section class="current-pr-state-banner" aria-label="PR #${escapeHtml(target.pr)}">
    <div class="current-pr-state-heading-row">
      <div class="current-pr-state-heading-copy">
        <p class="current-pr-state-kicker">${pullRequestHref
          ? `<a href="${escapeHtml(pullRequestHref)}">${escapeHtml(targetLabel)}</a>`
          : escapeHtml(targetLabel)}</p>
        <h1>${escapeHtml(heading)}</h1>
      </div>
      ${mode ? `<span class="current-pr-state-mode-indicator" title="${escapeHtml(mode.label)}" aria-label="${escapeHtml(mode.label)}">${escapeHtml(mode.emoji)}</span>` : ""}
    </div>
    <div class="current-pr-state-copy-flow">
      ${metaLine ? `<p class="current-pr-state-meta">${metaLine}</p>` : ""}
      <div class="viewer-badge-row current-pr-state-badge-row">
        ${renderCurrentStateBadge(stateLabel)}
        ${renderInboxSignalBadge(snapshot)}
        ${mode ? renderBadge(mode.label, "info") : ""}
      </div>
      <p class="current-pr-state-summary-headline"><strong>${escapeHtml(summary.headline)}</strong></p>
      <p class="current-pr-state-detail">${escapeHtml(summary.detail)}</p>
    </div>
    <div class="current-pr-state-controls" data-auto-reload-controls>
      <label class="current-pr-state-auto-reload-label" for="current-pr-state-auto-reload">
        <span aria-hidden="true">⏱</span>
        <span>Auto-reload:</span>
      </label>
      <select id="current-pr-state-auto-reload" class="current-pr-state-auto-reload-select" data-auto-reload-select aria-label="Auto-reload period">
        ${autoReloadOptions.map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`).join("")}
      </select>
      <button type="button" class="viewer-action-button current-pr-state-reload" data-auto-reload-manual onclick="window.location.reload()" title="Reload snapshot" aria-label="Reload snapshot">🔄 Reload</button>
    </div>
  </section>
  <script>
    (() => {
      const AUTO_RELOAD_STORAGE_KEY = "inspect-run-viewer:auto-reload-ms";
      const select = document.querySelector("[data-auto-reload-select]");
      const manualButton = document.querySelector("[data-auto-reload-manual]");
      if (!select || !manualButton) {
        return;
      }

      let autoReloadTimer = null;
      const clearAutoReloadTimer = () => {
        if (autoReloadTimer !== null) {
          window.clearInterval(autoReloadTimer);
          autoReloadTimer = null;
        }
      };
      const applyAutoReloadValue = (rawValue) => {
        const nextValue = Array.from(select.options).some((option) => option.value === rawValue)
          ? rawValue
          : "off";
        select.value = nextValue;
        const autoReloadEnabled = nextValue !== "off";
        manualButton.hidden = autoReloadEnabled;
        clearAutoReloadTimer();
        if (!autoReloadEnabled) {
          return;
        }
        const intervalMs = Number.parseInt(nextValue, 10);
        if (Number.isFinite(intervalMs) && intervalMs > 0) {
          autoReloadTimer = window.setInterval(() => {
            window.location.reload();
          }, intervalMs);
        }
      };

      let storedValue = "off";
      try {
        storedValue = window.localStorage.getItem(AUTO_RELOAD_STORAGE_KEY) ?? "off";
      } catch {
        storedValue = "off";
      }
      applyAutoReloadValue(storedValue);

      select.addEventListener("change", () => {
        const nextValue = select.value;
        try {
          if (nextValue === "off") {
            window.localStorage.removeItem(AUTO_RELOAD_STORAGE_KEY);
          } else {
            window.localStorage.setItem(AUTO_RELOAD_STORAGE_KEY, nextValue);
          }
        } catch {
          // Ignore localStorage write failures.
        }
        applyAutoReloadValue(nextValue);
      });

      window.addEventListener("beforeunload", clearAutoReloadTimer);
    })();
  </script>`;
}

export function deriveInboxSignalFromSnapshot(snapshot) {
  if (!snapshot) {
    return "unknown";
  }

  const outerState = formatStateToken(snapshot.outerState, "unknown");
  const outerAction = formatStateToken(snapshot.outerAction, "unknown");
  const statusClass = formatStateToken(snapshot.statusClass, "unknown");
  const copilotState = formatStateToken(snapshot.layers?.copilot?.currentState);
  const sameHeadCleanConverged = snapshot.layers?.copilot?.sameHeadCleanConverged === true;
  const copilotLoopDisposition = formatStateToken(snapshot.layers?.copilot?.loopDisposition);
  const reviewerState = formatStateToken(snapshot.layers?.reviewer?.currentState);

  if (snapshot.needsAttention === true
    || outerState === OUTER_STATE.NEEDS_RECONCILE
    || outerState === OUTER_STATE.STOP_NEEDS_HUMAN
    || outerAction === "stop"
    || statusClass === "blocked"
    || copilotState === "unresolved_feedback_present"
    || copilotState === "already_fixed_needs_reply_resolve") {
    return "attention";
  }

  if (sameHeadCleanConverged || copilotLoopDisposition === "clean_converged") {
    return "gate";
  }

  if (copilotState === "waiting_for_copilot_review"
    || reviewerState === "waiting_for_author_followup"
    || reviewerState === "waiting_for_re_request") {
    return "waiting";
  }

  if (outerState === OUTER_STATE.HANDOFF_TO_COPILOT_LOOP
    || outerState === OUTER_STATE.HANDOFF_TO_REVIEWER_LOOP
    || outerAction === "reenter_copilot_loop"
    || outerAction === "reenter_reviewer_loop") {
    return "attention";
  }

  if (copilotState === "waiting_for_ci") {
    return "pending";
  }

  if (outerState === OUTER_STATE.DONE_TERMINAL || statusClass === "done") {
    return "ready";
  }

  if (snapshot.sourceMode === "unavailable") {
    return "unknown";
  }

  return "waiting";
}
