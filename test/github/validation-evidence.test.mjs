import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'bun:test';
import { withTempDir } from '../_helpers.mjs';
import { seedValidation } from './_validation-fixture.mjs';
import { readValidationEvidence, validationAbsenceState } from '../../scripts/github/_validation-evidence.mjs';

const HEAD = 'd'.repeat(40);
const read = (root, fixture, extra = {}) => readValidationEvidence({ context: fixture.context, headSha: HEAD, cwd: root, ...extra });
test('malformed documents, legacy outcomes and binding metadata receive specific refusals', async () => {
  for (const configText of ['null', '[]', '42', '{']) await withTempDir(async (root) => {
    const fixture = await seedValidation(root, { configText });
    assert.match((await read(root, fixture)).reason, /malformed|mapping/);
  });
  await withTempDir(async (root) => {
    for (const record of [{ status: 'unknown' }, { status: 'complete', allPassed: null }, { status: 'complete', suites: null }]) {
      const fixture = await seedValidation(root, { record });
      assert.match((await read(root, fixture)).reason, /status|boolean allPassed/);
    }
    const fixture = await seedValidation(root);
    fixture.context.requiredReads = {};
    assert.match((await read(root, fixture)).reason, /not an array/);
    fixture.context.requiredReads = null;
    assert.match((await read(root, fixture)).reason, /not an array/);
  });
});
test('absence uses raw schema and every mapping, without authority defaults', () => {
  const empty = { match: '*.mjs', surface: 'code', commands: [], gateSuites: ['labels-only'] };
  for (const value of [undefined, {}, { paths: [] }, { paths: [empty] }]) assert.ok(validationAbsenceState(value));
  for (const value of [{ mode: 'local' }, { mode: 'ci-only' }, { fullCommand: 'test' }, { paths: [empty, { ...empty, commands: ['test'] }] }]) assert.equal(validationAbsenceState(value), null);
  for (const value of [null, { paths: 'bad' }, { paths: [{ ...empty, commands: [''] }] }]) assert.throws(() => validationAbsenceState(value), /malformed/);
});
test('trusted absent and empty records are warning-only, including realpath aliases', async () => {
  for (const validation of [undefined, {}, { paths: [] }, { paths: [{ match: '*', surface: 'x', commands: [] }] }]) await withTempDir(async (root) => {
    const fixture = await seedValidation(root, { validation });
    assert.equal((await read(root, fixture)).artifact.allPassed, null);
    await symlink(fixture.file, path.join(root, 'alias.json'));
    fixture.context.scope.validationResultsPath = path.join(root, 'alias.json');
    assert.equal((await read(root, fixture)).warning.code, 'validation_not_configured');
  });
  await withTempDir(async (root) => {
    const fixture = await seedValidation(root, { configText: '{"version":1}' });
    assert.equal((await read(root, fixture)).artifact.configResolution.state, 'absent');
  });
});
test('new branch rejects false success, malformed warning/provenance, stale binding and wrong head', async () => {
  await withTempDir(async (root) => {
    for (const record of [{ allPassed: true }, { allPassed: false }, { allPassed: undefined }, { suites: [{}] }, { warning: { code: 'validation_not_configured', message: 'ok' } }, { configResolution: null }]) {
      const fixture = await seedValidation(root, { record });
      assert.ok((await read(root, fixture)).refusal, JSON.stringify(record));
    }
    const fixture = await seedValidation(root);
    assert.match((await read(root, fixture, { headSha: 'e'.repeat(40) })).reason, /head/);
    fixture.context.requiredReads[0].bytes++;
    assert.match((await read(root, fixture)).reason, /hash-bound/);
    fixture.context.requiredReads = [];
    assert.match((await read(root, fixture)).reason, /hash-bound/);
    await rm(fixture.file);
    assert.match((await read(root, fixture)).reason, /unreadable/);
  });
});
test('trust failures never imply absence; explicit authority and checkout config changes refuse', async () => {
  for (const validation of [{ mode: 'ci-only' }, { fullCommand: 'test' }, { paths: [{ match: '*', surface: 'x', commands: ['test'] }] }]) await withTempDir(async (root) => {
    const fixture = await seedValidation(root, { validation });
    assert.match((await read(root, fixture)).reason, /configured/);
  });
  await withTempDir(async (root) => {
    const fixture = await seedValidation(root, { validation: {} });
    for (const [field, value] of [['ref', 'refs/remotes/origin/wrong'], ['commitSha', 'f'.repeat(40)], ['configPath', '.devloops'], ['configSha256', '0'.repeat(64)], ['state', 'absent']]) {
      const altered = { ...fixture.artifact, configResolution: { ...fixture.artifact.configResolution, [field]: value } };
      await writeFile(fixture.file, JSON.stringify(altered));
      assert.ok((await read(root, fixture, { requireBinding: false })).refusal, field);
    }
    await writeFile(fixture.file, JSON.stringify(fixture.artifact));
    await writeFile(path.join(root, '.devloops.json'), '{}');
    assert.match((await read(root, fixture)).reason, /checkout/);
    assert.match((await read(root, fixture, { git: () => { throw new Error('read failed'); } })).reason, /trusted/);
  });
});
test('legacy complete/failed/incomplete/statusless and CI records remain evidence, never new lifecycle refusal', async () => {
  await withTempDir(async (root) => {
    for (const status of [undefined, 'complete', 'failed', 'incomplete']) {
      const fixture = await seedValidation(root, { record: { status, allPassed: status !== 'failed', suites: [], warning: undefined, configResolution: undefined } });
      assert.equal((await read(root, fixture)).refusal, undefined);
    }
  });
});
test('trusted Git failures, malformed raw validation, family precedence and missing checkout source refuse', async () => {
  for (const validation of [{ mode: 'local' }, { paths: 'bad' }, { paths: [{ match: '*', surface: 'x', commands: [''] }] }]) await withTempDir(async (root) => {
    const fixture = await seedValidation(root, { validation });
    assert.match((await read(root, fixture)).reason, /configured|malformed/);
  });
  await withTempDir(async (root) => {
    const fixture = await seedValidation(root, { validation: {} });
    const git = (args) => execFileSync('git', args, { cwd: root });
    for (const failed of ['symbolic-ref', 'rev-parse', 'ls-tree', 'show']) {
      const result = await read(root, fixture, { git: (args) => { if (args[0] === failed) throw new Error(`${failed} failed`); return git(args); } });
      assert.match(result.reason, new RegExp(`${failed} failed`));
    }
    assert.match((await read(root, fixture, { git: (args) => args[0] === 'symbolic-ref' ? Buffer.from('refs/heads/main') : git(args) })).reason, /unresolved/);
    await rm(path.join(root, '.devloops.json'));
    assert.match((await read(root, fixture)).reason, /checkout/);
    await writeFile(path.join(root, '.devloops.json'), JSON.stringify({ validation: {} }));
    await writeFile(path.join(root, '.devloops'), 'validation: {}');
    assert.match((await read(root, fixture)).reason, /checkout/);
  });
});
test('every binding component is required; ENOENT and pointer substitution are never absence', async () => {
  await withTempDir(async (root) => {
    const fixture = await seedValidation(root);
    for (const changed of [{ sha256: '0'.repeat(64) }, { bytes: undefined }, { path: 'missing.json' }]) {
      const context = { ...fixture.context, requiredReads: [{ ...fixture.read, ...changed }] };
      assert.ok((await read(root, fixture, { context })).refusal);
    }
    await writeFile(path.join(root, 'substitute.json'), await readFile(fixture.file));
    const context = { ...fixture.context, scope: { validationResultsPath: 'substitute.json' } };
    assert.match((await read(root, fixture, { context })).reason, /hash-bound/);
    assert.equal(await readValidationEvidence({ context: {}, headSha: HEAD, cwd: root }), null);
  });
});
