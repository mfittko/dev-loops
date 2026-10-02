import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSite } from '../../scripts/pages/build-site.mjs';
import { WORKFLOW_EXAMPLES } from '../../scripts/pages/workflow-examples.mjs';
import { makeWorkflowSiteServer } from './harness/workflow-site-server.mjs';
import { startFixtureServer, stopFixtureServer, captureNamedUiState } from './harness/webkit-smoke-harness.mjs';
import { assertDeckFit, measureArticleFit } from './harness/deck-fit-harness.mjs';

let root, fixture;
test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'workflow-browser-'));
  await buildSite({ outDir: root });
  fixture = await startFixtureServer(() => makeWorkflowSiteServer(root));
});
test.afterAll(async () => { await stopFixtureServer(fixture.server); await rm(root, { recursive: true, force: true }); });
const state = page => page.locator('#runtime-state').evaluate(el => JSON.parse(el.textContent));
const click = (page, id) => page.locator(`#${id}`).evaluate(el => el.click());
async function supply(page, values) {
  for (const { key, value } of values) {
    await page.locator(`#facts [data-k="${key}"]`).evaluate((el, value) => {
      if (el.type === 'checkbox') el.checked = value; else el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
  }
}
async function finish(page, smoke, rework) {
  let calls = 0, returns = 0, consumed = 0;
  for (let i = 0; i < smoke.maxSteps; i++) {
    const before = await state(page);
    if (before.done) return { result: before, calls, returns, consumed };
    if (before.records.waiting) {
      const key = `${before.position.g}.${before.position.n}`;
      const rollbackInputs = before.records.deployments === 1 ? smoke.rollbackResumeAt?.[key] : null;
      const inputs = rollbackInputs || (rework ? smoke.reworkResumeAt?.[key] : null) || smoke.resumeAt?.[key];
      expect(inputs, `explicit resume input for ${key}`).toBeTruthy();
      await supply(page, inputs);
      expect((await state(page)).execution).toEqual(before.execution);
    }
    await click(page, 'next');
    const after = await state(page);
    const next = after.lastTransition.next;
    if (typeof next === 'object' && next.sub) {
      calls++;
      expect(after.stack).toEqual([...before.stack, after.lastTransition.from]);
      expect(after.position).toEqual({ g: next.sub, n: next.at });
    }
    if (typeof next === 'object' && next.up) {
      returns++;
      expect(after.position).toEqual(before.stack.at(-1));
      expect(after.stack).toEqual(before.stack.slice(0, -1));
      expect(after.pendingReturn).toBe(next.up);
      await click(page, 'back');
      expect((await state(page)).execution).toEqual(before.execution);
      await click(page, 'next');
      expect(await state(page)).toEqual(after);
    }
    if (after.lastTransition.consumedReturn !== null) {
      consumed++;
      expect(after.lastTransition.consumedReturn).toBe(before.pendingReturn);
      expect(after.lastTransition.from).toEqual(before.position);
    }
  }
  throw Error('Workflow did not finish within its declared illustrative bound');
}
for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  for (const example of WORKFLOW_EXAMPLES) {
    test(`${example.slug} ${viewport.width}px preserves explicit human authority, nested results and replay`, async ({ page }, testInfo) => {
      test.setTimeout(180000);
      const errors = [];
      page.on('pageerror', e => errors.push(String(e)));
      await page.route('https://fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: ':root { --sans: Arial,sans-serif; --display: Arial,sans-serif; --mono: "Courier New",monospace; }' }));
      await page.route('https://fonts.gstatic.com/**', r => r.abort());
      await page.setViewportSize(viewport);
      await page.goto(`${fixture.url}/${example.file}`, { waitUntil: 'networkidle' });
      await expect(page.locator('#runtime-state')).toContainText(example.slug);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(example.metadata.title);
      const smoke = example.metadata.smoke;
      let preservedCheckoutRules;
      for (const [preset, rework] of [[smoke.successPreset, false], [smoke.reworkPreset, true]]) {
        const retained = example.slug === 'conveyor-belt' ? {directionVersion:1,designVersion:1,technicalVersion:rework ? 2 : 1}
          : example.slug === 'evalgen' ? {rubricVersion:rework ? 2 : 1,gradeVersion:rework ? 2 : 1,evaluatorVersion:rework ? 2 : 1,alignmentVersion:rework ? 2 : 1}
          : example.slug === 'collaborative-grilling' ? {proposalVersion:rework ? 2 : 1,stageReady:true,outcomeAchieved:false}
          : example.slug === 'product-design-frontend' ? {scopeRevision:1,designRevision:rework ? 2 : 1,outcomeAchieved:true}
          : example.slug === 'incident-response' ? {diagnosticAttempts:rework ? 2 : 1,repairAttempts:1,deployments:1,rollbacks:0,authorization:'consumed',approvedDeployment:1} : null;
        await page.locator(`#chips [data-s="${preset}"]`).click();
        const proof = await finish(page, smoke, rework);
        expect(proof.result.records.workflowStatus).toBe(smoke.successStatus);
        expect(proof.calls).toBeGreaterThan(1);
        if (retained) expect(proof.result.records).toMatchObject(retained);
        if (example.slug === 'product-design-frontend') {
          expect(proof.result.records.designerInspection.buildRevision).toBe(proof.result.records.buildRevision);
          expect(proof.result.records.checkRecord.buildRevision).toBe(proof.result.records.buildRevision);
          expect(proof.result.records.implementationRecord.designRevision).toBe(proof.result.records.designRevision);
          const rules = {business:proof.result.records.rememberedBusinessRule,instrumentation:proof.result.records.rememberedInstrumentation};
          if (preservedCheckoutRules) expect(rules).toEqual(preservedCheckoutRules);
          else preservedCheckoutRules = rules;
        }
        expect(proof.returns).toBe(proof.calls);
        expect(proof.consumed).toBe(proof.returns);
        await click(page, 'back');
        expect((await state(page)).done).toBe(false);
        await click(page, 'next');
        expect(await state(page)).toEqual(proof.result);
        assertDeckFit(await measureArticleFit(page), `${viewport.width}px completed workflow`);
      }
      if (example.slug === 'incident-response') {
        for (const [preset,status,diagnosticAttempts,repairAttempts,deployments,rollbacks] of [
          [3,'resolved',1,2,1,0], [4,'resolved',2,2,2,1], [5,'blocked handoff',1,0,0,0],
          [7,'human escalation',1,1,0,0], [8,'human escalation',2,2,2,2],
          [9,'resolved',1,1,1,0], [10,'resolved',1,1,1,0],
        ]) {
          await page.locator(`#chips [data-s="${preset}"]`).click();
          const proof = await finish(page, smoke, false);
          expect(proof.result.records).toMatchObject({workflowStatus:status,incidentStatus:status,diagnosticAttempts,repairAttempts,deployments,rollbacks});
          expect(proof.returns).toBe(proof.calls);
          expect(proof.consumed).toBe(proof.returns);
          await click(page, 'back'); await click(page, 'next');
          expect(await state(page)).toEqual(proof.result);
        }
        for (const [preset,premature] of [[1,true],[4,false]]) {
          await page.locator(`#chips [data-s="${preset}"]`).click();
          if (premature) await supply(page, [{key:'approval',value:'deployment 2 approved'}]);
          await click(page, 'run');
          if (!premature) {
            await supply(page, smoke.resumeAt['life.authorize']);
            await click(page, 'run');
          }
          const approvalWait = await state(page);
          expect(approvalWait.position).toEqual({g:'life',n:'authorize'});
          expect(approvalWait.records).toMatchObject({waiting:true,authorization:'pending',deployments:premature ? 0 : 1,rollbacks:premature ? 0 : 1});
          expect(approvalWait.conditions.approval).toBe(premature ? 'deployment 2 approved' : 'deployment 1 approved');
          for (const control of ['next','run']) {
            await click(page, control);
            const polled = await state(page);
            expect(polled.records).toEqual(approvalWait.records);
            expect(polled.scratch).toEqual(approvalWait.scratch);
            expect(polled.position).toEqual(approvalWait.position);
          }
          await supply(page, (premature ? smoke.resumeAt : smoke.rollbackResumeAt)['life.authorize']);
          const resumed = (await finish(page, smoke, false)).result.records;
          expect(resumed).toMatchObject({workflowStatus:'resolved',authorization:'consumed',approvedDeployment:premature ? 1 : 2,deployments:premature ? 1 : 2});
        }
      }
      if (example.slug === 'product-design-frontend') {
        await page.locator('#chips [data-s="4"]').click();
        const repaired = (await finish(page, smoke, true)).result.records;
        expect(repaired).toMatchObject({scopeRevision:1,designRevision:1,buildRevision:2,outcomeAchieved:true});
        expect(repaired.designerInspection).toMatchObject({buildRevision:2,designRevision:1});
        await page.locator('#chips [data-s="5"]').click();
        const insufficient = (await finish(page, smoke, false)).result.records;
        expect(insufficient).toMatchObject({workflowStatus:'human checkout team handoff',measurementAttempts:2,stageReady:false,outcomeAchieved:false});
        await page.locator('#chips [data-s="1"]').click();
        await supply(page, [{key:'behaviorCheck',value:'product ambiguity once'}]);
        const productSmoke = {...smoke,reworkResumeAt:{...smoke.reworkResumeAt,
          'discovery.problemInput':[{key:'problemEvidence',value:'problem 2 evidence supplied'}],
          'discovery.jointScope':[{key:'jointScope',value:'scope 2 jointly authored'}]}};
        const reshaped = (await finish(page, productSmoke, true)).result.records;
        expect(reshaped).toMatchObject({scopeRevision:2,designRevision:2,outcomeAchieved:true});
        expect(reshaped.scopeRecord).toMatchObject({version:2,status:'jointly authored'});
        expect({business:reshaped.rememberedBusinessRule,instrumentation:reshaped.rememberedInstrumentation}).toEqual(preservedCheckoutRules);
      }
      await page.locator(`#chips [data-s="${smoke.humanWaitPreset}"]`).click();
      await click(page, 'run');
      const waiting = await state(page);
      expect(waiting.records.waiting).toBe(true);
      expect(waiting.done).toBe(false);
      for (const control of ['next', 'run', 'next', 'run']) {
        await click(page, control);
        const polled = await state(page);
        expect(polled.position).toEqual(waiting.position);
        expect(polled.records).toEqual(waiting.records);
        expect(polled.scratch).toEqual(waiting.scratch);
        expect(polled.done).toBe(false);
      }
      const beforeInput = (await state(page)).execution;
      await supply(page, smoke.resumeAt[`${waiting.position.g}.${waiting.position.n}`]);
      expect((await state(page)).execution).toEqual(beforeInput);
      await finish(page, smoke, false);
      await page.emulateMedia({ colorScheme: viewport.width === 390 ? 'dark' : 'light' });
      await page.locator('#stepno').scrollIntoViewIfNeeded();
      await captureNamedUiState({ page, testInfo, sliceId: 'workflow-examples', stateName: `${example.slug}-${viewport.width}-completed`, viewport, fullPage: false, metadata: { route: example.file, reviewHint: 'Actual modeled completion; source boundaries, trace and controls remain available.' } });
      const conditions = (await state(page)).conditions;
      await click(page, 'reset');
      const reset = await state(page);
      expect(reset.position).toEqual({ g: 'life', n: 'request' });
      expect(reset.step).toBe(0);
      expect(reset.records).toEqual({});
      expect(reset.scratch).toEqual({});
      expect(reset.conditions).toEqual(conditions);
      if (viewport.width === 390) {
        await page.locator('#scroller').evaluate(el => { el.scrollLeft = 0; });
        await page.locator('#cttoggle').click();
        expect(await page.locator('#scroller').evaluate(el => el.scrollLeft)).toBe(0);
      }
      const entry = page.locator('#g [data-open]').first();
      await entry.focus(); await page.keyboard.press('Enter');
      await expect(page.locator('#backrun')).toBeVisible();
      await page.locator('#backrun').click();
      await page.locator('#nav [data-g]').last().click();
      const frozenGraphExecution = (await state(page)).execution;
      for (const full of [false,true]) {
        if (full) { await page.keyboard.press('f');await expect(page.locator('.board')).toHaveClass(/\bfull\b/); }
        await page.locator('#scroller').focus();
        expect(await page.evaluate(() => document.activeElement.id)).toBe('scroller');
        await page.locator('#scroller').evaluate(el => { el.scrollLeft=0;el.scrollTop=0; });
        for (const [forward,backward,size,client,offset] of [
          ['ArrowRight','ArrowLeft','scrollWidth','clientWidth','scrollLeft'],
          ['ArrowDown','ArrowUp','scrollHeight','clientHeight','scrollTop'],
        ]) {
          const overflow=await page.locator('#scroller').evaluate((el,{size,client})=>el[size]>el[client],{size,client});
          await page.keyboard.press(forward);
          if (overflow) await expect.poll(()=>page.locator('#scroller').evaluate((el,offset)=>el[offset],offset)).toBeGreaterThan(0);
          const moved=await page.locator('#scroller').evaluate((el,offset)=>el[offset],offset);
          await page.keyboard.press(backward);
          if (overflow) await expect.poll(()=>page.locator('#scroller').evaluate((el,offset)=>el[offset],offset)).toBeLessThan(moved);
        }
        expect((await state(page)).execution).toEqual(frozenGraphExecution);
        expect((await new AxeBuilder({page}).include('#scroller').withRules(['scrollable-region-focusable']).analyze()).violations).toEqual([]);
        if (full) { await page.keyboard.press('f');await expect(page.locator('.board')).not.toHaveClass(/\bfull\b/); }
      }
      await page.locator('#trace').focus(); await page.keyboard.press('ArrowRight');
      expect((await state(page)).step).toBe(0);
      await expect(page.locator('#sources a').first()).toHaveAttribute('href', /^https:\/\//);
      await expect(page.locator('header .views a').nth(0)).toHaveAttribute('href', 'simulator-overview.html');
      await expect(page.locator('header .views a').nth(1)).toHaveAttribute('href', 'simulator.html');
      await page.getByRole('link', { name: 'Simulator', exact: true }).click();
      await expect(page).toHaveURL(/\/simulator-overview\.html$/);
      await expect(page.locator('header .views a').nth(0)).toHaveAttribute('aria-current', 'page');
      await expect(page.locator('header .views a').nth(1)).toHaveAttribute('href', 'simulator.html');
      await page.locator('header .views a').nth(1).click();
      await expect(page).toHaveURL(/\/simulator\.html$/);
      await expect(page.locator('header .views a').nth(0)).toHaveAttribute('href', 'simulator-overview.html');
      await expect(page.locator('header .views a').nth(1)).toHaveAttribute('aria-current', 'page');
      await page.locator('header .views a').nth(0).click();
      await page.locator('a[href="simulator.html#examples"]').click();
      await expect(page.locator('#examples')).toHaveAttribute('open', '');
      await page.locator(`#examples a[href="${example.file}"]`).click();
      await expect(page).toHaveURL(new RegExp(`/${example.file.replace('.', '\\.')}$`));
      expect(errors).toEqual([]);
    });
  }
}

for (const width of [1280,390]) {
  test(`collaborative-grilling ${width}px rejects stale version 2 and 3 decisions`, async ({page},testInfo) => {
    test.setTimeout(180_000);
    await page.setViewportSize({width,height:844});
    await page.goto(`${fixture.url}/workflow-collaborative-grilling.html`);
    await page.waitForFunction(() => document.querySelector('#runtime-state')?.textContent.includes('"position"'));
    const smoke=WORKFLOW_EXAMPLES.find(example=>example.slug==='collaborative-grilling').metadata.smoke;
    for (const version of [2,3]) {
      await page.locator('#chips [data-s="2"]').click();
      await click(page,'run');
      const initial=await state(page);
      const independent={knowledge:initial.records.questionRegister.knowledge,excluded:initial.records.questionRegister.excluded,risk:initial.records.questionRegister.risk,decisions:initial.records.preservedDecisions,dissent:initial.records.questionRegister.conflict.dissent};
      if (version===3) {
        await supply(page,[{key:'freshTradeoff',value:'proposal 2: revise scope'},{key:'jointInput',value:'proposal 2: joint resolution recorded'}]);
        await click(page,'run');
      }
      const staleTradeoff=await state(page);
      expect(staleTradeoff.position).toEqual({g:'deliberation',n:'grillTradeoff'});
      expect(staleTradeoff.records).toMatchObject({proposalVersion:version,waiting:true,decisionRecorded:false,stageReady:false});
      if (version===3) await supply(page,[{key:'freshTradeoff',value:'proposal 2: accept bounded scope'}]);
      await click(page,'next');await click(page,'run');
      expect((await state(page)).records).toEqual(staleTradeoff.records);
      await supply(page,[{key:'freshTradeoff',value:`proposal ${version}: accept bounded scope`}]);
      await click(page,'run');
      const staleJoint=await state(page);
      expect(staleJoint.position).toEqual({g:'deliberation',n:'grillConflict'});
      expect(staleJoint.records).toMatchObject({proposalVersion:version,waiting:true,decisionRecorded:false,stageReady:false});
      for (const control of ['next','run']) {
        await click(page,control);
        expect((await state(page)).records).toEqual(staleJoint.records);
        expect((await state(page)).scratch).toEqual(staleJoint.scratch);
      }
      await captureNamedUiState({page,testInfo,sliceId:'workflow-examples',stateName:`grilling-v${version}-stale-joint-${width}`,viewport:{width,height:844},fullPage:false});
      await supply(page,[{key:'jointInput',value:`proposal ${version}: joint resolution recorded`}]);
      const beforeResume=(await state(page)).execution;
      await click(page,'next');const resumed=await state(page);
      expect(resumed.records.questionRegister.conflict).toMatchObject({version,status:'resolved with dissent'});
      await click(page,'back');expect((await state(page)).execution).toEqual(beforeResume);
      await click(page,'next');expect(await state(page)).toEqual(resumed);
      const completed=(await finish(page,smoke,false)).result;
      expect(completed.records).toMatchObject({proposalVersion:version,stageReady:true,outcomeAchieved:false});
      expect({knowledge:completed.records.questionRegister.knowledge,excluded:completed.records.questionRegister.excluded,risk:completed.records.questionRegister.risk,decisions:completed.records.preservedDecisions,dissent:completed.records.questionRegister.conflict.dissent}).toEqual(independent);
      await click(page,'back');await click(page,'next');expect(await state(page)).toEqual(completed);
      await click(page,'reset');expect((await state(page)).records).toEqual({});
      expect((await state(page)).conditions.jointInput).toBe(`proposal ${version}: joint resolution recorded`);
    }
  });
}

test('original detailed graph arrows scroll the real normal and full-window owner without executing', async ({page}) => {
  await page.setViewportSize({width:390,height:844});
  await page.goto(`${fixture.url}/simulator.html`);
  await page.waitForFunction(()=>document.querySelector('#runtime-state')?.textContent.includes('"position"'));
  await page.locator('#nav [data-g]').last().click();
  const frozen=(await state(page)).execution;
  for (const full of [false,true]) {
    if (full) { await page.keyboard.press('f');await expect(page.locator('.board')).toHaveClass(/\bfull\b/); }
    await page.locator('#scroller').focus();
    const owner=full?page.locator('.board'):page.locator('#scroller');
    await owner.evaluate(el=>{el.scrollLeft=0;el.scrollTop=0;});
    for (const [forward,backward,size,client,offset] of [
      ['ArrowRight','ArrowLeft','scrollWidth','clientWidth','scrollLeft'],
      ['ArrowDown','ArrowUp','scrollHeight','clientHeight','scrollTop'],
    ]) {
      const overflow=await owner.evaluate((el,{size,client})=>el[size]>el[client],{size,client});
      await page.keyboard.press(forward);
      if (overflow) await expect.poll(()=>owner.evaluate((el,offset)=>el[offset],offset)).toBeGreaterThan(0);
      const moved=await owner.evaluate((el,offset)=>el[offset],offset);
      await page.keyboard.press(backward);
      if (overflow) await expect.poll(()=>owner.evaluate((el,offset)=>el[offset],offset)).toBeLessThan(moved);
    }
    expect((await state(page)).execution).toEqual(frozen);
    expect((await new AxeBuilder({page}).include('#scroller').withRules(['scrollable-region-focusable']).analyze()).violations).toEqual([]);
    if (full) { await page.keyboard.press('f');await expect(page.locator('.board')).not.toHaveClass(/\bfull\b/); }
  }
  await page.locator('#next').focus();await page.keyboard.press('ArrowRight');expect((await state(page)).step).toBe(1);
  await page.keyboard.press('ArrowLeft');expect((await state(page)).step).toBe(0);
  await click(page,'next');await page.locator('#scroller').focus();await page.keyboard.press('r');expect((await state(page)).step).toBe(0);
});

async function resumeConveyor(page,key,value) {
  const before=(await state(page)).execution;
  await page.locator(`#facts [data-k="${key}"]`).selectOption(value);
  expect((await state(page)).execution).toEqual(before);
  await click(page,'next');const resumed=await state(page);
  await click(page,'back');expect((await state(page)).execution).toEqual(before);
  await click(page,'next');expect(await state(page)).toEqual(resumed);
  return resumed;
}

for(const width of [1280,390]) {
  test(`conveyor-belt ${width}px reshape rejects stale design and preparation authority`,async({page},testInfo)=>{
    test.setTimeout(180_000);
    await page.setViewportSize({width,height:844});await page.goto(`${fixture.url}/workflow-conveyor-belt.html`);
    await page.locator('#worldbox > summary').click();
    await page.locator('#chips [data-s="4"]').click();await click(page,'run');
    const reshaped=await state(page);
    expect(reshaped.position).toEqual({g:'design',n:'cbDesignDecide'});
    expect(reshaped.records).toMatchObject({initiativeVersion:2,designVersion:2,designDecisionVersion:null,technicalVersion:1,technicalEvidenceVersion:1,technicalProbes:1,waiting:true});
    const technical={version:reshaped.records.technicalEvidenceVersion,probes:reshaped.records.technicalProbes,scratch:reshaped.scratch};
    const priorDesign=reshaped.records.decisionRegister.filter(r=>r.dimension==='design');
    for(const [key,node,stale,current,record] of [
      ['designInput','cbDesignDecide','design 1 supplied','design 2 supplied','designDecisionVersion'],
      ['editorial','cbEditorialReady','initiative 1 declared ready','initiative 2 declared ready','editorialDecisionVersion'],
      ['sheet','cbSheetCheck','initiative 1 both checked','initiative 2 both checked','sourceSheetVersion']
    ]) {
      const waiting=await state(page);
      expect(waiting.position.n).toBe(node);expect(waiting.records.waiting).toBe(true);
      for(const input of ['pending',stale]) {
        await page.locator(`#facts [data-k="${key}"]`).selectOption(input);
        for(const control of ['next','run']) {
          await click(page,control);const still=await state(page);
          expect(still.position).toEqual(waiting.position);expect(still.records).toEqual(waiting.records);
          expect(still.scratch).toEqual(waiting.scratch);
        }
      }
      await captureNamedUiState({page,testInfo,sliceId:'workflow-examples',stateName:`conveyor-${key}-stale-${width}`,viewport:{width,height:844},fullPage:false});
      const resumed=await resumeConveyor(page,key,current);
      expect(resumed.records[record]).toBe(2);expect(resumed.records.waiting).toBe(false);
      expect({version:resumed.records.technicalEvidenceVersion,probes:resumed.records.technicalProbes,scratch:resumed.scratch}).toEqual(technical);
      expect(resumed.records.decisionRegister.filter(r=>r.dimension==='design'&&r.version===1)).toEqual(priorDesign);
      await captureNamedUiState({page,testInfo,sliceId:'workflow-examples',stateName:`conveyor-${key}-current-${width}`,viewport:{width,height:844},fullPage:false});
      await click(page,'run');
      if(key==='designInput') {
        expect((await state(page)).position).toEqual({g:'shaping',n:'cbJoin'});
        await resumeConveyor(page,'stakeholderKnowledge','direction 2 supplied');await click(page,'run');
        expect((await state(page)).position).toEqual({g:'life',n:'cbCommit'});
        await resumeConveyor(page,'commitment','version 2 committed');await click(page,'run');
      }
    }
    expect((await state(page)).position).toEqual({g:'learning',n:'cbInterpret'});
    await resumeConveyor(page,'interpretation','version 2 interpreted');await click(page,'run');
    const complete=await state(page);
    expect(complete.records).toMatchObject({workflowStatus:'outcome interpreted',initiativeVersion:2,designDecisionVersion:2,editorialDecisionVersion:2,sourceSheetVersion:2,importStatus:'validated source version 2'});
    await click(page,'back');await click(page,'next');expect(await state(page)).toEqual(complete);
    await click(page,'reset');expect((await state(page)).records).toEqual({});
    expect((await state(page)).conditions.designInput).toBe('design 2 supplied');
  });

  test(`conveyor-belt ${width}px every technical CALL gets two local probes through the global cap`,async({page},testInfo)=>{
    test.setTimeout(180_000);
    await page.setViewportSize({width,height:844});await page.goto(`${fixture.url}/workflow-conveyor-belt.html`);
    await page.locator('#worldbox > summary').click();
    await page.locator('#facts [data-k="technicalEvidence"]').selectOption('always unresolved');
    const probes={1:[],2:[],3:[],4:[]};let calls=0;
    for(let i=0;i<180;i++) {
      const before=await state(page);if(before.done)break;
      await click(page,'next');const after=await state(page);
      if(after.lastTransition.next?.sub==='technical') {
        calls++;expect(after.scratch.cbProbes).toBe(0);
        await click(page,'back');expect((await state(page)).execution).toEqual(before.execution);
        await click(page,'next');expect(await state(page)).toEqual(after);
      }
      if(before.position.n==='cbTechProduce')probes[after.records.technicalVersion].push(after.records.technicalProbes);
      expect(after.scratch.cbProbes??0).toBeLessThanOrEqual(2);
    }
    const capped=await state(page);
    expect(capped.done).toBe(true);expect(calls).toBe(4);
    expect(probes).toEqual({1:[1,2],2:[1,2],3:[1,2],4:[1,2]});
    expect(capped.records).toMatchObject({workflowStatus:'human initiative handoff',revisions:3,initiativeVersion:4,technicalVersion:4,designVersion:1,designDecisionVersion:1,stakeholderDecisionVersion:1});
    expect(capped.records.decisionRegister.filter(r=>r.dimension==='design').map(r=>r.version)).toEqual([1]);
    await captureNamedUiState({page,testInfo,sliceId:'workflow-examples',stateName:`conveyor-probe-cap-${width}`,viewport:{width,height:844},fullPage:false});
    await click(page,'back');await click(page,'next');expect(await state(page)).toEqual(capped);
  });

  test(`conveyor-belt ${width}px current human inputs remain reachable through initiative 4`,async({page},testInfo)=>{
    test.setTimeout(180_000);
    await page.setViewportSize({width,height:844});await page.goto(`${fixture.url}/workflow-conveyor-belt.html`);
    await page.locator('#worldbox > summary').click();
    await page.locator('#facts [data-k="validation"]').selectOption('always fails');
    const commitments=[],editorial=[],sheets=[],interpretations=[],probes=[];
    for(let i=0;i<210;i++) {
      const before=await state(page);if(before.done)break;
      if(before.records.waiting) {
        const version=before.records.initiativeVersion;
        const input={
          cbCommit:['commitment',`version ${version} committed`,commitments],
          cbEditorialReady:['editorial',`initiative ${version} declared ready`,editorial],
          cbSheetCheck:['sheet',`initiative ${version} both checked`,sheets],
          cbInterpret:['interpretation',`version ${version} interpreted`,interpretations]
        }[before.position.n];
        expect(input,`explicit current input at ${before.position.n}`).toBeTruthy();
        const [key,value,versions]=input;await resumeConveyor(page,key,value);versions.push(version);
      } else {
        if(before.position.n==='cbValidate'&&before.records.initiativeVersion===4)await page.locator('#facts [data-k="validation"]').selectOption('validated');
        await click(page,'next');const after=await state(page);
        if(before.position.n==='cbTechProduce')probes.push([after.records.technicalVersion,after.records.technicalProbes]);
      }
    }
    const capped=await state(page);
    expect(capped.done).toBe(true);
    expect([commitments,editorial,sheets]).toEqual([[2,3,4],[2,3,4],[2,3,4]]);
    expect(probes).toEqual([[1,1],[2,1],[3,1],[4,1]]);
    expect(interpretations).toEqual([4]);
    expect(capped.records).toMatchObject({workflowStatus:'outcome interpreted',revisions:3,initiativeVersion:4,commitmentVersion:4,editorialDecisionVersion:4,sourceSheetVersion:4,importStatus:'validated source version 4',designDecisionVersion:1,stakeholderDecisionVersion:1,outcomeAchieved:true});
    expect(capped.records.decisionRegister.filter(r=>r.owner==='Product + Engineering').map(r=>r.version)).toEqual([1,2,3,4]);
    await captureNamedUiState({page,testInfo,sliceId:'workflow-examples',stateName:`conveyor-initiative-4-${width}`,viewport:{width,height:844},fullPage:false});
    await click(page,'back');await click(page,'next');expect(await state(page)).toEqual(capped);
  });
}
