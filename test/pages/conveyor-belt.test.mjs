import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { createModel } from '../../docs/articles/assets/workflow-models/conveyor-belt.mjs';

// Published profile handlers are the domain seam; browser tests exercise native controls/history.
test('direction reshape requires fresh design authority and every initiative requires fresh preparation inputs', () => {
  const model=createModel();model.defaults();const world=model.world,scratch={};let records={};
  const apply=(graph,node)=>{const result=model.H[graph][node](records,world,scratch);records={...records,...result.set};return result;};
  apply('life','request');apply('questions','cbReadKnowledge');apply('technical','cbTechProduce');apply('technical','cbTechAssess');
  apply('design','cbDesignDecide');apply('preparation','cbEditorialReady');apply('preparation','cbSheetCheck');apply('preparation','cbImport');
  const technical={version:records.technicalEvidenceVersion,status:records.technicalStatus,probes:records.technicalProbes};
  const firstDesign=structuredClone(records.decisionRegister);
  records.learningStatus='reshape';apply('life','cbRevise');
  assert.equal(records.designVersion,2);assert.equal(records.designDecisionVersion,null);
  for(const input of [world.designInput,'pending','design 1 supplied','design 3 supplied']) {
    world.designInput=input;const budget=structuredClone(model.MODEL.budgets(records,scratch));
    assert.equal(apply('design','cbDesignDecide').next,'cbDesignDecide','old or missing design authority must WAIT');
    assert.equal(records.waiting,true);assert.equal(records.designDecisionVersion,null);
    assert.deepEqual(records.decisionRegister,firstDesign);assert.deepEqual(model.MODEL.budgets(records,scratch),budget);
  }
  world.designInput='design 2 supplied';assert.equal(apply('design','cbDesignDecide').next,'cbDesignReady');
  assert.equal(records.waiting,false);assert.equal(records.designDecisionVersion,2);
  assert.deepEqual({version:records.technicalEvidenceVersion,status:records.technicalStatus,probes:records.technicalProbes},technical);
  const design=structuredClone(records.decisionRegister);
  for(const version of [2,3,4]) {
    if(version>2) apply('life','cbRevise');
    assert.equal(records.initiativeVersion,version);assert.equal(records.designDecisionVersion,2);
    for(const input of [world.editorial,'pending',`initiative ${version-1} declared ready`]) {
      world.editorial=input;assert.equal(apply('preparation','cbEditorialReady').next,'cbEditorialReady');assert.equal(records.waiting,true);
    }
    world.editorial=`initiative ${version} declared ready`;
    assert.equal(apply('preparation','cbEditorialReady').next,'cbSheetCheck');assert.equal(records.editorialDecisionVersion,version);
    for(const input of [world.sheet,'pending',`initiative ${version-1} both checked`]) {
      world.sheet=input;assert.equal(apply('preparation','cbSheetCheck').next,'cbSheetCheck');assert.equal(records.waiting,true);
    }
    world.sheet=`initiative ${version} both checked`;
    assert.equal(apply('preparation','cbSheetCheck').next,'cbImport');assert.equal(records.sourceSheetVersion,version);
    apply('preparation','cbImport');assert.equal(records.importStatus,`validated source version ${version}`);
    assert.deepEqual(records.decisionRegister,design);assert.equal(records.designDecisionVersion,2);
  }
  assert.equal(records.revisions,3);assert.equal(apply('life','cbRevise').next,'cbHandoff');assert.equal(records.initiativeVersion,4);
});

test('each new technical invocation gets two probes without resetting retained evidence or global revisions', () => {
  const model=createModel();model.defaults();model.world.technicalEvidence='always unresolved';
  const scratch={};let records=model.H.life.request().set;
  const apply=(graph,node,ret)=>{const result=model.H[graph][node](records,model.world,scratch,ret);records={...records,...result.set};return result;};
  for(const version of [1,2,3,4]) {
    assert.deepEqual(apply('shaping','cbTechnicalCall').next,{sub:'technical',at:'cbTechProduce'});
    assert.deepEqual(model.MODEL.budgets(records,scratch).local.evidenceProbes,[0,2],'new investigation starts with its own unspent probe budget');
    for(const probe of [1,2]) {
      apply('technical','cbTechProduce');
      assert.equal(scratch.cbProbes,probe);assert.equal(records.technicalProbes,probe);
      assert.equal(apply('technical','cbTechAssess').next,probe===1?'cbTechProduce':'cbTechUnknown');
    }
    assert.equal(apply('technical','cbTechUnknown').next.up,'unresolved');
    assert.equal(apply('shaping','cbTechnicalCall','unresolved').next,'cbDesignCall');
    assert.equal(scratch.cbProbes,2,'return consumption must not start another invocation');
    records.technicalEvidenceVersion=records.technicalVersion;
    assert.equal(apply('shaping','cbTechnicalCall').next,'cbDesignCall');
    assert.equal(scratch.cbProbes,2,'preserved evidence must skip the child without resetting scratch');
    assert.equal(records.revisions,version-1);assert.equal(records.technicalVersion,version);
    apply('life','cbRevise');
  }
  assert.equal(records.revisions,3);assert.equal(records.initiativeVersion,4);
  assert.equal(apply('life','cbRevise').next,'cbHandoff');assert.equal(scratch.cbProbes,2);
});
