import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { createModel as detailedModel } from '../../docs/articles/assets/simulator-model.mjs';
import { createModel as overviewModel } from '../../docs/articles/assets/simulator-overview-model.mjs';

function conditions(model, overrides = {}) {
  const world = {};
  model.defaults(world);
  return Object.assign(world, overrides);
}

function advance(model, state, world) {
  const previous = structuredClone(state);
  state.prev = structuredClone(state.st);
  state.n++;
  state.read = [];
  model.advance(state, world, previous);
}

function until(model, state, world, target) {
  for (let i = 0; i < 150 && state.pending[0] !== target && !state.done; i++) advance(model, state, world);
  assert.equal(state.pending[0], target);
}

test('Detailed preserves unknown validation as gate evidence instead of a clean verdict', () => {
  const model = detailedModel();
  const world = conditions(model, { validation: 'incomplete (dirty worktree)' });
  const state = { gate: 'draft_gate', headSha: 'A', dispatchMode: 'full_fanout' };
  const facts = { g: { draft_gate: { round: 1 } }, gr: {} };
  assert.equal(model.H.gate.G5(state, world, facts).set.validation, 'incomplete (dirty worktree) @A');
  assert.equal(model.H.gate.G11(state, world, facts).set.fanInVerdict, 'findings recorded');
  const result = model.H.gate.G16(state, world, facts);
  assert.deepEqual(result.next, { up: 'stop', via: 'exit_escalate' });
  assert.equal(result.set.nextAction, 'address_review_feedback');
});

test('Detailed keeps the medium fix window inclusive at round three and closes only after it', () => {
  const model = detailedModel();
  const world = conditions(model, { findings: 'one medium, not fixed' });
  const state = { gate: 'draft_gate', headSha: 'D', unresolvedGateThreadCount: 1 };
  const facts = { g: { draft_gate: { round: 3 } }, gr: {} };
  assert.equal(model.H.gate.G12(state, world, facts).set.actList, '1 medium');
  assert.equal(model.H.gate.G20(state, world, facts).set.unresolvedGateThreadCount, 1);
  facts.g.draft_gate.round = 4;
  assert.equal(model.H.gate.G12(state, world, facts).set.actList, 'empty');
  assert.equal(model.H.gate.G20(state, world, facts).set.unresolvedGateThreadCount, 0);
});

test('Detailed high findings escalate inline review without consuming the new-head fix transition', () => {
  const model = detailedModel();
  const world = conditions(model, { findings: 'one high, judge act', lightMode: 'on, diff within limits' });
  const state = { gate: 'draft_gate', headSha: 'A', dispatchMode: 'inline (under_threshold)' };
  const facts = { g: { draft_gate: { round: 1 } }, gr: {} };
  assert.equal(model.H.gate.G11(state, world, facts).next, 'G4');
  assert.equal(model.H.gate.G4(state, world, facts).set.dispatchMode, 'full_fanout (escalated)');
  assert.equal(model.H.gate.G12(state, world, facts).set.actList, '1 high');
  assert.equal(state.headSha, 'A');
});

test('Overview fan-in checks missing lenses before unknown validation and retries both on the same head', () => {
  const model = overviewModel();
  const world = conditions(model, { lens: 'one never reports', validation: 'incomplete (unknown)' });
  const state = model.fresh();
  until(model, state, world, 'join');
  assert.equal(state.st.lenses, '3 of 4');
  assert.equal(state.st.validation, 'unknown @A');
  advance(model, state, world);
  assert.equal(state.out.join.t, 'lens missing → re-dispatch');
  advance(model, state, world);
  advance(model, state, world);
  assert.equal(state.out.join.t, 'unknown → re-run');
  until(model, state, world, 'judge');
  assert.equal(state.st.head, 'A');
  assert.equal(state.st.validation, 'pass @A');
  assert.equal(state.st.fix_rounds, 0);
});

test('Overview refuses a moved merge head and obtains fresh evidence before merging', () => {
  const model = overviewModel();
  const world = conditions(model, { headmove: true });
  const state = model.fresh();
  until(model, state, world, 'merge');
  assert.equal(state.st.verdict_head, 'A · spec v1');
  advance(model, state, world);
  assert.equal(state.st.head, 'B');
  assert.equal(state.st.status, 'head moved');
  assert.deepEqual(state.pending, ['review']);
  until(model, state, world, 'merge');
  assert.equal(state.st.verdict_head, 'B · spec v1');
  advance(model, state, world);
  assert.equal(state.st.status, 'merged');
  assert.equal(state.st.authorization, 'standing');
});

test('Fresh runs do not share gate facts or the previous Overview record', () => {
  const a = detailedModel();
  const first = a.fresh(), second = a.fresh();
  first.f.g.draft_gate.round = 4;
  assert.equal(second.f.g.draft_gate.round, 0);
  const overview = overviewModel();
  const old = overview.fresh();
  advance(overview, old, conditions(overview));
  const reset = overview.fresh();
  assert.deepEqual(reset.pending, ['startup']);
  assert.equal(reset.st.head, '—');
  assert.deepEqual(reset.trace, []);
});
