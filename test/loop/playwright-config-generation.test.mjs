import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
function discover(args = []) {
  const env = { ...process.env };
  delete env.PW_UI_SLICE;
  delete env.JEST_WORKER_ID; // Bun's Jest-compatible marker must not reach the real Playwright CLI.
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

test('default and broad article discovery retain both original Simulator views', () => {
  for (const args of [[], ['--project=*article*']]) {
    const projects = new Set(discover(args).map(item => item.projectName));
    assert.equal(projects.has('simulator-article'), true);
    assert.equal(projects.has('simulator-overview-article'), true);
  }
});

