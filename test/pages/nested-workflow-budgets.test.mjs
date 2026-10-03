import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { createModel as metaModel } from '../../docs/articles/assets/workflow-models/meta-ach.mjs';
import { createModel as playwrightModel } from '../../docs/articles/assets/workflow-models/playwright-test-agents.mjs';

// Exercise the public domain seam; the browser suite covers the native dispatcher/history.
function episode(model) {
  model.defaults();
  const records=model.H.life.request().set, scratch={};
  const apply=(graph,node,ret)=>{
    const result=model.H[graph][node](records,model.world,scratch,ret);
    Object.assign(records,result.set);
    return result;
  };
  return {model,records,scratch,apply,world:model.world};
}

test('Meta fresh test invocation must validate and repair its own first candidate',()=>{
  const {model,records,scratch,apply,world}=episode(metaModel());
  world.validation='invalid once';
  const retained=structuredClone(records.probeRegister.boundary);
  for(const version of [1,2]) {
    apply('life','achTestsCall');
    for(const candidate of [1,2]) {
      apply('tests','achGenerateTest');
      apply('validation','achTestBuild');apply('validation','achOriginalPass');apply('validation','achKillSelected');
      assert.equal(records.targetedTests.candidate,candidate);
      assert.equal(records.validationEvidence.valid,candidate===2,'a new concern must not inherit an already repaired candidate');
      assert.equal(apply('tests','achValidateCall',candidate===2?'valid':'invalid').next,candidate===2?'achTestReturn':'achTestRepair');
      if(candidate===1)assert.equal(apply('tests','achTestRepair').next,'achGenerateTest');
    }
    apply('life','achTestsCall','validated');
    assert.equal(scratch.testCandidates,2,'consuming RETURN must retain this invocation spend');
    assert.equal(records.concernVersion,version);assert.deepEqual(records.probeRegister.boundary,retained);
    if(version===1)apply('life','achRevise');
  }
  world.validation='always invalid';apply('life','achRevise');apply('life','achTestsCall');
  for(const candidate of [1,2]) {
    apply('tests','achGenerateTest');apply('validation','achTestBuild');apply('validation','achOriginalPass');apply('validation','achKillSelected');
    assert.equal(records.validationEvidence.valid,false);
    assert.equal(apply('tests','achTestRepair').next,candidate===1?'achGenerateTest':'achTestCapReturn');
  }
  assert.deepEqual(model.MODEL.budgets(records,scratch),{global:{concernVersions:[3,3]},local:{testCandidates:[2,2]}});
  assert.equal(apply('life','achTestsCall','unresolved').next,'achStop');
  assert.equal(apply('life','achRevise').next,'achStop');assert.equal(records.concernVersion,3);
});

test('Meta concern three rejects missing or already consumed concern-two authorship',()=>{
  const {model,records,scratch,apply,world}=episode(metaModel());
  apply('life','achConcern');apply('life','achRevise');
  world.freshConcern='concern 2 authored';apply('life','achConcern');
  assert.equal(records.concernDecision.version,2);
  const retained=structuredClone({boundary:records.probeRegister.boundary,equivalent:records.probeRegister.equivalent,excluded:records.probeRegister.excluded});
  apply('life','achRevise');
  for(const input of ['concern 2 authored','pending']) {
    world.freshConcern=input;const budget=structuredClone(model.MODEL.budgets(records,scratch));
    assert.equal(apply('life','achConcern').next,'achConcern');assert.equal(records.waiting,true);
    assert.equal(records.concernDecision,null);assert.deepEqual(model.MODEL.budgets(records,scratch),budget);
  }
  world.freshConcern='concern 3 authored';assert.equal(apply('life','achConcern').next,'achMutantsCall');
  assert.equal(records.concernDecision.version,3);assert.equal(records.waiting,false);
  assert.deepEqual({boundary:records.probeRegister.boundary,equivalent:records.probeRegister.equivalent,excluded:records.probeRegister.excluded},retained);
});

for(const failure of ['test defect once','persistent test defect']) {
  test(`Playwright revised intent gets its own repair allowance: ${failure}`,()=>{
    const {model,records,scratch,apply,world}=episode(playwrightModel());
    apply('life','pwIntent');apply('generator','pwGenerate');apply('life','pwHealCall');
    world.failure='test defect once';apply('healer','pwExecute');apply('healer','pwRepair');
    assert.equal(apply('healer','pwExecute').next,'pwVerifiedReturn');
    world.failure='changed requirement once';assert.equal(apply('healer','pwExecute').next,'pwDiagnosisCall');
    apply('life','pwHealCall','changed');assert.equal(scratch.healerRepairs,1);
    const retained=structuredClone({signin:records.scenarioRegister.signin,excluded:records.excludedScenarios});
    apply('life','pwRevise');world.freshIntent='revised scenarios and outcomes confirmed';apply('life','pwIntent');apply('generator','pwGenerate');
    world.failure=failure;apply('life','pwHealCall');
    assert.equal(apply('healer','pwExecute').next,'pwDiagnosisCall','old repair spend must not falsely validate a new test defect');
    const assertion=records.testsArtifact.expected;
    for(const repair of [1,2]) {
      assert.equal(apply('healer','pwRepair').next,'pwExecute');
      assert.equal(apply('healer','pwExecute').next,failure==='test defect once'?'pwVerifiedReturn':'pwDiagnosisCall');
      assert.equal(records.testsArtifact.expected,assertion);
      if(failure==='test defect once')break;
    }
    if(failure==='persistent test defect')assert.equal(apply('healer','pwRepair').next,'pwProductReturn');
    assert.equal(records.intentVersion,2);assert.equal(records.revisionRounds,2);
    assert.deepEqual({signin:records.scenarioRegister.signin,excluded:records.excludedScenarios},retained);
    assert.deepEqual(model.MODEL.budgets(records,scratch).local.healerRepairs,[failure==='test defect once'?1:2,2]);
  });
}

test('Meta interpretation binds current validated evidence and the script stops after concern two',()=>{
  const {model,records,scratch,apply,world}=episode(metaModel());
  for(const version of [1,2,3]) {
    apply('life','achTestsCall');apply('tests','achGenerateTest');
    apply('validation','achTestBuild');apply('validation','achOriginalPass');apply('validation','achKillSelected');
    world.interpretation='new concern once';
    const scripted=apply('interpretation','achHumanInterpret');
    assert.equal(scripted.next,version===3?'achHumanInterpret':'achInterpretReturn');
    if(version<3) {
      assert.equal(records.interpretationRecord.outcome,version===1?'new concern':'valid relevant tests');
      apply('life','achRevise');continue;
    }
    const budget=structuredClone(model.MODEL.budgets(records,scratch));
    for(const input of ['pending','concern 1 valid relevant tests','concern 2 valid relevant tests']) {
      world.interpretation=input;assert.equal(apply('interpretation','achHumanInterpret').next,'achHumanInterpret');
      assert.equal(records.interpretationRecord,null);assert.equal(records.decisionRecorded,false);
      assert.equal(records.humanWorkItem.version,3);assert.deepEqual(model.MODEL.budgets(records,scratch),budget);
    }
    world.interpretation='concern 3 valid relevant tests';
    records.validationEvidence.version=2;
    assert.equal(apply('interpretation','achHumanInterpret').next,'achHumanInterpret');
    assert.equal(records.interpretationRecord,null);
    records.validationEvidence.version=3;
    assert.equal(apply('interpretation','achHumanInterpret').next,'achInterpretReturn');
    assert.equal(records.interpretationRecord.version,3);assert.equal(records.interpretationRecord.outcome,'valid relevant tests');
    assert.equal(records.waiting,false);assert.equal(records.decisionRecorded,true);
  }
});
