import { createHash } from 'node:crypto';
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

function run(overrides) {
  const model = overviewModel();
  const world = conditions(model, overrides);
  const state = model.fresh();
  for (let i = 0; i < 200 && !state.done; i++) advance(model, state, world);
  assert.equal(state.done, true);
  return state;
}

const NEW_STEPS = /^(refine|self-check):/;
const NEW_IDS = ['early', 'context', 'specgap', 'oversize', 'nongoal'];

test('Overview adds refine and self-check nodes and keeps the existing trace lines', () => {
  const model = overviewModel();
  assert.ok(model.P.refine && model.P.selfcheck);
  const happy = run({});
  assert.equal(happy.trace.filter((t) => NEW_STEPS.test(t)).length, 2);
  assert.deepEqual(happy.trace.filter((t) => !NEW_STEPS.test(t)).slice(0, 4), [
    'startup: refined issue, retro recorded → implement',
    'implement: commit A in the worktree',
    'pre-PR review: clean',
    'pr: push A, create draft PR #42',
  ]);
  const fresh = run({ matrix: false, prepr: 'finds issues' });
  assert.deepEqual(fresh.trace.slice(0, 4), [
    'startup: no AC / DoD matrix → grill first',
    'grill: AC / DoD matrix and non-goals recorded',
    'refine: size forecast and graph context recorded in the work order',
    'implement: commit A in the worktree',
  ]);
});

test('Overview routes each defect kind to its earliest catching stage', () => {
  const stage = { 'missing context': 'refine', correctness: 'self-check', 'docs drift': 'pre-PR review' };
  for (const [defect, caught] of Object.entries(stage)) {
    const state = run({ defect });
    assert.equal(state.st.caught, caught);
    assert.equal(state.st.fix_rounds, 0);
  }
  assert.equal(run({ defect: 'spec gap', matrix: false }).st.caught, 'grill');
  assert.equal(run({ defect: 'spec gap' }).st.caught, 'refine');
});

test('Overview flags a missing-context defect that reaches the draft gate as a gap', () => {
  const state = run({ defect: 'missing context', early: false });
  assert.equal(state.st.caught, 'draft_gate · gap');
  assert.ok(state.trace.some((t) => t.includes('reached the draft gate, a late catch')));
  assert.equal(state.st.fix_rounds, 1);
  assert.equal(run({}).st.caught, '—');
});

test('Overview keeps every pre-existing scenario trace unchanged apart from the new refine and self-check lines', () => {
  // Pins: sha256 prefix of the JSON trace, generated from the pre-refine origin/main model.
  const pins = { happy: '5fe8701364ab', fix: 'dd26627eb05f', nits: '6a3a020d8580', lens: 'd374869a7312', unknown: '2996b5bde0cd', budget: 'c809e5634b84', spec: '0ef31498d4a7', stale: '09ee9d4a50b0', retro: 'aa65cd9707b9', adr: '4a5e1dc422f6', race: 'c91a072d26df', human: '860991a192c1', fresh: 'dd03a5c08f67' };
  const model = overviewModel();
  const ids = model.SCEN.map((sc) => sc.id).filter((id) => !NEW_IDS.includes(id));
  assert.deepEqual(ids.sort(), Object.keys(pins).sort());
  for (const sc of model.SCEN.filter((x) => x.id in pins)) {
    const state = model.fresh();
    const world = conditions(model, sc.w);
    for (let i = 0; i < 300 && !state.done; i++) advance(model, state, world);
    const trace = JSON.stringify(state.trace.filter((t) => !/^(refine|self-check):/.test(t)));
    assert.equal(createHash('sha256').update(trace).digest('hex').slice(0, 12), pins[sc.id], sc.id);
  }
});

// Early-detection scenarios: [overview id, detailed id, catching stage, planned issue].
const EARLY = [
  ['specgap', 26, 'grill', undefined],
  ['oversize', 27, 'refine', 2756],
  ['early', 28, 'pre-PR review', 2807],
  ['nongoal', 29, 'self-check', undefined],
  ['context', 30, 'draft_gate · gap', 2588],
];
const DEFECT = { specgap: 'spec gap', oversize: 'oversize', early: 'docs drift', nongoal: 'non-goal breach', context: 'missing context' };

function runDetailed(overrides) {
  const model = detailedModel();
  const world = conditions(model, overrides);
  const S = model.fresh();
  for (let i = 0; i < 2000 && !S.done; i++) {
    const { g, n } = S.pos, ret = S.ret;
    S.ret = undefined;
    const r = model.H[g][n](S.st, world, S.f, ret);
    if (r.set) Object.assign(S.st, r.set);
    const who = model.ROLE[n] || [];
    if (r.tr) S.trace.push((who[0] ? who[0] + ' · ' : '') + r.tr);
    const nx = r.next;
    if (nx === 'END') S.done = true;
    else if (typeof nx === 'string') S.pos = { g, n: nx };
    else if (nx.sub) { S.stack.push({ g, n }); S.pos = { g: nx.sub, n: nx.at }; }
    else { S.ret = nx.up; S.pos = S.stack.pop(); }
  }
  assert.equal(S.done, true);
  return { model, S };
}

for (const [oid, did, stage, planned] of EARLY) {
  test(`Overview scenario ${oid} is caught at ${stage}`, () => {
    const model = overviewModel();
    const sc = model.SCEN.find((x) => x.id === oid);
    assert.equal(sc.w.defect, DEFECT[oid]);
    assert.equal(run(sc.w).st.caught, stage);
    assert.equal(model.PLANNED[sc.planned], planned);
    assert.ok(sc.stage);
  });
  test(`Detailed scenario ${did} is caught at ${stage}`, () => {
    const sc = detailedModel().SC.find((x) => x.id === did);
    assert.equal(sc.w.defect, DEFECT[oid]);
    const { model, S } = runDetailed(sc.w);
    assert.equal(S.done, true);
    assert.equal(S.st.caught, stage);
    assert.equal(model.PLANNED[sc.planned], planned);
    assert.ok(sc.stage);
    assert.equal(S.trace.some((t) => t.includes('late catch')), stage.endsWith('gap'));
  });
}

test('Both models share the same PLANNED stage-to-issue map', () => {
  assert.deepEqual(detailedModel().PLANNED, { refine: 2756, prepr: 2807, brief: 2588 });
  assert.deepEqual(overviewModel().PLANNED, detailedModel().PLANNED);
});

test('Detailed keeps every pre-existing scenario trace unchanged apart from the size forecast line', () => {
  // Pins: sha256 prefix of the JSON trace, generated from the pre-change origin/main model.
  const pins = { 1: '674ca564b386', 2: '93dbc2d53f13', 3: '853de056f57a', 4: '9169117f498b', 5: '94c69820f7db', 6: 'cbfdafff4aab', 7: '22f964654d32', 8: '3a1177584ba8', 9: '8d4201bd7143', 10: 'a89ceca773a7', 11: '149c21de98c2', 12: '33da119900bb', 13: '19433ed5056f', 14: '97be236a59db', 15: '245a1e004828', 16: 'e2be03e972ca', 17: 'c92f8c23c32b', 18: 'ebbbaeaf9b78', 19: 'c8f15e4522c9', 20: 'c94cb5f006f7', 21: '656870e76ed2', 22: '2f085102417c', 23: 'a14852845460', 24: 'c406640e0863', 25: '1d49f1682c56' };
  for (const sc of detailedModel().SC.filter((x) => x.id in pins)) {
    const { S } = runDetailed(sc.w);
    const trace = JSON.stringify(S.trace.filter((t) => !t.includes('size forecast')));
    assert.equal(createHash('sha256').update(trace).digest('hex').slice(0, 12), pins[sc.id], String(sc.id));
  }
  assert.equal(detailedModel().SC.filter((x) => !(x.id in pins)).length, 5);
});

test('Detailed routes a spec gap on a refined body through refine and an early defect never reaches the gate', () => {
  const { S } = runDetailed({ defect: 'spec gap' });
  assert.equal(S.st.caught, 'refine');
  assert.equal(S.trace.some((t) => t.includes('late catch')), false);
});

// Both views flag an uncaught defect at the draft gate on every path, and derive the planned badge from the recorded catch.
test('Both views flag the same late defects and derive the planned badge from the catch', () => {
  const cases = [
    [{ defect: 'missing context', early: true }, 'refine', 2588],
    [{ defect: 'missing context', early: false }, 'draft_gate · gap', 2588],
    [{ defect: 'missing context', early: false, judge: 'spec_cannot_decide' }, 'draft_gate · gap', 2588],
    [{ defect: 'docs drift', early: true }, 'pre-PR review', 2807],
    [{ defect: 'oversize', early: true }, 'refine', 2756],
    [{ defect: 'oversize', early: false }, 'draft_gate · gap', 2756],
    [{ defect: 'spec gap', matrix: false, early: true }, 'grill', undefined],
    [{ defect: 'correctness', early: true }, 'self-check', undefined],
  ];
  for (const [w, caught, planned] of cases) {
    const detailed = detailedModel();
    const d = runDetailed(w.matrix === false ? { defect: w.defect, body: 'checklist only' } : w);
    const overview = overviewModel();
    const o = run(w);
    assert.equal(d.S.st.caught, caught, JSON.stringify(w));
    assert.equal(o.st.caught, caught, JSON.stringify(w));
    assert.equal(detailed.plannedFor(d.S.st.caught, w.defect), planned, JSON.stringify(w));
    assert.equal(overview.plannedFor(o.st.caught, w.defect), planned, JSON.stringify(w));
  }
  // Early stages off: the detailed forecast reports no split.
  const off = runDetailed({ defect: 'oversize', early: false });
  assert.equal(off.S.trace.some((t) => t.includes('640 wLOC, over the band')), false);
});

test('Detailed scenario 30 keeps the late-catch high through the whole round', () => {
  const { S } = runDetailed(detailedModel().SC.find((x) => x.id === 30).w);
  assert.equal(S.trace.some((t) => t.includes('findings_present, 0 thread(s)')), false);
  assert.equal(S.f.late, true);
  assert.equal(S.st.unresolvedGateThreadCount, 0); // closed after the round-1 fix
});

// The catch row must render on Custom runs, where #about is hidden, so it cannot live inside #about.
test('Both articles keep the caught-at row outside the hidden-on-Custom about block', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const file of ['simulator.html', 'simulator-overview.html']) {
    const html = await readFile(new URL(`../../docs/articles/${file}`, import.meta.url), 'utf8');
    const about = html.match(/<div class="about" id="about">.*?<\/div>/s)[0];
    assert.equal(about.includes('catchp'), false, file);
    assert.ok(html.includes('id="catchp"'), file);
    assert.ok(html.includes('$("about").hidden = !sc;'), file);
  }
});

// With early:true on an entry that skips the early stages, the defect still reaches the draft gate uncaught; Detailed flags it as the Overview judge does (the Overview has no entry input and always runs the early stages).
test('Detailed flags a defect that reaches the draft gate on entries that skip the early stages', () => {
  for (const entry of ['--pr', '--plan-file', '--spike']) {
    const w = { entry, defect: 'docs drift', early: true };
    const d = runDetailed(w);
    assert.equal(d.S.st.caught, 'draft_gate · gap', entry);
    assert.ok(d.S.trace.some((t) => t.includes('late catch')), entry);
  }
});

test('relevant() hides defect and early where they have no effect', () => {
  const d = detailedModel();
  assert.equal(d.relevant({ entry: '--pr', prState: 'ready, no Copilot review yet', defect: 'docs drift' }, 'defect'), false);
  assert.equal(d.relevant({ entry: '--pr', prState: 'ready, no Copilot review yet', defect: 'docs drift' }, 'early'), false);
  assert.equal(d.relevant({ entry: '--pr', prState: 'draft', defect: 'docs drift' }, 'defect'), true);
  assert.equal(d.relevant({ entry: '--pr', prState: 'draft', defect: 'docs drift' }, 'early'), false);
  for (const entry of ['--plan-file', '--spike', '--pr --review', '--pr --ui-review']) {
    assert.equal(d.relevant({ entry, defect: 'docs drift' }, 'early'), false, entry);
  }
  for (const entry of ['--issue', '--lightweight --issue', '--lightweight']) {
    assert.equal(d.relevant({ entry, defect: 'docs drift' }, 'early'), true, entry);
    assert.equal(d.relevant({ entry, defect: 'none' }, 'early'), false, entry);
  }
  const o = overviewModel();
  assert.equal(o.relevant({ config: 'loads', retro: true, defect: 'none' }, 'early'), false);
  assert.equal(o.relevant({ config: 'loads', retro: false, defect: 'docs drift' }, 'early'), false);
});
