import { STATE as COPILOT_STATE, TRANSITIONS as COPILOT_TRANSITIONS } from '@dev-loops/core/loop/copilot-loop-state';
import { OUTER_GRAPH, OUTER_STATE, OUTER_TERMINAL_STATES, OUTER_TRANSITIONS } from '@dev-loops/core/loop/conductor-routing';
import { REVIEWER_STATE, REVIEWER_TRANSITIONS } from '@dev-loops/core/loop/reviewer-loop-state';
import { LIFECYCLE_GRAPH, LIFECYCLE_STATE, LIFECYCLE_TERMINAL_STATES, LIFECYCLE_TRANSITIONS } from '@dev-loops/core/loop/lifecycle-state';
import { escapeHtml, formatStateToken, renderSnapshotStateLabel } from './shared.mjs';
import { layoutInspectionLayer } from './graph-layout.mjs';

const stateId = (layerId, state) => `${layerId}:state:${encodeURIComponent(state)}`;
const pairId = (layerId, kind, from, to) => `${layerId}:${kind}:${encodeURIComponent(from)}:${encodeURIComponent(to)}`;
const inferredTerminals = table => Object.keys(table).filter(state => table[state].length === 0);
const definitions = [
  { id: 'outer_loop_family', title: 'outer-loop family', states: Object.values(OUTER_STATE), table: OUTER_TRANSITIONS, entries: OUTER_GRAPH.entryStates, terminals: OUTER_TERMINAL_STATES, entryLabel: OUTER_GRAPH.start.label, exitLabel: OUTER_GRAPH.end.label, saturated: true },
  { id: 'copilot_layer', title: 'copilot layer', states: Object.values(COPILOT_STATE), table: COPILOT_TRANSITIONS, entries: [COPILOT_STATE.PR_DRAFT], terminals: inferredTerminals(COPILOT_TRANSITIONS) },
  { id: 'reviewer_layer', title: 'reviewer layer', states: Object.values(REVIEWER_STATE), table: REVIEWER_TRANSITIONS, entries: [REVIEWER_STATE.WAITING_FOR_REVIEW_REQUEST], terminals: inferredTerminals(REVIEWER_TRANSITIONS) },
  { id: 'lifecycle_layer', title: 'lifecycle', states: Object.values(LIFECYCLE_STATE), table: LIFECYCLE_TRANSITIONS, entries: LIFECYCLE_GRAPH.entryStates, terminals: LIFECYCLE_TERMINAL_STATES, entryLabel: LIFECYCLE_GRAPH.start.label, exitLabel: LIFECYCLE_GRAPH.end.label },
];

function normalizedTransitions(value) {
  if (!Array.isArray(value)) return null;
  return [...new Set(value.filter(token => typeof token === 'string').map(token => token.trim()).filter(Boolean))];
}

function currentInfo(value, definition) {
  const suppliedToken = typeof value === 'string' ? value.trim() : null;
  const reason = value == null ? 'missing'
    : typeof value !== 'string' ? 'invalid-type'
      : !suppliedToken ? 'empty'
        : suppliedToken.toLowerCase() === 'unknown' ? 'unknown-token'
          : !definition.states.includes(suppliedToken) ? 'unrecognized' : null;
  return reason === null
    ? { status: 'known', reason: null, stateId: suppliedToken, nodeId: stateId(definition.id, suppliedToken), label: suppliedToken, suppliedToken }
    : { status: 'unavailable', reason, stateId: null, nodeId: null, label: 'current state unavailable', suppliedToken };
}

function buildLayer(definition, suppliedCurrent, suppliedTransitions) {
  const current = currentInfo(suppliedCurrent, definition);
  const normalized = normalizedTransitions(suppliedTransitions);
  const outgoing = current.status === 'known' ? new Set(definition.table[current.stateId]) : new Set();
  const allowedNext = new Set((normalized ?? []).filter(state => outgoing.has(state)));
  const broadNextSet = definition.saturated === true && current.status === 'known' && allowedNext.size === definition.states.length;
  const next = broadNextSet ? new Set() : allowedNext;
  const status = normalized === null ? 'unavailable' : normalized.length === 0 ? 'empty' : 'available';
  const transitionInfo = {
    status,
    normalizedTransitions: normalized ?? [],
    highlightedNextStateIds: [...next].sort(),
    broadNextSet,
    summary: status === 'unavailable' ? 'transition data unavailable in this snapshot' : status === 'empty' ? 'no allowed transitions' : normalized.join(', '),
  };
  const terminalStates = new Set(definition.terminals);
  const nodes = definition.states.map(state => ({
    id: stateId(definition.id, state), stateId: state, label: state.replaceAll('_', ' '), terminal: terminalStates.has(state),
    snapshot: {
      current: current.stateId === state,
      allowedNext: allowedNext.has(state),
      next: next.has(state),
      emphasis: current.stateId === state ? 'current' : next.has(state) ? 'next' : terminalStates.has(state) ? 'terminal' : 'inactive',
    },
  }));
  const edges = definition.states.flatMap(from => definition.table[from].map(to => ({
    id: pairId(definition.id, 'transition', from, to), from: stateId(definition.id, from), to: stateId(definition.id, to),
  })));
  const entry = { id: `${definition.id}:cue:entry`, kind: 'entry', label: definition.entryLabel ?? 'Start' };
  const exit = { id: `${definition.id}:cue:exit`, kind: 'exit', label: definition.exitLabel ?? 'End' };
  const cues = [...(definition.entries.length ? [entry] : []), ...(definition.terminals.length ? [exit] : [])];
  const cueLinks = [
    ...definition.entries.map(to => ({ id: pairId(definition.id, 'entry', entry.id, to), kind: 'entry', from: entry.id, to: stateId(definition.id, to) })),
    ...definition.terminals.map(from => ({ id: pairId(definition.id, 'exit', from, exit.id), kind: 'exit', from: stateId(definition.id, from), to: exit.id })),
  ];
  const annotations = [];
  if (current.status === 'unavailable') annotations.push({ id: `${definition.id}:annotation:current-unavailable`, kind: 'current-unavailable', text: current.suppliedToken ? `Current state unavailable: unrecognized or unknown identifier ${current.suppliedToken}.` : 'Current state unavailable in this snapshot.', relatedNodeId: null });
  if (status === 'unavailable') annotations.push({ id: `${definition.id}:annotation:transitions-unavailable`, kind: 'transitions-unavailable', text: 'Snapshot next transitions unavailable; no next-state eligibility is inferred.', relatedNodeId: current.nodeId });
  if (broadNextSet) annotations.push({ id: `${definition.id}:annotation:broad-next-set`, kind: 'broad-next-set', text: 'Next evaluation may resolve to any shown state; broad outer eligibility is not emphasized as a specific immediate next step.', relatedNodeId: current.nodeId });
  const topology = { nodes, edges, cues, cueLinks };
  let geometry;
  try {
    geometry = layoutInspectionLayer(topology);
  } catch (error) {
    geometry = { status: 'unavailable', reason: error?.code === 'invalid_graph' ? 'invalid_graph' : 'layout_failed' };
  }
  return { id: definition.id, title: definition.title, ...topology, annotations, current, transitionInfo, summary: `${current.label}; full authoritative state machine shown`, geometry };
}

export function buildInspectionGraph(snapshot) {
  if (snapshot == null || renderSnapshotStateLabel(snapshot) === 'unavailable') return null;
  const values = [
    [snapshot.outerState, snapshot.allowedTransitions],
    [snapshot.layers?.copilot?.currentState, snapshot.layers?.copilot?.allowedTransitions],
    [snapshot.layers?.reviewer?.currentState, snapshot.layers?.reviewer?.allowedTransitions],
    [snapshot.lifecyclePhase, snapshot.lifecycleAllowedTransitions],
  ];
  const layers = definitions.map((definition, index) => buildLayer(definition, ...values[index]));
  const focus = layer => ({ layerId: layer.id, kind: layer.current.nodeId ? 'state' : 'annotation', id: layer.current.nodeId ?? `${layer.id}:annotation:current-unavailable` });
  const outerState = formatStateToken(snapshot.outerState, 'unknown');
  const outerAction = formatStateToken(snapshot.outerAction, 'unknown');
  let focusTargets;
  // Preserve the existing raw lifecycle priority independently of identifier validity.
  const lifecycleAvailable = snapshot.lifecyclePhase != null && snapshot.lifecyclePhase !== 'unknown' && !String(snapshot.lifecyclePhase).toLowerCase().includes('unavailable');
  if (lifecycleAvailable) focusTargets = [focus(layers[3])];
  else if (outerState === OUTER_STATE.HANDOFF_TO_COPILOT_LOOP || outerAction === 'reenter_copilot_loop') focusTargets = [focus(layers[1])];
  else if (outerState === OUTER_STATE.HANDOFF_TO_REVIEWER_LOOP || outerAction === 'reenter_reviewer_loop') focusTargets = [focus(layers[2])];
  else focusTargets = layers[1].current.nodeId ? [focus(layers[1])] : layers.map(focus);
  return { layers, focusTargets, initialLayerId: focusTargets[0].layerId };
}

function classification(node) {
  return [node.snapshot.current ? 'Current' : null, node.snapshot.next ? 'Next' : null, node.terminal ? 'Terminal' : null].filter(Boolean).join(' · ') || 'Inactive';
}

function layerTransitionSummary(layer) {
  if (layer.transitionInfo.status === 'unavailable') return 'Transition data unavailable';
  if (layer.transitionInfo.status === 'empty') return 'No allowed transitions';
  return `${layer.transitionInfo.normalizedTransitions.length} snapshot transitions${layer.transitionInfo.broadNextSet ? ' · broad next set' : ''}`;
}

function renderLayerText(layer) {
  const byId = new Map(layer.nodes.map(node => [node.id, node]));
  return `<details class="state-graph-layer-details"><summary>${escapeHtml(layer.title)} — all states and authoritative transitions</summary>
    <p>Snapshot current: <code>${escapeHtml(layer.current.suppliedToken ?? 'unavailable')}</code>. Snapshot allowed transitions: ${escapeHtml(layer.transitionInfo.summary)}.</p><!-- secret-scan:allow suppliedToken is a snapshot state identifier, not an authentication credential -->
    ${layer.annotations.map(note => `<p>${escapeHtml(note.text)}</p>`).join('')}
    <ul>${layer.nodes.map(node => {
      const outgoing = layer.edges.filter(edge => edge.from === node.id).map(edge => byId.get(edge.to)?.stateId ?? edge.to);
      return `<li><code>${escapeHtml(node.stateId)}</code> — ${escapeHtml(node.label)}; ${escapeHtml(classification(node))}. Authoritative outgoing: ${outgoing.length ? outgoing.map(id => `<code>${escapeHtml(id)}</code>`).join(', ') : 'none (table terminal)'}.</li>`;
    }).join('')}</ul>
    <p>Presentation cues only: ${layer.cues.map(cue => escapeHtml(`${cue.label} (${cue.kind})`)).join(', ')}. They are not executable states.</p>
  </details>`;
}

function graphJson(graph) {
  return JSON.stringify(graph).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
}

export function renderStateVisualizationSection(snapshot, graph = buildInspectionGraph(snapshot), target = snapshot?.target) {
  const params = new URLSearchParams();
  if (target?.repo) params.set('repo', target.repo);
  if (target?.pr != null) params.set('pr', String(target.pr));
  const snapshotHref = `/snapshot.json${params.size ? `?${params}` : ''}`;
  if (graph === null) return `<div class="state-graph-block"><p>Snapshot unavailable, so no state graph can be rendered yet.</p><a href="${escapeHtml(snapshotHref)}">Snapshot JSON</a></div>`;
  return `<div class="state-graph-block">
    <div class="state-graph-frame" data-inspection-graph-root data-selected-layer="${escapeHtml(graph.initialLayerId)}" role="region" aria-label="Read-only inspection graph">
      <div class="state-graph-layer-selector" aria-label="Inspection layers">
        ${graph.layers.map(layer => `<button type="button" data-graph-layer="${escapeHtml(layer.id)}" aria-pressed="${layer.id === graph.initialLayerId}" disabled><strong>${escapeHtml(layer.title)}</strong><span>Current: ${escapeHtml(layer.current.label)}</span><span>${escapeHtml(layerTransitionSummary(layer))}</span></button>`).join('')}
      </div>
      <div class="state-graph-toolbar" aria-label="Graph controls">
        <button type="button" data-graph-zoom-out aria-label="Zoom out" disabled>−</button>
        <button type="button" data-graph-zoom-in aria-label="Zoom in" disabled>+</button>
        <button type="button" data-graph-fit disabled>Fit graph</button>
        <button type="button" data-graph-focus disabled>Focus current state</button>
        <button type="button" data-graph-reset disabled>Reset view</button>
        <span class="state-graph-zoom-value" data-graph-zoom-value>100%</span>
        <button type="button" data-graph-fullscreen aria-label="Open graph fullscreen" disabled>Fullscreen</button>
      </div>
      <p class="state-graph-status" data-graph-status role="status">Interactive graph unavailable until the local renderer loads. Use the textual layer details below or Snapshot JSON.</p>
      <div class="inspection-graph-viewport" data-graph-viewport data-rendered="pending" data-graph-scale="1" tabindex="0" role="group" aria-label="Inspection graph viewport"></div>
      <div class="state-graph-node-details" data-graph-node-details role="status" aria-live="polite"><p>Select a state to inspect its identifier, classification and authoritative outgoing transitions. Selection never executes a transition.</p></div>
      <p class="state-graph-keyboard-help">Arrow keys pan the focused graph viewport. State nodes support keyboard selection. Zoom, Fit and Focus buttons are keyboard-operable. Current, Next and Terminal are labels, not only colors.</p>
    <p><a class="viewer-inline-link" href="${escapeHtml(snapshotHref)}">Snapshot JSON</a> — unchanged public inspection data.</p>
      <script type="application/json" data-inspection-graph-data>${graphJson(graph)}</script>
    </div>
    <details class="state-graph-details"><summary>Graph guide and layer details</summary>
      <ul class="state-graph-help"><li>Current states and allowed next transitions are projected from this snapshot; every shown edge comes from the authoritative transition table, not execution history.</li><li>Next emphasis is the snapshot/table intersection. A broad outer next set is explained rather than highlighting every state.</li><li>Entry and exit cues are presentation annotations. The four layers do not imply a cross-layer call stack.</li><li>This is a read-only view. Use the existing Reload snapshot control for a new inspection; this renderer does not poll or execute transitions.</li></ul>
      <ul class="state-graph-summaries">${graph.layers.map(layer => `<li><strong>${escapeHtml(layer.title)}:</strong> current <code>${escapeHtml(layer.current.label)}</code>; ${escapeHtml(layer.summary)}; ${escapeHtml(layer.transitionInfo.summary)}</li>`).join('')}</ul>
      ${graph.layers.map(renderLayerText).join('')}
    </details>
  </div>`;
}
