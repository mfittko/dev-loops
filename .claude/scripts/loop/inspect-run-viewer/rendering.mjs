import {
  DEFAULT_INBOX_MODE,
  DEFAULT_INBOX_PAGE,
  DEFAULT_INBOX_PR_STATE,
  DEFAULT_INBOX_UPDATED_WITHIN_DAYS,
} from "./constants.mjs";
import {
  buildInspectionMermaidGraph,
  loadMermaidBrowserScript,
  renderMermaidBootScript,
  renderStateVisualizationSection,
  resetMermaidBrowserScriptCache,
} from "./graph.mjs";
import { renderInboxShellScript, renderInboxSidebar } from "./inbox.mjs";
import {
  deriveInboxSignalFromSnapshot,
  renderCopilotLayerSection,
  renderCurrentStateBanner,
  renderOuterLoopSummarySection,
  renderOverviewSection,
  renderReviewerLayerSection,
  renderSteeringSummarySection,
} from "./status.mjs";
import {
  escapeHtml,
  normalizeInboxSignal,
  renderSnapshotStateLabel,
  renderTargetKey,
} from "./shared.mjs";
import { renderHandoffEnvelopeSection } from "./handoff-envelope-renderer.mjs";

export {
  buildInspectionMermaidGraph,
  deriveInboxSignalFromSnapshot,
  loadMermaidBrowserScript,
  normalizeInboxSignal,
  renderTargetKey,
  resetMermaidBrowserScriptCache,
};

export function renderInspectRunViewerHtml({
  repo = null,
  target = null,
  snapshot = null,
  handoffEnvelope = null,
  error = null,
  inboxItems = [],
  selectedTitle = null,
  scopeOptions = [],
  inboxUpdatedWithinDays = DEFAULT_INBOX_UPDATED_WITHIN_DAYS,
  inboxState = DEFAULT_INBOX_PR_STATE,
  inboxMode = DEFAULT_INBOX_MODE,
  inboxPage = DEFAULT_INBOX_PAGE,
  inboxTotalPages = 1,
}) {
  const normalizedSnapshot = snapshot ?? null;
  const graph = target ? buildInspectionMermaidGraph(normalizedSnapshot) : null;
  const stateLabel = renderSnapshotStateLabel(normalizedSnapshot);
  const selectedInboxItem = target === null
    ? null
    : inboxItems.find((item) => renderTargetKey(item.target) === renderTargetKey(target)) ?? null;
  const effectiveSelectedTitle = selectedTitle ?? selectedInboxItem?.title ?? null;
  const scopeFilter = typeof repo === "string" && repo.length > 0 ? repo : null;
  const scopeLabel = scopeFilter ?? "all repos";
  const title = target
    ? `${target.repo}#${target.pr} inspection snapshot`
    : `${scopeLabel} PR inspection dashboard`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      *, *::before, *::after { box-sizing: border-box; }
      body { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 1.25rem; max-width: none; line-height: 1.55; color: #20384f; background: #fff; }
      code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; }
      code { padding: 0.12rem 0.38rem; border-radius: 0.42rem; background: #f4f8fd; color: #20496f; font-size: 0.94em; line-height: 1.45; overflow-wrap: anywhere; }
      pre { margin: 0; padding: 0.95rem 1rem; border: 1px solid #dbe6f3; border-radius: 0.85rem; background: #f8fbff; overflow: auto; line-height: 1.6; }
      pre code { padding: 0; border-radius: 0; background: transparent; color: inherit; }
      .inspection-shell { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 1.35rem; align-items: start; }
      .assigned-pr-inbox { position: sticky; top: 1.25rem; width: 22rem; max-width: 100%; border: 1px solid #d9e5f2; border-radius: 0.8rem; padding: 0.9rem; background: #fbfdff; max-height: calc(100vh - 2.5rem); overflow: auto; box-sizing: border-box; box-shadow: 0 1px 2px rgba(35, 69, 102, 0.05); }
      .assigned-pr-inbox[data-sidebar-collapsed="true"] { width: 2.35rem; overflow: hidden; padding: 0.28rem; border-color: transparent; background: transparent; box-shadow: none; }
      .assigned-pr-inbox[data-sidebar-collapsed="true"] h2,
      .assigned-pr-inbox[data-sidebar-collapsed="true"] .assigned-pr-controls,
      .assigned-pr-inbox[data-sidebar-collapsed="true"] .assigned-pr-filter-note,
      .assigned-pr-inbox[data-sidebar-collapsed="true"] .inbox-search-label,
      .assigned-pr-inbox[data-sidebar-collapsed="true"] .inbox-search-input,
      .assigned-pr-inbox[data-sidebar-collapsed="true"] .assigned-pr-list,
      .assigned-pr-inbox[data-sidebar-collapsed="true"] .assigned-pr-empty,
      .assigned-pr-inbox[data-sidebar-collapsed="true"] .assigned-pr-pagination { display: none; }
      .assigned-pr-inbox-header { display: flex; align-items: center; gap: 0.7rem; margin-bottom: 0.7rem; }
      .assigned-pr-inbox-header h2 { margin: 0; font-size: 1rem; line-height: 1.3; flex: 1; }
      .assigned-pr-controls { display: flex; flex-wrap: wrap; gap: 0.55rem 0.6rem; margin-bottom: 0.55rem; align-items: center; }
      .assigned-pr-control-row { display: flex; align-items: center; gap: 0.55rem; flex-wrap: wrap; }
      .assigned-pr-scope-row { align-items: center; }
      .assigned-pr-secondary-controls { flex: 999 1 18rem; flex-wrap: nowrap; }
      .assigned-pr-filter-label { display: inline-block; min-width: 3.6rem; margin: 0; font-size: 0.74rem; font-weight: 700; color: #355061; text-transform: uppercase; letter-spacing: 0.03em; }
      .assigned-pr-select { flex: 1; min-width: 0; max-width: 100%; border: 1px solid #bfd0e2; border-radius: 0.5rem; padding: 0.4rem 0.55rem; font: inherit; font-size: 0.83rem; line-height: 1.35; color: #355061; background: #fff; }
      .assigned-pr-select-mid { flex: 0 1 auto; width: min(7.25rem, 100%); max-width: 7.25rem; min-width: 5.2rem; }
      .assigned-pr-select-sm { flex: 0 1 auto; width: min(4.8rem, 100%); max-width: 4.8rem; min-width: 3.6rem; }
      .assigned-pr-select-updated { margin-left: auto; }
      .inbox-collapse-toggle { border: none; outline: none; box-shadow: none; appearance: none; -webkit-appearance: none; background: #355061; color: #fff; border-radius: 0.4rem; padding: 0.2rem 0.32rem; cursor: pointer; font-size: 1rem; line-height: 1; }
      .inbox-search-label { display: block; font-size: 0.82rem; font-weight: 600; color: #355061; margin-bottom: 0.3rem; margin-top: 0.2rem; }
      .inbox-search-input { width: 100%; border: 1px solid #bfd0e2; border-radius: 0.5rem; padding: 0.42rem 0.55rem; margin-bottom: 0.7rem; }
      .assigned-pr-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.55rem; }
      .assigned-pr-row { border: 1px solid #d6e0ea; border-left: 0.32rem solid #8ca3b8; border-radius: 0.6rem; background: #fff; }
      .assigned-pr-row.assigned-pr-row-attention { border-left-color: #c87400; }
      .assigned-pr-row.assigned-pr-row-pending { border-left-color: #b88900; }
      .assigned-pr-row.assigned-pr-row-gate { border-left-color: #6f42c1; }
      .assigned-pr-row.assigned-pr-row-ready { border-left-color: #2e7d32; }
      .assigned-pr-row.assigned-pr-row-closed { border-left-color: #7a8694; }
      .assigned-pr-row.assigned-pr-row-unknown { border-left-color: #8ca3b8; }
      .assigned-pr-row.assigned-pr-row-waiting { border-left-color: #1565c0; }
      .assigned-pr-link { display: block; padding: 0.56rem 0.65rem; color: inherit; text-decoration: none; }
      .assigned-pr-row.is-selected .assigned-pr-link { box-shadow: inset 0 0 0 1px #1565c0; border-radius: 0.3rem; }
      .assigned-pr-title-line { display: flex; align-items: flex-start; gap: 0.5rem; }
      .assigned-pr-id-col { display: flex; flex-direction: column; align-items: center; flex-shrink: 0; min-width: 2.4rem; margin-right: 0.15rem; }
      .assigned-pr-id { font-weight: 700; line-height: 1.2; }
      .assigned-pr-signal-emoji { font-size: 0.65rem; line-height: 1.2; }
      .assigned-pr-title { font-weight: 600; min-width: 0; flex: 1 1 auto; line-height: 1.45; }
      .assigned-pr-line + .assigned-pr-line { margin-top: 0.28rem; }
      .assigned-pr-meta { display: flex; flex-wrap: wrap; gap: 0.3rem 0.45rem; font-size: 0.78rem; line-height: 1.45; color: #486174; }
      .assigned-pr-meta-primary { justify-content: space-between; align-items: baseline; gap: 0.5rem; }
      .assigned-pr-meta-primary .assigned-pr-repo { text-align: left; min-width: 0; }
      .assigned-pr-meta-primary .assigned-pr-updated { margin-left: auto; text-align: right; white-space: nowrap; }
      .assigned-pr-pagination { display: flex; align-items: center; justify-content: center; gap: 0.6rem; margin-top: 0.75rem; }
      .assigned-pr-page-link { color: #5b2ca0; text-decoration: none; font-weight: 700; }
      .assigned-pr-page-link.is-disabled { color: #9aa9b8; pointer-events: none; }
      .assigned-pr-page-status { font-weight: 700; color: #253b53; }
      .inspection-main { min-width: 0; }
      .current-pr-state-banner { position: relative; border: 1px solid #d7e3f4; border-radius: 1rem; background: linear-gradient(180deg, #ffffff 0%, #f6fbff 100%); box-shadow: 0 1px 2px rgba(35, 69, 102, 0.06); padding: 1.2rem 1.3rem 4.65rem; margin-top: 0; display: grid; gap: 0.9rem; }
      .current-pr-state-heading-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 0.9rem; }
      .current-pr-state-heading-copy { min-width: 0; display: grid; gap: 0.35rem; }
      .current-pr-state-kicker { margin: 0; font-size: 0.82rem; font-weight: 800; letter-spacing: 0.06em; text-transform: uppercase; color: #486174; }
      .current-pr-state-kicker a { color: #355061; text-decoration: none; }
      .current-pr-state-kicker a:hover { text-decoration: underline; }
      .current-pr-state-mode-indicator { flex: 0 0 auto; font-size: 1.75rem; line-height: 1; margin-top: 0.08rem; }
      .current-pr-state-banner h1 { margin: 0; font-size: 2rem; line-height: 1.12; color: #18324a; overflow-wrap: anywhere; }
      .current-pr-state-copy-flow { display: grid; gap: 0.7rem; min-width: 0; }
      .current-pr-state-summary-headline { margin: 0; color: #1565c0; font-size: 1.08rem; line-height: 1.35; }
      .current-pr-state-detail { margin: 0; color: #274766; font-size: 1rem; line-height: 1.6; max-width: 78ch; }
      .current-pr-state-meta { margin: 0; color: #5a758b; font-size: 0.84rem; line-height: 1.5; }
      .current-pr-state-note { margin: 0; color: #5a758b; font-size: 0.92rem; line-height: 1.55; max-width: 78ch; }
      .current-pr-state-badge-row { margin-top: 0; }
      .current-pr-state-controls { position: absolute; right: 1.3rem; bottom: 1.2rem; display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 0.5rem 0.6rem; max-width: calc(100% - 2.6rem); }
      .current-pr-state-auto-reload-label { display: inline-flex; align-items: center; gap: 0.32rem; margin: 0; font-size: 0.78rem; font-weight: 700; color: #486174; }
      .current-pr-state-auto-reload-select { min-width: 7.4rem; border: 1px solid #bfd0e2; border-radius: 0.5rem; padding: 0.4rem 0.55rem; font: inherit; font-size: 0.83rem; line-height: 1.35; color: #355061; background: #fff; }
      .current-pr-state-reload { flex: 0 0 auto; }
      .current-pr-state-reload[hidden] { display: none; }
      .viewer-badge-row { display: flex; flex-wrap: wrap; gap: 0.5rem 0.6rem; align-items: flex-start; }
      .viewer-card-grid { display: grid; gap: 1.15rem; align-items: start; }
      .viewer-card-grid-overview { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .viewer-card-grid-layers { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .viewer-tab-section { border: none; background: none; padding: 0; margin-top: 1.15rem; }
      .viewer-tab-shell { position: sticky; top: 0.8rem; z-index: 4; border: 1px solid #d7e3f4; border-radius: 0.95rem; background: rgba(251, 253, 255, 0.96); backdrop-filter: blur(6px); padding: 0.4rem; margin-top: 1rem; box-shadow: 0 1px 2px rgba(35, 69, 102, 0.06); }
      .viewer-tabs { display: flex; flex-wrap: wrap; gap: 0.45rem; margin: 0; }
      .viewer-tab { padding: 0.68rem 1rem; cursor: pointer; border: 1px solid transparent; border-radius: 0.7rem; background: transparent; font: inherit; font-weight: 700; line-height: 1.25; color: #486174; transition: color 0.15s, border-color 0.15s, background 0.15s, box-shadow 0.15s; }
      .viewer-tab:hover { color: #1565c0; background: #f4f9ff; }
      .viewer-tab.active { color: #1565c0; background: #fff; border-color: #c8d9ec; box-shadow: 0 1px 2px rgba(35, 69, 102, 0.08); }
      .tab-content { display: none; }
      .tab-content.active { display: block; }
      .viewer-card { min-width: 0; }
      .viewer-card-body,
      .handoff-card-body,
      .viewer-card-list-block,
      .viewer-graph-header,
      .handoff-hero-copy { display: grid; gap: 0.7rem; min-width: 0; }
      .viewer-card-list-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.9rem; margin-top: 1rem; }
      .viewer-card-list-block h4,
      .viewer-card-subsection h4,
      .viewer-graph-header h3 { margin: 0; font-size: 0.9rem; font-weight: 700; line-height: 1.35; color: #486174; }
      .viewer-card-subsection { margin-top: 1.1rem; display: grid; gap: 0.55rem; }
      .viewer-card-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.55rem; }
      .viewer-card-list li { border: 1px solid #dbe6f3; border-radius: 0.65rem; background: #fbfdff; padding: 0.65rem 0.8rem; color: #23384d; line-height: 1.5; }
      .viewer-card-actions { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: center; margin-top: 1.1rem; }
      .viewer-action-button { border: 1px solid #bfd0e2; border-radius: 0.55rem; background: #fff; color: #355061; padding: 0.5rem 0.78rem; font: inherit; font-weight: 700; line-height: 1.35; cursor: pointer; }
      .viewer-action-button:hover { background: #f4f9ff; }
      .viewer-inline-link { color: #2456a6; font-weight: 600; line-height: 1.4; text-decoration: none; }
      .viewer-inline-link:hover { text-decoration: underline; }
      .viewer-stat-grid-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .viewer-stat-grid-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .viewer-next-action { margin-bottom: 0; }
      .viewer-graph-header { margin-bottom: 0; }
      .viewer-graph-description { margin: 0.7rem 0 0 0; color: #6b8296; font-size: 0.82rem; line-height: 1.5; }
      .state-graph-block { margin-top: 0.25rem; }
      .state-graph-frame { margin-top: 0.75rem; min-width: 0; border: 1px solid #d7e3f4; border-radius: 0.85rem; background: linear-gradient(180deg, #fbfdff 0%, #f4f8fc 100%); overflow: hidden; }
      .state-graph-toolbar { display: flex; align-items: center; gap: 0.55rem; padding: 0.75rem 0.85rem; border-bottom: 1px solid #d7e3f4; background: rgba(255,255,255,0.85); }
      .state-graph-toolbar button { border: 1px solid #9fb6cb; background: #fff; border-radius: 0.45rem; padding: 0.38rem 0.72rem; font: inherit; font-weight: 600; line-height: 1.25; cursor: pointer; }
      .state-graph-toolbar button:hover { background: #f3f8fd; }
      .state-graph-zoom-value { margin-left: auto; font-size: 0.92rem; line-height: 1.4; color: #486174; }
      .viewer-graph-body,
      .state-graph-block { min-width: 0; }
      .mermaid-state-graph { min-height: 21rem; min-width: 0; max-width: 100%; padding: 1rem; overflow: auto; cursor: grab; user-select: none; touch-action: none; }
      .mermaid-state-graph[data-dragging="true"] { cursor: grabbing; }
      .mermaid-state-graph[data-rendered="pending"] { color: #5a7184; opacity: 0; pointer-events: none; }
      .mermaid-state-graph[data-rendered="settling"] { opacity: 0; pointer-events: none; }
      .mermaid-state-graph svg { display: block; width: 100%; height: auto; transition: width 120ms ease; }
      .state-graph-cues { display: flex; flex-wrap: wrap; gap: 0.55rem 0.85rem; margin: 1rem 0 0.2rem 0; }
      .state-graph-cue { display: inline-flex; align-items: center; gap: 0.45rem; font-size: 0.9rem; line-height: 1.45; color: #355061; }
      .state-graph-cue-chip { display: inline-flex; align-items: center; justify-content: center; min-width: 2.5rem; padding: 0.22rem 0.58rem; border-radius: 999px; border: 1px solid #90a4ae; background: #fff; font-weight: 700; line-height: 1.2; }
      .state-graph-cue-chip-start { border-color: #78909c; background: #f5f7f9; }
      .state-graph-cue-chip-current { border-color: #1565c0; background: #e3f2fd; }
      .state-graph-cue-chip-next { border-color: #5c6bc0; background: #f3f4ff; }
      .state-graph-cue-chip-end { border-color: #2e7d32; background: #e8f5e9; }
      .state-graph-cue-chip-loop { border-color: #ef6c00; background: #fff3e0; }
      .state-graph-details { margin-top: 0.9rem; }
      .state-graph-details summary { cursor: pointer; font-weight: 600; line-height: 1.4; color: #355061; }
      .state-graph-help { margin: 0.85rem 0 1rem 1.2rem; padding: 0; line-height: 1.55; color: #425d70; }
      .state-graph-help li + li { margin-top: 0.4rem; }
      .state-graph-render-error { margin: 0; padding: 1rem; line-height: 1.55; color: #7f4b00; }
      .state-graph-summaries { margin: 1rem 0 0 0; padding-left: 1.2rem; line-height: 1.55; }
      .state-graph-summary + .state-graph-summary { margin-top: 0.45rem; }
      dl { display: grid; grid-template-columns: 14rem 1fr; gap: 0.5rem 0.95rem; }
      dt { font-weight: 600; line-height: 1.4; }
      dd { margin: 0; line-height: 1.55; overflow-wrap: anywhere; }
      section { border: 1px solid #ddd; border-radius: 0.5rem; padding: 0.9rem; margin-top: 1.1rem; }
      .handoff-envelope-section { border-color: #d7e3f4; background: linear-gradient(180deg, #fbfdff 0%, #f7fbff 100%); padding: 1.05rem 1.15rem; }
      .handoff-hero { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(18rem, 0.9fr); gap: 1.15rem; align-items: start; }
      .handoff-hero h2 { margin: 0; font-size: 1.9rem; line-height: 1.14; overflow-wrap: anywhere; }
      .handoff-card-kicker { margin: 0; font-size: 0.76rem; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; color: #486174; }
      .handoff-hero-meta { margin: 0; line-height: 1.55; color: #486174; }
      .handoff-hero-badges { display: flex; flex-wrap: wrap; gap: 0.5rem 0.6rem; margin-top: 0; }
      .handoff-layout { display: grid; grid-template-columns: minmax(17rem, 24rem) minmax(0, 1fr); gap: 1.15rem; margin-top: 1.15rem; align-items: start; }
      .handoff-column { display: grid; gap: 1.15rem; align-content: start; }
      .handoff-card { border: 1px solid #d7e3f4; border-radius: 0.85rem; background: #fff; box-shadow: 0 1px 2px rgba(35, 69, 102, 0.06); padding: 1.1rem 1.15rem; display: grid; gap: 0.75rem; align-content: start; }
      .handoff-card h3 { margin: 0; font-size: 1.05rem; line-height: 1.3; color: #23384d; }
      .handoff-card-tight { height: 100%; }
      .handoff-card-emphasis { background: linear-gradient(180deg, #ffffff 0%, #f6faff 100%); }
      .handoff-stat-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.8rem; }
      .handoff-stat { border: 1px solid #dbe6f3; border-radius: 0.7rem; background: #fbfdff; padding: 0.8rem 0.9rem; }
      .handoff-stat-label { display: block; font-size: 0.76rem; font-weight: 700; line-height: 1.35; color: #567086; margin-bottom: 0.35rem; }
      .handoff-stat-value { display: block; color: #20384f; font-weight: 700; line-height: 1.35; overflow-wrap: anywhere; }
      .handoff-empty-state { border: 1px dashed #b8c9db; border-radius: 0.85rem; background: #fff; padding: 1.35rem; display: grid; gap: 0.6rem; }
      .handoff-empty-state h2 { margin: 0; line-height: 1.2; }
      .handoff-empty-state p { margin: 0; line-height: 1.6; }
      .handoff-kv { display: grid; grid-template-columns: minmax(9rem, 12rem) minmax(0, 1fr); gap: 0.8rem 1rem; margin: 0; }
      .handoff-kv-compact { grid-template-columns: minmax(9rem, 15rem) minmax(0, 1fr); }
      .handoff-kv-row { display: contents; }
      .handoff-kv dt { font-size: 0.79rem; font-weight: 700; line-height: 1.4; color: #4c6478; word-break: break-word; }
      .handoff-kv dd { margin: 0; min-width: 0; line-height: 1.55; color: #23384d; word-break: break-word; }
      .handoff-badge { display: inline-flex; align-items: center; justify-content: center; padding: 0.28rem 0.7rem; border-radius: 999px; border: 1px solid #b8c9db; background: #f6f9fc; color: #355061; font-size: 0.84rem; font-weight: 700; line-height: 1.25; }
      .handoff-badge-success { border-color: #9dd4a2; background: #edf8ee; color: #25632a; }
      .handoff-badge-warning { border-color: #f2c37b; background: #fff4de; color: #915800; }
      .handoff-badge-danger { border-color: #efb0b0; background: #fff0f0; color: #9f2c2c; }
      .handoff-badge-info { border-color: #b5cdef; background: #edf4ff; color: #2456a6; }
      .handoff-badge-muted { border-color: #d5dde7; background: #f5f7fa; color: #5e7283; }
      .handoff-badge-neutral { border-color: #d5dde7; background: #f5f7fa; color: #5e7283; }
      .handoff-next-action { font-size: 1rem; line-height: 1.6; color: #1f354b; padding: 1rem 1.05rem; border: 1px solid #dce8f5; border-radius: 0.8rem; background: linear-gradient(180deg, #fbfdff 0%, #f4f9ff 100%); }
      .handoff-next-action p { margin: 0; }
      .handoff-subsection + .handoff-subsection { margin-top: 1.1rem; }
      .handoff-subgrid { display: grid; grid-template-columns: 1.6fr minmax(12rem, 0.9fr); gap: 1.05rem; align-items: start; }
      .handoff-subsection { display: grid; gap: 0.55rem; }
      .handoff-subsection h4 { margin: 0; font-size: 0.85rem; font-weight: 700; line-height: 1.35; color: #486174; }
      .handoff-chip-list,
      .handoff-read-list,
      .handoff-criteria-list { margin: 0; padding: 0; list-style: none; }
      .handoff-chip-list { display: flex; flex-wrap: wrap; gap: 0.55rem 0.6rem; align-items: flex-start; }
      .handoff-chip-list li,
      .handoff-read-list li { min-width: 0; }
      .handoff-chip-list code,
      .handoff-read-list code,
      .handoff-kv code,
      .viewer-card code,
      .current-pr-state-banner code { overflow-wrap: anywhere; }
      .handoff-read-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.55rem; }
      .handoff-read-list li { padding: 0.62rem 0.78rem; border: 1px solid #dbe6f3; border-radius: 0.65rem; background: #fbfdff; line-height: 1.5; }
      .handoff-read-list code { color: #20496f; }
      .handoff-criteria-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.8rem; }
      .handoff-criteria-item { border: 1px solid #dbe6f3; border-left: 0.32rem solid #6d90c6; border-radius: 0.75rem; padding: 0.85rem; background: #fbfdff; }
      .handoff-criteria-header { display: flex; align-items: center; gap: 0.55rem; flex-wrap: wrap; margin-bottom: 0.55rem; }
      .handoff-criteria-item p { margin: 0; line-height: 1.55; color: #304a62; }
      .handoff-empty-copy,
      .handoff-empty-value { color: #708497; }
      .current-pr-state-banner section,
      .current-pr-state-banner .state-graph-block,
      .current-pr-state-banner .current-pr-state-visualization { border: none; padding: 0; margin-top: 0; }
      @media (max-width: 1100px) {
        .viewer-card-grid-overview,
        .viewer-card-grid-layers,
        .viewer-card-list-grid,
        .viewer-stat-grid-3 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      }
      @media (max-width: 900px) {
        body { margin: 1rem; }
        .inspection-shell { grid-template-columns: minmax(0, 1fr); }
        .assigned-pr-inbox { position: static; max-height: none; }
        .handoff-hero,
        .handoff-layout,
        .handoff-subgrid,
        .handoff-criteria-list,
        .handoff-read-list,
        .viewer-card-grid-overview,
        .viewer-card-grid-layers,
        .viewer-card-list-grid { grid-template-columns: 1fr; }
        .handoff-stat-grid,
        .viewer-stat-grid-2,
        .viewer-stat-grid-3 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      }
      @media (max-width: 640px) {
        body { margin: 0.75rem; }
        section,
        .handoff-envelope-section { padding: 0.9rem; }
        .viewer-tab-shell { top: 0.5rem; }
        .state-graph-toolbar { flex-wrap: wrap; }
        .state-graph-zoom-value { margin-left: 0; }
        .assigned-pr-secondary-controls { flex-wrap: wrap; }
        .assigned-pr-select-mid,
        .assigned-pr-select-sm,
        .assigned-pr-select-updated { width: 100%; max-width: none; margin-left: 0; flex: 1 1 6rem; }
        .current-pr-state-banner { padding-bottom: 0.9rem; }
        .current-pr-state-controls { position: static; justify-content: flex-start; max-width: none; }
        .current-pr-state-auto-reload-select { min-width: 0; flex: 1 1 8rem; }
        .handoff-kv,
        .handoff-kv-compact,
        .handoff-stat-grid,
        .viewer-stat-grid-2,
        .viewer-stat-grid-3 { grid-template-columns: 1fr; }
        .viewer-action-button,
        .viewer-inline-link { width: 100%; }
      }
    </style>
  </head>
  <body>
    <div class="inspection-shell">
      ${renderInboxSidebar(inboxItems, target, { scopeFilter, scopeOptions, updatedWithinDays: inboxUpdatedWithinDays, state: inboxState, mode: inboxMode, page: inboxPage, totalPages: inboxTotalPages })}
      <main class="inspection-main">
        ${target === null
          ? `<section class="current-pr-state-banner" aria-label="${escapeHtml(scopeLabel)} PR inspection dashboard">
              <div class="current-pr-state-heading-row">
                <div class="current-pr-state-heading-copy">
                  <p class="current-pr-state-kicker">Inspection dashboard</p>
                  <h1>${escapeHtml(scopeLabel)} PR inspection dashboard</h1>
                </div>
              </div>
              <p class="current-pr-state-summary-headline"><strong>No PR selected</strong></p>
              <p class="current-pr-state-detail">This local/operator dashboard is read-only. inspect-run remains authoritative for inspection/status state while this UI owns inbox discovery plus read-only presentation/prioritization.</p>
              <p class="current-pr-state-note">No assigned PR in ${escapeHtml(scopeLabel)} matched the current view yet. Pick a PR from the sidebar, widen the state or updated filters, or move to another inbox page.</p>
            </section>
            <section class="viewer-tab-section" aria-label="Dashboard empty state">
              <div class="handoff-empty-state">
                <h2>Choose a PR from sidebar</h2>
                <p>The dashboard can span all assigned repos or be narrowed to one repo. Sidebar defaults to open PRs from last 7 days and paginates through result set.</p>
              </div>
            </section>`
          : `${renderCurrentStateBanner(normalizedSnapshot, target, stateLabel, effectiveSelectedTitle)}
            <div class="viewer-tab-shell" role="tablist" aria-label="Inspect run viewer tabs">
              <div class="viewer-tabs">
                <button id="tab-btn-overview" class="viewer-tab active" role="tab" aria-selected="true" aria-controls="tab-overview" data-tab="overview" onclick="switchTab('overview')">Overview</button>
                <button id="tab-btn-graph" class="viewer-tab" role="tab" aria-selected="false" aria-controls="tab-graph" data-tab="graph" onclick="switchTab('graph')">Graph</button>
                <button id="tab-btn-layers" class="viewer-tab" role="tab" aria-selected="false" aria-controls="tab-layers" data-tab="layers" onclick="switchTab('layers')">Layers</button>
                <button id="tab-btn-handoff" class="viewer-tab" role="tab" aria-selected="false" aria-controls="tab-handoff" data-tab="handoff" onclick="switchTab('handoff')">Agent handoff</button>
              </div>
            </div>
            <div class="tab-content active" id="tab-overview" role="tabpanel" aria-labelledby="tab-btn-overview">
              ${renderOverviewSection(normalizedSnapshot)}
            </div>
            <div class="tab-content" id="tab-graph" role="tabpanel" aria-labelledby="tab-btn-graph">
              <section class="viewer-tab-section" aria-label="Graph">
                <article class="handoff-card handoff-card-emphasis viewer-card">
                  <p class="handoff-card-kicker">Graph</p>
                  <div class="viewer-graph-header">
                    <h3>Full state machine graph</h3>
                  </div>
                  ${graph === null
                    ? `<p>${escapeHtml(error?.message ?? "Unable to load inspect-run snapshot.")}</p><p>Snapshot unavailable, so no state graph can be rendered yet. Use the Reload snapshot control to refresh.</p>`
                    : `<div class="viewer-graph-body">${renderStateVisualizationSection(normalizedSnapshot, graph)}</div>`}
                  <p class="viewer-graph-description">Use zoom controls, drag, and the graph guide below to inspect current and next-state cues.</p>
                </article>
              </section>
            </div>
            <div class="tab-content" id="tab-layers" role="tabpanel" aria-labelledby="tab-btn-layers">
              <section class="viewer-tab-section" aria-label="Layers">
                <div class="viewer-card-grid viewer-card-grid-layers">
                  ${renderOuterLoopSummarySection(normalizedSnapshot)}
                  ${renderCopilotLayerSection(normalizedSnapshot?.layers?.copilot, normalizedSnapshot)}
                  ${renderReviewerLayerSection(normalizedSnapshot?.layers?.reviewer)}
                  ${renderSteeringSummarySection(normalizedSnapshot?.layers?.steering)}
                </div>
              </section>
            </div>
            <div class="tab-content" id="tab-handoff" role="tabpanel" aria-labelledby="tab-btn-handoff">
              ${renderHandoffEnvelopeSection(handoffEnvelope)}
            </div>`}
      </main>
    </div>
    ${renderInboxShellScript()}
    <script>
      function switchTab(tabName) {
        document.querySelectorAll('.viewer-tab').forEach(t => {
          t.classList.remove('active');
          t.setAttribute('aria-selected', 'false');
        });

        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        const activeTab = document.querySelector('.viewer-tab[data-tab="' + tabName + '"]');
        if (!activeTab) { return; }
        activeTab.classList.add('active');
        activeTab.setAttribute('aria-selected', 'true');
        const panel = document.getElementById('tab-' + tabName);
        if (panel) {
          panel.classList.add('active');
        }
        document.dispatchEvent(new CustomEvent('inspect-run-viewer:tabchange', { detail: { tabName } }));
      }
    </script>
    ${graph === null ? "" : renderMermaidBootScript()}
  </body>
</html>`;
}
