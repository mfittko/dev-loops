import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { buildInspectionGraph } from '../../scripts/loop/inspect-run-viewer/graph.mjs';
import { STATE as COPILOT_STATE, TRANSITIONS as COPILOT_TRANSITIONS } from '@dev-loops/core/loop/copilot-loop-state';
import { OUTER_STATE, OUTER_TRANSITIONS, OUTER_TERMINAL_STATES, OUTER_GRAPH } from '@dev-loops/core/loop/conductor-routing';
import { REVIEWER_STATE, REVIEWER_TRANSITIONS } from '@dev-loops/core/loop/reviewer-loop-state';
import { LIFECYCLE_STATE, LIFECYCLE_TRANSITIONS, LIFECYCLE_TERMINAL_STATES, LIFECYCLE_GRAPH } from '@dev-loops/core/loop/lifecycle-state';
import { makeSnapshot } from './inspect-run-viewer-test-helpers.mjs';

const sources = [
  ['outer_loop_family', OUTER_STATE, OUTER_TRANSITIONS, OUTER_TERMINAL_STATES, OUTER_GRAPH.entryStates],
  ['copilot_layer', COPILOT_STATE, COPILOT_TRANSITIONS, Object.keys(COPILOT_TRANSITIONS).filter(id => !COPILOT_TRANSITIONS[id].length), [COPILOT_STATE.PR_DRAFT]],
  ['reviewer_layer', REVIEWER_STATE, REVIEWER_TRANSITIONS, Object.keys(REVIEWER_TRANSITIONS).filter(id => !REVIEWER_TRANSITIONS[id].length), [REVIEWER_STATE.WAITING_FOR_REVIEW_REQUEST]],
  ['lifecycle_layer', LIFECYCLE_STATE, LIFECYCLE_TRANSITIONS, LIFECYCLE_TERMINAL_STATES, LIFECYCLE_GRAPH.entryStates],
];
const layer = (snapshot, id = 'copilot_layer') => buildInspectionGraph(makeSnapshot(snapshot)).layers.find(item => item.id === id);
const snapshotCopilot = (currentState, allowedTransitions) => ({ layers: { copilot: { currentState, allowedTransitions } } });

for (const [id, states, table, terminals, entries] of sources) {
  test(`${id} represents every authoritative state, directed pair and distinct presentation cue`, () => {
    const graphLayer = layer({}, id);
    const byId = new Map(graphLayer.nodes.map(node => [node.id, node.stateId]));
    assert.deepEqual(graphLayer.nodes.map(node => node.stateId).sort(), Object.values(states).sort());
    assert.equal(byId.size, Object.values(states).length);
    assert.deepEqual(graphLayer.edges.map(edge => [byId.get(edge.from), byId.get(edge.to)]).sort(), Object.entries(table).flatMap(([from, targets]) => targets.map(to => [from, to])).sort());
    assert.equal(new Set(graphLayer.edges.map(edge => edge.id)).size, graphLayer.edges.length);
    assert.deepEqual(graphLayer.nodes.filter(node => node.terminal).map(node => node.stateId).sort(), [...terminals].sort());
    for (const cue of graphLayer.cues) assert.equal(byId.has(cue.id), false);
    assert.deepEqual(graphLayer.cueLinks.filter(link => link.kind === 'entry').map(link => byId.get(link.to)).sort(), [...entries].sort());
    assert.deepEqual(graphLayer.cueLinks.filter(link => link.kind === 'exit').map(link => byId.get(link.from)).sort(), [...terminals].sort());
  });
}

test('next highlights use normalized snapshot/table intersection, not arbitrary snapshot destinations', () => {
  const graphLayer = layer(snapshotCopilot('waiting_for_copilot_review', [' waiting_for_ci ', 'waiting_for_ci', 'ready_to_rerequest_review', 'done', 3, '']));
  assert.deepEqual(graphLayer.nodes.filter(node => node.snapshot.next).map(node => node.stateId).sort(), ['ready_to_rerequest_review', 'waiting_for_ci']);
  assert.deepEqual(graphLayer.transitionInfo.normalizedTransitions, ['waiting_for_ci', 'ready_to_rerequest_review', 'done']);
});

test('outer saturated-next suppression keeps eligibility distinct from emphasis and is outer-only', () => {
  const graphLayer = layer({ outerState: OUTER_STATE.CONTINUE_CURRENT_WAIT, allowedTransitions: Object.values(OUTER_STATE) }, 'outer_loop_family');
  assert.equal(graphLayer.transitionInfo.broadNextSet, true);
  assert.equal(graphLayer.nodes.some(node => node.snapshot.next), false);
  assert.deepEqual(graphLayer.nodes.filter(node => node.snapshot.allowedNext).map(node => node.stateId).sort(), Object.values(OUTER_STATE).sort());
  assert.equal(layer(snapshotCopilot('waiting_for_copilot_review', ['waiting_for_ci'])).transitionInfo.broadNextSet, false);
});

test('current, self-next and terminal facts survive display precedence', () => {
  const selfState = Object.entries(COPILOT_TRANSITIONS).find(([state, targets]) => targets.includes(state))[0];
  const self = layer(snapshotCopilot(selfState, [selfState])).nodes.find(node => node.stateId === selfState);
  assert.equal(self.snapshot.current, true);
  assert.equal(self.snapshot.next, true);
  assert.equal(self.snapshot.emphasis, 'current');
  const terminal = layer(snapshotCopilot('done', [])).nodes.find(node => node.stateId === 'done');
  assert.equal(terminal.snapshot.current, true);
  assert.equal(terminal.terminal, true);
  assert.equal(terminal.snapshot.next, false);
  const toDone = Object.entries(COPILOT_TRANSITIONS).find(([, targets]) => targets.includes('done'))[0];
  const nextTerminal = layer(snapshotCopilot(toDone, ['done'])).nodes.find(node => node.stateId === 'done');
  assert.equal(nextTerminal.snapshot.next, true);
  assert.equal(nextTerminal.terminal, true);
});

for (const currentState of [undefined, null, '', '   ', 'unknown', 'new_unknown_state', 27]) {
  test(`unavailable current ${JSON.stringify(currentState)} never chooses an arbitrary executable state`, () => {
    const graphLayer = layer(snapshotCopilot(currentState, ['waiting_for_ci']));
    assert.equal(graphLayer.current.status, 'unavailable');
    assert.equal(graphLayer.current.nodeId, null);
    assert.equal(graphLayer.nodes.some(node => node.snapshot.current || node.snapshot.next), false);
  });
}

test('missing transitions differ from explicit empty list and do not imply terminal state', () => {
  const missing = layer(snapshotCopilot('waiting_for_copilot_review', undefined));
  const empty = layer(snapshotCopilot('waiting_for_copilot_review', []));
  assert.equal(missing.transitionInfo.status, 'unavailable');
  assert.equal(empty.transitionInfo.status, 'empty');
  assert.equal(empty.nodes.find(node => node.snapshot.current).terminal, false);
  const missingLayer = layer({ layers: {} });
  assert.equal(missingLayer.current.status, 'unavailable');
  assert.equal(missingLayer.transitionInfo.status, 'unavailable');
});

test('missing or wholly unavailable snapshots produce no pretend run graph', () => {
  assert.equal(buildInspectionGraph(null), null);
  assert.equal(buildInspectionGraph(undefined), null);
  assert.equal(buildInspectionGraph(makeSnapshot({ sourceMode: 'unavailable', markers: { conflicts: ['disagreement'] } })), null);
});

test('existing focus priority preserves unavailable lifecycle focus without inventing a current node', () => {
  assert.equal(buildInspectionGraph(makeSnapshot()).initialLayerId, 'lifecycle_layer');
  const unknownLifecycle = buildInspectionGraph(makeSnapshot({ lifecyclePhase: 'unrecognized_phase' }));
  assert.equal(unknownLifecycle.initialLayerId, 'lifecycle_layer');
  assert.equal(unknownLifecycle.layers[3].current.nodeId, null);
  const unknownToken = buildInspectionGraph(makeSnapshot({ lifecyclePhase: 'unknown' }));
  assert.notEqual(unknownToken.initialLayerId, 'lifecycle_layer');
  assert.equal(unknownToken.layers[3].current.status, 'unavailable');
  assert.equal(unknownToken.layers[3].current.reason, 'unknown-token');
  const reReview = layer({ layers: { reviewer: { currentState: 're_review_needed', allowedTransitions: [] } } }, 'reviewer_layer');
  assert.notEqual(reReview.current.nodeId, null);
  assert.equal(buildInspectionGraph(makeSnapshot({ lifecyclePhase: null, outerState: OUTER_STATE.HANDOFF_TO_COPILOT_LOOP })).initialLayerId, 'copilot_layer');
  assert.equal(buildInspectionGraph(makeSnapshot({ lifecyclePhase: null, outerState: OUTER_STATE.HANDOFF_TO_REVIEWER_LOOP })).initialLayerId, 'reviewer_layer');
  assert.equal(buildInspectionGraph(makeSnapshot({ lifecyclePhase: null, outerState: 'unknown', outerAction: 'reenter_reviewer_loop' })).initialLayerId, 'reviewer_layer');
  assert.equal(buildInspectionGraph(makeSnapshot({ lifecyclePhase: null, outerState: 'unknown', outerAction: 'unknown' })).initialLayerId, 'copilot_layer');
  assert.equal(buildInspectionGraph(makeSnapshot({ lifecyclePhase: null, outerState: 'unknown', outerAction: 'unknown', layers: {} })).initialLayerId, 'outer_loop_family');
});

test('snapshot-only classifications never move graph geometry or mutate the caller snapshot', () => {
  const snapshot = makeSnapshot();
  const before = structuredClone(snapshot);
  const first = buildInspectionGraph(snapshot);
  const changed = buildInspectionGraph(makeSnapshot({ outerState: 'done_terminal', allowedTransitions: [], lifecyclePhase: 'merge', lifecycleAllowedTransitions: [], layers: {} }));
  assert.deepEqual(snapshot, before);
  assert.deepEqual(first.layers.map(item => item.geometry), changed.layers.map(item => item.geometry));
});
