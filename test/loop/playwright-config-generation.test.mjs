import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
function discover(args = [], slice) {
  const env = { ...process.env };
  delete env.PW_UI_SLICE;
  delete env.JEST_WORKER_ID; // Bun's Jest-compatible marker must not reach the real Playwright CLI.
  if (slice) env.PW_UI_SLICE = slice;
  let output;
  try {
    output = execFileSync('node', ['node_modules/@playwright/test/cli.js', 'test', '--list', '--reporter=json', ...args], { cwd: repoRoot, env, encoding: 'utf8' });
  } catch (error) {
    throw new Error(`${error.message}\n${error.stdout || ''}`);
  }
  const report = JSON.parse(output);
  function collect(suites) {
    return suites.flatMap(suite => [...(suite.specs || []).flatMap(spec => spec.tests), ...collect(suite.suites || [])]);
  }
  return collect(report.suites);
}

test('automatic default and broad article discovery omit manual examples but retain both original views', () => {
  for (const args of [[], ['--project=*article*']]) {
    const projects = new Set(discover(args).map(item => item.projectName));
    assert.equal(projects.has('workflow-examples'), false);
    assert.equal(projects.has('simulator-article'), true);
    assert.equal(projects.has('simulator-overview-article'), true);
  }
});

test('manual examples require explicit opt-in and remain discoverable', () => {
  assert.throws(() => discover(['--project=workflow-examples']), /Project.*not found/);
  const cases = discover(['--project=workflow-examples'], 'workflow-examples');
  assert.equal(new Set(cases.map(item => item.projectName)).size, 1);
  assert.equal(cases.every(item => item.projectName === 'workflow-examples'), true);
});
