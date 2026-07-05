// Generates the "State atlas" page for the GitHub Pages site: every dev-loops
// state machine rendered as a mermaid diagram, emitted DETERMINISTICALLY from
// the code's own exported tables so the page can never drift from the code.
//
// Four diagrams come straight from packages/core/src/loop tables (copilot loop,
// reviewer loop, outer conductor routing, and the public dev-loop gate hub); two
// more are authored from documented, table-less sources (the PR lifecycle
// contract and the release pipeline workflow).
//
// The page reuses the article design system (docs/articles/introducing-dev-loops.html):
// the same :root tokens, body gradient, and typography. It intentionally defines
// a <style> block and a <body> tag so build-site.mjs can inject the shared nav
// (NAV_CSS references --heading/--kicker/--accent-soft, all declared here).
import { STATE, TRANSITIONS } from '../../packages/core/src/loop/copilot-loop-state.mjs';
import { REVIEWER_STATE, REVIEWER_TRANSITIONS } from '../../packages/core/src/loop/reviewer-loop-state.mjs';
import { OUTER_STATE, OUTER_TRANSITIONS } from '../../packages/core/src/loop/conductor-routing.mjs';
import { PUBLIC_DEV_LOOP_GATE_CONTRACT } from '../../packages/core/src/loop/public-dev-loop-routing-contract.mjs';

// Classify a state/gate id by name into one of four visual classes. Colors are
// drawn from the site's own dark palette (accent violet, kicker blue,
// accent-soft, and the card-border slate) so diagrams sit natively in the skin.
const WAIT = /waiting|watch/;
const STOP = /blocked|unavailable|stop|needs_human|reconcile|invalidated|conflict/;
const TERM = /done|terminal|complete|merged/;
// TERM is tested before STOP so names carrying both (e.g. stop_done_terminal)
// classify as terminal, not blocked. `conflict` is a stop keyword: a conflicted
// head is a blocked/detour state, never active progress.
function classify(name) {
  if (WAIT.test(name)) return 'wait';
  if (TERM.test(name)) return 'term';
  if (STOP.test(name)) return 'stop';
  return 'act';
}

// classDef colors sourced from the article design tokens: --accent #a78bfa,
// --kicker #93c5fd, --accent-soft #ddd6fe, slate #94a3b8, ground #0f172a.
const CLASSDEFS = [
  '    classDef act fill:#171532,stroke:#a78bfa,stroke-width:1px,color:#e5e7eb;',
  '    classDef wait fill:#0f1d33,stroke:#93c5fd,stroke-width:1px,color:#e5e7eb;',
  '    classDef term fill:#1c1a3a,stroke:#ddd6fe,stroke-width:1.5px,color:#f8fafc;',
  '    classDef stop fill:#1a2233,stroke:#94a3b8,stroke-width:1px,color:#cbd5e1,stroke-dasharray:4 2;',
];

// A state with no legal transitions in its table is terminal → edge to [*].
function edgesFromTransitions(values, transitions) {
  const edges = [];
  for (const s of values) {
    const targets = transitions[s] ?? [];
    if (targets.length === 0) edges.push([s, '[*]']);
    else for (const t of targets) edges.push([s, t]);
  }
  return edges;
}

// Note: mermaid sources are HTML-escaped (& then <) when embedded into the page
// (see sectionMarkup), so the browser's parser hands mermaid the exact source
// back via textContent. Every id here is snake_case and every label is HTML-free,
// so the escaping is defense-in-depth against future drift, not load-bearing:
// today's sources contain `>` (in `-->` arrows) but never `<` or `&`, and the
// arrows survive verbatim in the built bytes for the atlas tests.
function renderStateDiagram(edges, states) {
  const lines = ['stateDiagram-v2'];
  for (const [a, b] of edges) lines.push(`    ${a} --> ${b}`);
  lines.push(...CLASSDEFS);
  for (const s of states) lines.push(`    class ${s} ${classify(s)}`);
  return lines.join('\n');
}

// The public dev-loop gate contract as a router → gates flowchart hub: one edge
// per row, labelled with routeKind; each gate node shows gate id + strategy.
// Gates carry their own routeKind, so color by it (route→act, wait→wait,
// stop/needs_reconcile→stop) instead of the name heuristic — e.g.
// waiting_for_merge_authorization names "waiting" but its routeKind is stop.
// Terminal-named gates (stop_done_terminal) still classify as term.
function gateClass(row) {
  if (TERM.test(row.gate)) return 'term';
  if (row.routeKind === 'route') return 'act';
  if (row.routeKind === 'wait') return 'wait';
  return 'stop';
}

function renderGateFlowchart(contract) {
  const lines = ['flowchart TD', '    router(["dev-loop router"])'];
  for (const row of contract) {
    const strategy = row.selectedStrategy ?? 'none';
    lines.push(`    router -->|${row.routeKind}| ${row.gate}["${row.gate} — ${strategy}"]`);
  }
  lines.push(...CLASSDEFS);
  for (const row of contract) lines.push(`    class ${row.gate} ${gateClass(row)}`);
  return lines.join('\n');
}

// --- Code-derived diagrams (single source of truth = the exported tables) ---
const copilotDiagram = renderStateDiagram(
  edgesFromTransitions(Object.values(STATE), TRANSITIONS),
  Object.values(STATE),
);
const reviewerDiagram = renderStateDiagram(
  edgesFromTransitions(Object.values(REVIEWER_STATE), REVIEWER_TRANSITIONS),
  Object.values(REVIEWER_STATE),
);
const outerDiagram = renderStateDiagram(
  edgesFromTransitions(Object.values(OUTER_STATE), OUTER_TRANSITIONS),
  Object.values(OUTER_STATE),
);
const gateDiagram = renderGateFlowchart(PUBLIC_DEV_LOOP_GATE_CONTRACT);

// --- Statically-authored diagrams (documented, table-less sources) ---

// PR lifecycle: the 13-state vocabulary + required transitions from
// skills/docs/pr-lifecycle-contract.md.
const prLifecycleStates = [
  'draft_local_review_gate',
  'draft_local_remediation',
  'ready_state_needs_copilot_request',
  'waiting_for_copilot_review',
  'copilot_feedback_remediation',
  'copilot_reply_resolve_pending',
  'merge_conflict_resolution',
  'final_local_preapproval_gate',
  'final_gate_remediation',
  'waiting_for_human_pr_approval',
  'waiting_for_merge',
  'terminal_slice_complete',
  'stopped_needs_user_decision',
];
const prLifecycleDiagram = renderStateDiagram([
  ['draft_local_review_gate', 'draft_local_remediation'],
  ['draft_local_review_gate', 'ready_state_needs_copilot_request'],
  ['draft_local_review_gate', 'stopped_needs_user_decision'],
  ['draft_local_remediation', 'draft_local_review_gate'],
  ['ready_state_needs_copilot_request', 'waiting_for_copilot_review'],
  ['ready_state_needs_copilot_request', 'stopped_needs_user_decision'],
  ['waiting_for_copilot_review', 'copilot_feedback_remediation'],
  ['copilot_feedback_remediation', 'copilot_reply_resolve_pending'],
  ['copilot_reply_resolve_pending', 'ready_state_needs_copilot_request'],
  ['waiting_for_copilot_review', 'merge_conflict_resolution'],
  ['merge_conflict_resolution', 'waiting_for_copilot_review'],
  ['waiting_for_copilot_review', 'final_local_preapproval_gate'],
  ['final_local_preapproval_gate', 'final_gate_remediation'],
  ['final_local_preapproval_gate', 'waiting_for_human_pr_approval'],
  ['final_gate_remediation', 'final_local_preapproval_gate'],
  ['waiting_for_human_pr_approval', 'waiting_for_merge'],
  ['waiting_for_human_pr_approval', 'draft_local_review_gate'],
  ['waiting_for_merge', 'terminal_slice_complete'],
  ['terminal_slice_complete', '[*]'],
  ['stopped_needs_user_decision', '[*]'],
], prLifecycleStates);

// Release pipeline: the fail-closed gate chain from .github/workflows/release.yml.
const releasePipelineNodes = [
  'push_tag',
  'ancestry',
  'lockstep',
  'exists',
  'changelog',
  'create',
  'done_release_published',
  'done_idempotent_skip',
  'stop_not_on_main',
  'stop_core_mismatch',
  'stop_changelog_missing',
];
const releaseDiagram = [
  'flowchart TD',
  '    push_tag(["push v* tag"])',
  '    push_tag --> ancestry{"commit is ancestor of origin/main?"}',
  '    ancestry -->|no| stop_not_on_main["stopped: not on main"]',
  '    ancestry -->|yes| lockstep{"@dev-loops/core dep in lockstep?"}',
  '    lockstep -->|no| stop_core_mismatch["stopped: core version mismatch"]',
  '    lockstep -->|yes| exists{"release already exists?"}',
  '    exists -->|yes| done_idempotent_skip["done: idempotent skip"]',
  '    exists -->|no| changelog{"CHANGELOG section extractable?"}',
  '    changelog -->|no| stop_changelog_missing["stopped: changelog missing"]',
  '    changelog -->|yes| create["gh release create --verify-tag"]',
  '    create --> done_release_published["done: release published, fires npm-publish"]',
  ...CLASSDEFS,
  ...releasePipelineNodes.map((n) => `    class ${n} ${classify(n)}`),
].join('\n');

// ---------------------------------------------------------------------------
// Hand-authored explanatory prose.
//
// This is the ONLY hand-written content on the page: the diagrams above are
// generated from the code tables; the words below are authored from the
// documented contracts. Keeping the two apart in this module makes the split
// explicit — if a diagram and its prose disagree, the diagram (the code) wins.
// ---------------------------------------------------------------------------

const INTRO_PROSE = [
  'dev-loops drives every pull request through closed, deterministic state machines. Workflow control lives in the graph; agent judgment enters only as bounded, explicit inputs, never as hidden orchestration. Exactly one state applies at a time, and each state exposes the legal transitions out of it.',
  "Every diagram on this page is generated at site-build time from the code's own exported tables — the copilot loop's <code>STATE</code>/<code>TRANSITIONS</code>, the reviewer loop's <code>REVIEWER_STATE</code>/<code>REVIEWER_TRANSITIONS</code>, the outer loop's <code>OUTER_STATE</code>/<code>OUTER_TRANSITIONS</code>, and the public router's <code>PUBLIC_DEV_LOOP_GATE_CONTRACT</code>. They cannot drift from the code: change a transition table and this page changes with it. Two diagrams (the PR lifecycle and the release pipeline) are authored from documented contracts that have no single code table.",
  'The state names are not labels for a picture — they are the literal contract identifiers that appear in logs, handoff envelopes, and gate artifacts. Nodes are coloured by role: <strong>active / in-progress</strong> steps the loop advances itself, <strong>waiting-on-external</strong> states that block on something outside the loop (CI, Copilot, a human), <strong>blocked / fail-closed</strong> states that stop or reconcile rather than guess, and <strong>terminal</strong> states where the slice is complete.',
];

const SECTIONS = [
  {
    id: 'public-gate-hub',
    title: 'Public dev-loop gate hub',
    source: 'packages/core/src/loop/public-dev-loop-routing-contract.mjs — PUBLIC_DEV_LOOP_GATE_CONTRACT',
    prose: [
      'The single public entrypoint, <code>dev-loop</code>, resolves the canonical current state to exactly one of eleven gates. Each gate carries a closed route-kind — <code>route</code> to an internal strategy, <code>stop</code> for a human decision or terminal work, or <code>wait</code> on an external signal — and the internal strategy it selects.',
      'This is the table the startup resolver walks on every invocation: it is not a one-time setup step but the routing decision re-made each time. Ambiguous, conflicting, or unsupported state does not get a guessed route — it fails closed to <code>fail_closed_reconcile</code>. Edge labels below are the route-kind; each node names the gate and the strategy it selects.',
    ],
    diagram: gateDiagram,
  },
  {
    id: 'outer-routing',
    title: 'Outer conductor routing',
    source: 'packages/core/src/loop/conductor-routing.mjs — OUTER_STATE + OUTER_TRANSITIONS',
    prose: [
      'Above the family-local machines, the outer conductor derives one routing outcome per tick: continue waiting, hand off to the Copilot loop, hand off to the reviewer loop, or stay with a live owner. The four active outcomes form a fully-connected core by design — routing is stateless per tick, so each tick re-derives the outcome from fresh detector state rather than following a remembered path.',
      'The three remaining outcomes — <code>stop_needs_human</code>, <code>done_terminal</code>, and <code>needs_reconcile</code> — are absorbing: once reached, the outer loop does not route onward on its own.',
    ],
    diagram: outerDiagram,
  },
  {
    id: 'pr-lifecycle',
    title: 'PR lifecycle contract',
    source: 'skills/docs/pr-lifecycle-contract.md (documented vocabulary)',
    prose: [
      'One PR moves through a stable thirteen-state vocabulary from draft to merge. These identifiers are part of the contract surface even as the helper implementations around them change. Two local gates guard the path — <code>draft_gate</code> (draft to ready-for-review) and <code>pre_approval_gate</code> (before final approval) — and both are fail-closed fan-out reviews that run independent angle chains and must produce clean current-head evidence to pass.',
      'All gate evidence is per-head: a new push re-opens the gates, and ready-to-draft resets the lifecycle back into draft-stage gating. A conflicted head detours through <code>merge_conflict_resolution</code> before any further gate progression — a conflicted PR is never treated as approval- or merge-ready, even if older gate comments and CI were green. Human approval and merge are explicit external waits, not hidden remediation states.',
    ],
    diagram: prLifecycleDiagram,
  },
  {
    id: 'copilot-loop',
    title: 'Copilot review/fix loop',
    source: 'packages/core/src/loop/copilot-loop-state.mjs — STATE + TRANSITIONS',
    prose: [
      'The inner loop requests Copilot review, watches for it, and remediates — all scoped to one PR head. Unresolved feedback always routes into fix and reply/resolve, never into a wait: the loop does not sleep on a PR that has open threads. Only once threads are resolved and CI is settled does it re-request or converge.',
      'Re-requesting is bounded by <code>maxCopilotRounds</code>. At the cap a clean PR routes to <code>round_cap_clean_fallback</code> (proceed to the pre-approval gate) rather than dead-ending on a review that can never come, while a not-clean PR hard-stops at <code>round_cap_reached</code>; a significant head change is the escape hatch that re-opens auto re-request. A separate low-signal heuristic can end the loop early at <code>low_signal_converged</code> when extra rounds yield only minimal actionable feedback. These cap and convergence states are the ones older prose graphs omit.',
    ],
    diagram: copilotDiagram,
  },
  {
    id: 'reviewer-loop',
    title: 'Reviewer loop',
    source: 'packages/core/src/loop/reviewer-loop-state.mjs — REVIEWER_STATE + REVIEWER_TRANSITIONS',
    prose: [
      'The reviewer side plans a bounded set of review angles, runs them in parallel, merges the results into one draft review, and posts it — then submits. The external-wait boundaries are explicitly named states (<code>waiting_for_review_request</code>, <code>waiting_for_user_submit</code>) rather than implicit pauses, so a wait on a human is always a distinct, inspectable state.',
      'If the reviewed head goes stale, <code>review_invalidated</code> discards the pending draft and re-enters at <code>review_requested</code> so the review is always produced for the current head.',
    ],
    diagram: reviewerDiagram,
  },
  {
    id: 'release-pipeline',
    title: 'Release pipeline',
    source: '.github/workflows/release.yml (documented workflow)',
    prose: [
      'Cutting a release is milestone-terminal. The version-bump PR itself goes through the same full gate pipeline as any other change — there is no privileged path to main. Pushing a <code>v*</code> tag is the only manual release step.',
      'Everything after the tag fails closed: the release commit must be an ancestor of <code>origin/main</code>, the shipped <code>@dev-loops/core</code> dependency must be in major.minor lockstep with the release, an existing release short-circuits idempotently, and the CHANGELOG section must extract before <code>gh release create</code> runs. Any failed check stops the release rather than publishing a partial one.',
    ],
    diagram: releaseDiagram,
  },
];

function proseParagraphs(prose) {
  return prose.map((p) => `        <p>${p}</p>`).join('\n');
}

// Escape mermaid source for HTML embedding: & first, then <. The HTML parser
// unescapes these before mermaid reads the element's textContent, so mermaid
// sees the exact original source (and `-->` arrows pass through untouched).
const escapeMermaid = (src) => src.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function sectionMarkup(s) {
  return `      <section class="atlas-section" id="${s.id}">
        <h2>${s.title}</h2>
        <p class="source">Diagram generated from <code>${s.source}</code></p>
${proseParagraphs(s.prose)}
        <div class="diagram"><div class="mermaid">
${escapeMermaid(s.diagram)}
</div></div>
      </section>`;
}

// The colour legend mirrors the four classDef classes so readers can map a node
// colour to its role. Swatch colours are the classDef stroke colours above.
const LEGEND = [
  { cls: 'act', label: 'active / in-progress', stroke: '#a78bfa' },
  { cls: 'wait', label: 'waiting on external', stroke: '#93c5fd' },
  { cls: 'stop', label: 'blocked / fail-closed', stroke: '#94a3b8' },
  { cls: 'term', label: 'terminal', stroke: '#ddd6fe' },
];

function legendMarkup() {
  const items = LEGEND.map(
    (l) => `        <li><span class="swatch" style="border-color:${l.stroke}"></span>${l.label}</li>`,
  ).join('\n');
  return `      <ul class="legend" aria-label="diagram colour key">
${items}
      </ul>`;
}

/**
 * Build the full State atlas page HTML (deterministic; no timestamps/randomness).
 *
 * The returned HTML has a single <style> block and a <body> tag so build-site's
 * injectNav can attach the shared nav. It references the vendored mermaid via
 * <script src="assets/mermaid.min.js"> (copied into site/ by build-site) rather
 * than inlining ~3MB; GitHub Pages applies no CSP, so no CSP meta is emitted.
 *
 * @returns {string}
 */
export function buildStateAtlasHtml() {
  const intro = INTRO_PROSE.map((p) => `      <p class="lede">${p}</p>`).join('\n');
  const sections = SECTIONS.map(sectionMarkup).join('\n');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>State atlas — dev-loops</title>
<style>
  :root {
    --ground-1: #08101f;
    --ground-2: #0b1220;
    --ground-3: #0f172a;
    --ink: #e5e7eb;
    --heading: #f8fafc;
    --copy: #cbd5e1;
    --accent: #a78bfa;
    --accent-soft: #ddd6fe;
    --kicker: #93c5fd;
    --card-border: rgba(148, 163, 184, 0.18);
    --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, "Helvetica Neue", sans-serif;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  }

  * { box-sizing: border-box; }

  body {
    margin: 0;
    font-family: var(--font);
    color: var(--ink);
    overflow-x: hidden;
    -webkit-text-size-adjust: 100%;
    background:
      radial-gradient(circle at 85% 4%, rgba(139, 92, 246, 0.22), transparent 26%),
      radial-gradient(circle at 12% 2%, rgba(59, 130, 246, 0.16), transparent 22%),
      linear-gradient(180deg, var(--ground-1) 0%, var(--ground-2) 38%, var(--ground-3) 100%);
    background-attachment: fixed;
  }

  .wrap {
    max-width: 48rem;
    margin: 0 auto;
    padding: clamp(2rem, 6vw, 4rem) clamp(1.1rem, 5vw, 2rem) 5rem;
  }
  @media (min-width: 900px) {
    .wrap { max-width: 64rem; }
  }

  .kicker {
    text-transform: uppercase;
    letter-spacing: 0.14em;
    font-size: 0.72rem;
    color: var(--kicker);
    margin: 0 0 0.6rem;
    font-weight: 600;
  }

  h1, h2, h3 { color: var(--heading); letter-spacing: -0.02em; margin-top: 0; }
  h1 { font-weight: 760; font-size: clamp(1.9rem, 5vw, 2.7rem); line-height: 1.08; margin-bottom: 0.9rem; }
  h2 { font-weight: 720; font-size: clamp(1.35rem, 3.4vw, 1.85rem); line-height: 1.15; margin: 0 0 0.6rem; }

  p { line-height: 1.72; font-size: 1.05rem; color: var(--ink); margin: 0 0 1.15rem; }
  strong { color: var(--accent-soft); }
  .lede { color: var(--copy); font-size: clamp(1.02rem, 2.2vw, 1.18rem); line-height: 1.5; margin: 0 0 1.4rem; }
  .source { color: var(--copy); font-size: 0.85rem; margin: 0 0 0.6rem; }

  code {
    font-family: var(--mono);
    font-size: 0.9em;
    background: rgba(148, 163, 184, 0.12);
    border: 1px solid rgba(148, 163, 184, 0.16);
    border-radius: 6px;
    padding: 0.05em 0.4em;
    color: #e2e8f0;
    overflow-wrap: anywhere;
  }

  .legend { list-style: none; display: flex; flex-wrap: wrap; gap: 0.5rem 1.4rem; padding: 0; margin: 0 0 2.6rem; font-size: 0.9rem; color: var(--copy); }
  .legend li { display: inline-flex; align-items: center; gap: 0.5rem; margin: 0; }
  .legend .swatch { width: 0.85rem; height: 0.85rem; border-radius: 4px; border: 2px solid; background: rgba(15, 23, 42, 0.6); display: inline-block; }

  .atlas-section { margin: 0 0 3rem; }

  .diagram {
    background: linear-gradient(180deg, rgba(15, 23, 42, 0.82), rgba(15, 23, 42, 0.6));
    border: 1px solid var(--card-border);
    border-radius: 14px;
    padding: 1.15rem;
    overflow-x: auto;
  }
  .diagram .mermaid { text-align: center; }
  .diagram .mermaid svg { max-width: 100%; height: auto; }
</style>
</head>
<body>
    <main class="wrap">
      <p class="kicker">dev-loops</p>
      <h1>State atlas</h1>
${intro}
${legendMarkup()}
${sections}
    </main>
    <script src="assets/mermaid.min.js"></script>
    <script>
      mermaid.initialize({
        startOnLoad: true,
        securityLevel: 'strict',
        theme: 'base',
        themeVariables: {
          darkMode: true,
          background: 'transparent',
          primaryColor: '#0f172a',
          primaryTextColor: '#f8fafc',
          primaryBorderColor: '#a78bfa',
          secondaryColor: '#171532',
          tertiaryColor: '#0f1d33',
          lineColor: '#94a3b8',
          textColor: '#e5e7eb',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          fontSize: '14px',
        },
      });
    </script>
</body>
</html>
`;
}
