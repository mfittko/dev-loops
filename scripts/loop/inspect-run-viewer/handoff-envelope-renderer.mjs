/**
 * Render the handoff envelope as a structured HTML section for the inspect-run viewer.
 *
 * Depends on the handoff envelope module from @dev-loops/core.
 */
import { escapeHtml } from "./shared.mjs";

const LABELS = {
  kind: "Kind",
  repo: "Repository",
  pr: "PR",
  issue: "Issue",
  branch: "Branch",
  phase: "Phase",
  currentGate: "Current gate",
  currentHeadSha: "Head SHA",
  ciStatus: "CI status",
  unresolvedThreadCount: "Unresolved threads",
  copilotRoundCount: "Completed rounds",
  maxCopilotRounds: "Round limit",
  executionMode: "Execution mode",
  nextAction: "Next action",
  asyncStartMode: "Async start mode",
  requireDraftFirst: "Require draft first",
  cwd: "Working directory",
  worktreeRequired: "Worktree required",
  angles: "Review angles",
  excludeAngles: "Excluded angles",
  blockCleanOnFindingSeverities: "Block on severities",
  requireCi: "Require CI",
  evidence: "Evidence",
  maxFinalizationTurns: "Max finalization turns",
  needsAttentionAfterMs: "Needs attention after",
  activeNoticeAfterMs: "Active notice after",
};

function humanizeKey(key) {
  if (LABELS[key]) {
    return LABELS[key];
  }
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function normalizeToken(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function formatDurationMs(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return renderPlainValue(value);
  }
  const seconds = value / 1000;
  if (seconds < 60) {
    return `${escapeHtml(String(seconds))} sec · ${escapeHtml(String(value))} ms`;
  }
  const minutes = seconds / 60;
  if (minutes < 60) {
    return `${escapeHtml(String(minutes))} min · ${escapeHtml(String(value))} ms`;
  }
  const hours = minutes / 60;
  return `${escapeHtml(String(hours))} hr · ${escapeHtml(String(value))} ms`;
}

function renderBadge(label, tone = "neutral", extraClass = "") {
  return `<span class="handoff-badge handoff-badge-${escapeHtml(tone)}${extraClass ? ` ${escapeHtml(extraClass)}` : ""}">${escapeHtml(String(label))}</span>`;
}

function renderBooleanBadge(value, { trueLabel = "Yes", falseLabel = "No" } = {}) {
  if (value === null || value === undefined) {
    return `<span class="handoff-empty-value">not set</span>`;
  }
  return value ? renderBadge(trueLabel, "success") : renderBadge(falseLabel, "muted");
}

function toneForGate(value) {
  const token = normalizeToken(value);
  if (["clean", "ready", "pass", "passed", "approved"].includes(token)) return "success";
  if (["draft", "pending", "queued", "review"].includes(token)) return "warning";
  if (["fail", "failed", "blocked", "rejected"].includes(token)) return "danger";
  return "info";
}

function toneForCi(value) {
  const token = normalizeToken(value);
  if (["success", "passed", "green"].includes(token)) return "success";
  if (["failure", "failed", "error", "red"].includes(token)) return "danger";
  if (["pending", "running", "queued", "in_progress"].includes(token)) return "warning";
  if (["skipped", "cancelled", "canceled"].includes(token)) return "muted";
  return "neutral";
}

function toneForSeverity(value) {
  const token = normalizeToken(value);
  if (["required", "must-fix", "blocker", "high"].includes(token)) return "danger";
  if (["worth-fixing-now", "warning", "medium"].includes(token)) return "warning";
  return "info";
}

function renderPlainValue(value) {
  if (value === null || value === undefined) {
    return `<span class="handoff-empty-value">not set</span>`;
  }
  return escapeHtml(String(value));
}

function renderInlineValue(value, key = "") {
  if (value === null || value === undefined) {
    return `<span class="handoff-empty-value">not set</span>`;
  }
  if (key === "currentGate") {
    return renderBadge(value, toneForGate(value));
  }
  if (key === "ciStatus") {
    return renderBadge(value, toneForCi(value));
  }
  if (["executionMode", "asyncStartMode", "kind"].includes(key)) {
    return renderBadge(value, "info");
  }
  if (["requireDraftFirst", "worktreeRequired", "requireCi"].includes(key)) {
    return renderBooleanBadge(value);
  }
  if (["needsAttentionAfterMs", "activeNoticeAfterMs"].includes(key)) {
    return formatDurationMs(value);
  }
  if (key === "currentHeadSha" && typeof value === "string") {
    const shortSha = value.length > 12 ? value.slice(0, 12) : value;
    return `<code title="${escapeHtml(value)}">${escapeHtml(shortSha)}</code>`;
  }
  return renderPlainValue(value);
}

function renderChipList(items, tone = "neutral", { code = false } = {}) {
  if (!Array.isArray(items) || items.length === 0) {
    return `<ul class="handoff-chip-list"><li>${renderBadge("none", "muted")}</li></ul>`;
  }
  return `<ul class="handoff-chip-list">${items.map((item) => `<li>${code ? `<code>${escapeHtml(String(item))}</code>` : renderBadge(item, tone)}</li>`).join("")}</ul>`;
}

function renderReadList(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return `<p class="handoff-empty-copy">none</p>`;
  }
  return `<ol class="handoff-read-list">${items.map((item) => `<li><code>${escapeHtml(String(item))}</code></li>`).join("")}</ol>`;
}

function renderCriteria(criteria) {
  if (!Array.isArray(criteria) || criteria.length === 0) {
    return `<p class="handoff-empty-copy">none</p>`;
  }
  return `<ol class="handoff-criteria-list">${criteria.map((criterion) => `
    <li class="handoff-criteria-item">
      <div class="handoff-criteria-header">
        ${renderBadge(criterion.severity ?? "not set", toneForSeverity(criterion.severity), "handoff-criteria-severity")}
        <code>${escapeHtml(String(criterion.id ?? "unknown"))}</code>
      </div>
      <p>${escapeHtml(String(criterion.must ?? "not set"))}</p>
    </li>
  `).join("")}</ol>`;
}

function renderKeyValueList(entries, { compact = false } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return `<p class="handoff-empty-copy">none</p>`;
  }
  return `<dl class="handoff-kv${compact ? " handoff-kv-compact" : ""}">${entries.map(({ key, label, valueHtml }) => `
    <div class="handoff-kv-row"${key ? ` data-field="${escapeHtml(String(key))}"` : ""}>
      <dt>${escapeHtml(label)}</dt>
      <dd>${valueHtml}</dd>
    </div>
  `).join("")}</dl>`;
}

function renderObjectAsKeyValue(value) {
  if (value === null || value === undefined) {
    return `<span class="handoff-empty-value">not set</span>`;
  }
  const entries = Object.entries(value)
    .filter(([, entryValue]) => entryValue !== undefined)
    .map(([key, entryValue]) => ({
      key,
      label: humanizeKey(key),
      valueHtml: renderEnvelopeValue(entryValue, key),
    }));
  return renderKeyValueList(entries, { compact: true });
}

function renderEnvelopeValue(value, key = "") {
  if (value === null || value === undefined) {
    return `<span class="handoff-empty-value">not set</span>`;
  }
  if (Array.isArray(value)) {
    return renderReadList(value.map((item) => (typeof item === "object" ? JSON.stringify(item) : String(item))));
  }
  if (typeof value === "object") {
    return renderObjectAsKeyValue(value);
  }
  return renderInlineValue(value, key);
}

function renderCard({ title, kicker = null, content, className = "" }) {
  return `<article class="handoff-card${className ? ` ${escapeHtml(className)}` : ""}">
    ${kicker ? `<p class="handoff-card-kicker">${escapeHtml(kicker)}</p>` : ""}
    <h3>${escapeHtml(title)}</h3>
    <div class="handoff-card-body">${content}</div>
  </article>`;
}

function renderStatGrid(items) {
  const normalizedItems = Array.isArray(items) ? items.filter(Boolean) : [];
  if (normalizedItems.length === 0) {
    return `<p class="handoff-empty-copy">none</p>`;
  }
  return `<div class="handoff-stat-grid">${normalizedItems.map(({ label, valueHtml }) => `
    <div class="handoff-stat">
      <span class="handoff-stat-label">${escapeHtml(String(label))}</span>
      <span class="handoff-stat-value">${valueHtml}</span>
    </div>
  `).join("")}</div>`;
}

function buildIdentity(envelope) {
  if (!envelope?.target) {
    return "unknown";
  }
  const t = envelope.target;
  if (t.kind === "pr" || t.kind === "issue") {
    return `${t.repo || "?"}#${t.pr ?? t.issue ?? "?"}`;
  }
  if (t.kind === "local_branch") {
    return t.branch ? `branch:${t.branch}` : "branch:?";
  }
  if (t.kind === "local_phase") {
    return t.phase ? `phase:${t.phase}` : "phase:?";
  }
  return `${t.repo || "?"}#${t.pr ?? t.issue ?? "?"}`;
}

export function renderHandoffEnvelopeSection(envelope) {
  if (!envelope) {
    return `<section id="handoff-envelope-section" class="handoff-envelope-section">
      <div class="handoff-empty-state">
        <p class="handoff-card-kicker">Agent handoff</p>
        <h2>Envelope unavailable</h2>
        <p><em>Ensure buildDevLoopHandoffEnvelope() is callable and all inputs (resolver output, settings, gate state) are resolvable for the current PR.</em></p>
      </div>
    </section>`;
  }

  const identity = buildIdentity(envelope);
  const targetEntries = envelope.target
    ? Object.entries(envelope.target)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => ({ key, label: humanizeKey(key), valueHtml: renderInlineValue(value, key) }))
    : [{ key: "target", label: "Target", valueHtml: `<span class="handoff-empty-value">missing</span>` }];
  const currentStateEntries = [
    { key: "currentGate", label: humanizeKey("currentGate"), valueHtml: renderInlineValue(envelope.currentGate, "currentGate") },
    { key: "currentHeadSha", label: humanizeKey("currentHeadSha"), valueHtml: renderInlineValue(envelope.currentHeadSha, "currentHeadSha") },
    { key: "ciStatus", label: humanizeKey("ciStatus"), valueHtml: renderInlineValue(envelope.ciStatus, "ciStatus") },
    { key: "unresolvedThreadCount", label: humanizeKey("unresolvedThreadCount"), valueHtml: renderInlineValue(envelope.unresolvedThreadCount, "unresolvedThreadCount") },
    { key: "copilotRoundCount", label: humanizeKey("copilotRoundCount"), valueHtml: renderInlineValue(envelope.copilotRoundCount, "copilotRoundCount") },
    { key: "maxCopilotRounds", label: humanizeKey("maxCopilotRounds"), valueHtml: renderInlineValue(envelope.maxCopilotRounds, "maxCopilotRounds") },
    { key: "executionMode", label: humanizeKey("executionMode"), valueHtml: renderInlineValue(envelope.executionMode, "executionMode") },
  ];
  const policyEntries = [
    { key: "asyncStartMode", label: humanizeKey("asyncStartMode"), valueHtml: renderInlineValue(envelope.asyncStartMode, "asyncStartMode") },
    { key: "requireDraftFirst", label: humanizeKey("requireDraftFirst"), valueHtml: renderInlineValue(envelope.requireDraftFirst, "requireDraftFirst") },
  ];
  const isolationEntries = [
    { key: "cwd", label: humanizeKey("cwd"), valueHtml: renderInlineValue(envelope.cwd, "cwd") },
    { key: "worktreeRequired", label: humanizeKey("worktreeRequired"), valueHtml: renderInlineValue(envelope.worktreeRequired, "worktreeRequired") },
  ];
  const controlEntries = envelope.control ? [
    { key: "needsAttentionAfterMs", label: humanizeKey("needsAttentionAfterMs"), valueHtml: renderInlineValue(envelope.control.needsAttentionAfterMs, "needsAttentionAfterMs") },
    { key: "activeNoticeAfterMs", label: humanizeKey("activeNoticeAfterMs"), valueHtml: renderInlineValue(envelope.control.activeNoticeAfterMs, "activeNoticeAfterMs") },
  ] : [];

  return `<section id="handoff-envelope-section" class="handoff-envelope-section">
    <div class="handoff-hero">
      <div class="handoff-hero-copy">
        <p class="handoff-card-kicker">Agent handoff</p>
        <h2>${escapeHtml(identity)}</h2>
        <p class="handoff-hero-meta">Derived${envelope.derivedAt ? ` at ${escapeHtml(envelope.derivedAt)}` : ""} · Version ${escapeHtml(String(envelope.handoffVersion ?? "unknown"))}</p>
        <div class="handoff-hero-badges">
          ${renderBadge(`gate: ${envelope.currentGate ?? "not set"}`, toneForGate(envelope.currentGate))}
          ${renderBadge(`ci: ${envelope.ciStatus ?? "not set"}`, toneForCi(envelope.ciStatus))}
          ${renderBadge(`mode: ${envelope.executionMode ?? "not set"}`, "info")}
        </div>
      </div>
      <div class="handoff-hero-side">
        ${renderCard({
          title: "At a glance",
          kicker: "Summary",
          className: "handoff-card-tight",
          content: renderStatGrid([
            { label: "Artifact", valueHtml: renderInlineValue(envelope.target?.kind, "kind") },
            { label: "Target", valueHtml: renderInlineValue(envelope.target?.pr ?? envelope.target?.issue ?? envelope.target?.branch ?? envelope.target?.phase, "target") },
            { label: "Rounds", valueHtml: `<strong>${renderPlainValue(envelope.copilotRoundCount)}</strong> / ${renderPlainValue(envelope.maxCopilotRounds)}` },
            { label: "Isolation", valueHtml: renderInlineValue(envelope.worktreeRequired, "worktreeRequired") },
            { label: "Threads", valueHtml: renderPlainValue(envelope.unresolvedThreadCount) },
            { label: "Stop rules", valueHtml: renderPlainValue(Array.isArray(envelope.stopRules) ? envelope.stopRules.length : 0) },
          ]),
        })}
      </div>
    </div>

    <div class="handoff-layout">
      <div class="handoff-column handoff-column-side">
        ${renderCard({ title: "Target", kicker: "Identity", content: renderKeyValueList(targetEntries) })}
        ${renderCard({ title: "Current state", kicker: "Live status", content: renderKeyValueList(currentStateEntries) })}
        ${renderCard({ title: "Worktree / isolation", kicker: "Execution boundary", content: renderKeyValueList(isolationEntries) })}
        ${controlEntries.length > 0 ? renderCard({ title: "Runtime control", kicker: "Watch timers", content: renderKeyValueList(controlEntries) }) : ""}
      </div>

      <div class="handoff-column">
        ${renderCard({
          title: "Work directive",
          kicker: "Next step",
          className: "handoff-card-emphasis",
          content: `
            <div class="handoff-next-action"><p>${renderInlineValue(envelope.nextAction, "nextAction")}</p></div>
            <div class="handoff-subsection">
              <h4>Required reads</h4>
              ${renderReadList(envelope.requiredReads)}
            </div>
          `,
        })}

        ${envelope.gateConfig ? renderCard({
          title: "Gate configuration",
          kicker: "Review policy",
          content: `
            ${renderStatGrid([
              { label: "Angles", valueHtml: renderPlainValue(Array.isArray(envelope.gateConfig.angles) ? envelope.gateConfig.angles.length : 0) },
              { label: "Excluded", valueHtml: renderPlainValue(Array.isArray(envelope.gateConfig.excludeAngles) ? envelope.gateConfig.excludeAngles.length : 0) },
              { label: "Blockers", valueHtml: renderPlainValue(Array.isArray(envelope.gateConfig.blockCleanOnFindingSeverities) ? envelope.gateConfig.blockCleanOnFindingSeverities.length : 0) },
              { label: "Require CI", valueHtml: renderInlineValue(envelope.gateConfig.requireCi, "requireCi") },
            ])}
            <div class="handoff-subgrid">
              <div class="handoff-subsection">
                <h4>Review angles</h4>
                ${renderChipList(envelope.gateConfig.angles, "info")}
              </div>
              <div class="handoff-subsection">
                <h4>Excluded angles</h4>
                ${renderChipList(envelope.gateConfig.excludeAngles, "muted")}
                <h4>Block on severities</h4>
                ${Array.isArray(envelope.gateConfig.blockCleanOnFindingSeverities) && envelope.gateConfig.blockCleanOnFindingSeverities.length > 0
                  ? `<ul class="handoff-chip-list">${envelope.gateConfig.blockCleanOnFindingSeverities.map((severity) => `<li>${renderBadge(severity, toneForSeverity(severity))}</li>`).join("")}</ul>`
                  : renderChipList([], "muted")}
              </div>
            </div>
          `,
        }) : ""}

        ${renderCard({
          title: "Policy",
          kicker: "Operating rules",
          content: `
            ${renderKeyValueList(policyEntries)}
            <div class="handoff-subsection">
              <h4>Stop rules</h4>
              ${renderChipList(envelope.stopRules, "warning")}
            </div>
          `,
        })}

        ${envelope.acceptance ? renderCard({
          title: "Acceptance contract",
          kicker: "Done means",
          content: `
            ${renderStatGrid([
              { label: "Criteria", valueHtml: renderPlainValue(Array.isArray(envelope.acceptance.criteria) ? envelope.acceptance.criteria.length : 0) },
              { label: "Evidence", valueHtml: renderPlainValue(Array.isArray(envelope.acceptance.evidence) ? envelope.acceptance.evidence.length : 0) },
              { label: "Max finalization", valueHtml: renderInlineValue(envelope.acceptance.maxFinalizationTurns, "maxFinalizationTurns") },
            ])}
            <div class="handoff-subsection">
              <h4>Criteria</h4>
              ${renderCriteria(envelope.acceptance.criteria)}
            </div>
            <div class="handoff-subsection">
              <h4>Evidence</h4>
              ${renderChipList(envelope.acceptance.evidence, "neutral")}
            </div>
          `,
        }) : ""}

        ${envelope.overrides ? renderCard({
          title: "Explicit overrides",
          kicker: "Manual exceptions",
          content: renderObjectAsKeyValue(envelope.overrides),
        }) : ""}
      </div>
    </div>
  </section>`;
}
