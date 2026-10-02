import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { createModel } from '../../docs/articles/assets/workflow-models/collaborative-grilling.mjs';

test('affected tradeoff and joint decisions require the current proposal, while independent records survive', () => {
  const model=createModel();model.defaults();const world=model.world, scratch={};let records={};
  const apply=(graph,node)=>{const result=model.H[graph][node](records,world,scratch);records={...records,...result.set};return result;};
  apply('life','request');apply('knowledge','grillOwnerAnswer');apply('deliberation','grillTradeoff');apply('deliberation','grillConflict');
  const independent={knowledge:records.questionRegister.knowledge,excluded:records.questionRegister.excluded,risk:records.questionRegister.risk,decisions:records.preservedDecisions,dissent:records.questionRegister.conflict.dissent};
  for(const version of [2,3]) {
    apply('life','grillRevise');
    assert.equal(records.proposalVersion,version);
    const conflictBefore=structuredClone(records.questionRegister.conflict);
    assert.equal(apply('deliberation','grillConflict').next,'grillConflict','previous joint contribution must WAIT after revision');
    assert.equal(records.waiting,true);assert.deepEqual(records.questionRegister.conflict,conflictBefore);
    for(const input of ['pending','accept bounded scope',`proposal ${version-1}: accept bounded scope`]) {
      world.freshTradeoff=input;const before=structuredClone(records.questionRegister.tradeoff);
      assert.equal(apply('deliberation','grillTradeoff').next,'grillTradeoff');assert.deepEqual(records.questionRegister.tradeoff,before);
    }
    world.freshTradeoff=`proposal ${version}: accept bounded scope`;
    assert.equal(apply('deliberation','grillTradeoff').next,'grillConflict');assert.equal(records.questionRegister.tradeoff.status,'decided');
    world.jointInput=`proposal ${version}: joint resolution recorded`;
    assert.equal(apply('deliberation','grillConflict').next,'grillStageCriteria');assert.equal(records.waiting,false);assert.equal(records.questionRegister.conflict.status,'resolved with dissent');assert.equal(records.questionRegister.conflict.version,version);
    assert.deepEqual({knowledge:records.questionRegister.knowledge,excluded:records.questionRegister.excluded,risk:records.questionRegister.risk,decisions:records.preservedDecisions,dissent:records.questionRegister.conflict.dissent},independent);
  }
});
