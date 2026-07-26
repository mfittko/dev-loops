import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';

import {
  buildNamedUiStateArtifactPaths,
  captureNamedUiState,
  launchWebkit,
  normalizeUiStateSegment,
  normalizeViewportSegment,
  normalizeInteractionSegment,
  PLAYWRIGHT_MISSING_MESSAGE,
  WEBKIT_MISSING_MESSAGE,
} from '../playwright/harness/webkit-smoke-harness.mjs';

test('normalizeUiStateSegment collapses UI state names into stable path segments', () => {
  assert.equal(normalizeUiStateSegment(' Current PR / Dashboard '), 'current-pr-dashboard');
  assert.equal(normalizeUiStateSegment('100% zoom'), '100-zoom');
  assert.equal(normalizeUiStateSegment('a__b'), 'a-b');
  assert.throws(() => normalizeUiStateSegment('!!!'), /must contain at least one/i);
});

test('normalizeViewportSegment encodes dimensions/breakpoints and rejects malformed descriptors', () => {
  assert.equal(normalizeViewportSegment(undefined), 'default');
  assert.equal(normalizeViewportSegment(null), 'default');
  assert.equal(normalizeViewportSegment({ width: 1280, height: 800 }), 'w1280h800');
  assert.equal(normalizeViewportSegment('Mobile Small'), 'mobile-small');
  assert.throws(() => normalizeViewportSegment({ width: 0, height: 800 }), /positive integer/i);
  assert.throws(() => normalizeViewportSegment({ width: 1280.5, height: 800 }), /positive integer/i);
  assert.throws(() => normalizeViewportSegment(1280), /object or a named breakpoint/i);
});

test('normalizeInteractionSegment defaults to none and rejects unknown interaction states', () => {
  assert.equal(normalizeInteractionSegment(undefined), 'none');
  assert.equal(normalizeInteractionSegment('Focus'), 'focus');
  assert.equal(normalizeInteractionSegment(' hover '), 'hover');
  assert.equal(normalizeInteractionSegment('error'), 'error');
  assert.throws(() => normalizeInteractionSegment('pressed'), /must be one of/i);
});

test('buildNamedUiStateArtifactPaths derives deterministic screenshot and state paths', () => {
  const paths = buildNamedUiStateArtifactPaths({
    outputDir: 'test-results/ui-smoke/inspect-run-viewer',
    sliceId: 'inspect-run-viewer',
    stateName: 'Current PR dashboard',
  });

  assert.equal(paths.stateSlug, 'current-pr-dashboard-default-none');
  assert.equal(paths.viewport, 'default');
  assert.equal(paths.interactionState, 'none');
  assert.equal(paths.artifactDir, path.join('test-results/ui-smoke/inspect-run-viewer', 'named-states', 'current-pr-dashboard-default-none'));
  assert.equal(paths.screenshotPath, path.join(paths.artifactDir, 'screenshot.png'));
  assert.equal(paths.statePath, path.join(paths.artifactDir, 'state.json'));
  assert.equal(paths.snapshotPath, path.join(paths.artifactDir, 'snapshot.json'));
  assert.equal(paths.axePath, path.join(paths.artifactDir, 'axe.json'));
  assert.equal(paths.consolePath, path.join(paths.artifactDir, 'console.json'));
});

test('buildNamedUiStateArtifactPaths gives distinct dirs for viewport- or interaction-only differences', () => {
  const base = { outputDir: 'out', sliceId: 'inspect-run-viewer', stateName: 'Current PR dashboard' };
  const desktop = buildNamedUiStateArtifactPaths({ ...base, viewport: { width: 1280, height: 800 } });
  const mobile = buildNamedUiStateArtifactPaths({ ...base, viewport: { width: 375, height: 667 } });
  const error = buildNamedUiStateArtifactPaths({ ...base, viewport: { width: 1280, height: 800 }, interactionState: 'error' });

  assert.equal(desktop.stateSlug, 'current-pr-dashboard-w1280h800-none');
  assert.equal(mobile.stateSlug, 'current-pr-dashboard-w375h667-none');
  assert.equal(error.stateSlug, 'current-pr-dashboard-w1280h800-error');
  // Differ only by viewport → distinct dirs. Differ only by interaction → distinct dirs.
  assert.notEqual(desktop.artifactDir, mobile.artifactDir);
  assert.notEqual(desktop.artifactDir, error.artifactDir);
});

test('captureNamedUiState writes the deterministic screenshot and state artifact bundle', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'ui-smoke-harness-'));
  const screenshots = [];
  const accessibilityTree = { role: 'WebArea', name: 'Current PR dashboard', children: [{ role: 'heading', name: 'Runs' }] };
  const axeResults = { violations: [{ id: 'color-contrast', impact: 'serious' }], passes: [], incomplete: [], inapplicable: [] };
  const consoleReport = { consoleErrors: [{ message: 'TypeError: boom', stack: 'TypeError: boom\n    at app.js:1' }], failedRequests: [{ kind: 'error-response', url: 'http://app/save', status: 500 }] };

  try {
    const artifact = await captureNamedUiState({
      page: {
        async screenshot(options) {
          screenshots.push(options);
        },
        accessibility: {
          async snapshot() {
            return accessibilityTree;
          },
        },
      },
      runAxe: async () => axeResults,
      captureConsole: async () => consoleReport,
      testInfo: {
        config: { outputDir: tempDir },
        project: { name: 'webkit', outputDir: tempDir },
        title: 'viewer smoke generates named artifacts',
        file: 'test/playwright/inspect-run-viewer.spec.mjs',
      },
      sliceId: 'inspect-run-viewer',
      stateName: 'Current PR dashboard',
      viewport: { width: 1280, height: 800 },
      interactionState: 'error',
      metadata: {
        reviewHint: 'Use this state for the initial dashboard pass.',
        fixture: 'makeInspectionSnapshot',
        route: '/',
      },
    });

    assert.equal(screenshots.length, 1);
    assert.equal(screenshots[0].path, artifact.screenshotPath);
    assert.equal(screenshots[0].fullPage, true);
    await stat(artifact.artifactDir);

    const stateJson = JSON.parse(await readFile(artifact.statePath, 'utf8'));
    assert.equal(stateJson.schemaVersion, 5);
    assert.equal(stateJson.artifactType, 'named-ui-state');
    assert.equal(stateJson.validationLevel, 'deterministic-smoke');
    assert.equal(stateJson.sliceId, 'inspect-run-viewer');
    assert.equal(stateJson.stateName, 'Current PR dashboard');
    assert.equal(stateJson.stateSlug, 'current-pr-dashboard-w1280h800-error');
    assert.equal(stateJson.viewport, 'w1280h800');
    assert.equal(stateJson.interactionState, 'error');
    assert.equal(stateJson.runId, 'inspect-run-viewer-current-pr-dashboard-w1280h800-error-webkit');
    assert.equal(stateJson.projectName, 'webkit');
    assert.equal(stateJson.artifacts.screenshot.fileName, 'screenshot.png');
    assert.equal(stateJson.artifacts.screenshot.relativePath, 'screenshot.png');
    assert.equal(stateJson.artifacts.state.fileName, 'state.json');
    assert.equal(stateJson.artifacts.state.relativePath, 'state.json');
    assert.equal(stateJson.artifacts.snapshot.fileName, 'snapshot.json');
    assert.equal(stateJson.artifacts.snapshot.relativePath, 'snapshot.json');
    assert.equal(stateJson.artifacts.axe.fileName, 'axe.json');
    assert.equal(stateJson.artifacts.axe.relativePath, 'axe.json');
    assert.equal(stateJson.artifacts.console.fileName, 'console.json');
    assert.equal(stateJson.artifacts.console.relativePath, 'console.json');
    assert.equal(stateJson.metadata.fixture, 'makeInspectionSnapshot');
    assert.equal(stateJson.metadata.route, '/');
    assert.match(stateJson.capturedAt, /^\d{4}-\d{2}-\d{2}T/);

    assert.equal(artifact.snapshotPath, path.join(artifact.artifactDir, 'snapshot.json'));
    const snapshotJson = JSON.parse(await readFile(artifact.snapshotPath, 'utf8'));
    assert.deepEqual(snapshotJson, accessibilityTree);

    assert.equal(artifact.axePath, path.join(artifact.artifactDir, 'axe.json'));
    const axeJson = JSON.parse(await readFile(artifact.axePath, 'utf8'));
    assert.deepEqual(axeJson, axeResults);

    assert.equal(artifact.consolePath, path.join(artifact.artifactDir, 'console.json'));
    const consoleJson = JSON.parse(await readFile(artifact.consolePath, 'utf8'));
    assert.deepEqual(consoleJson, consoleReport);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('captureNamedUiState fails closed on a within-run duplicate slug instead of overwriting', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'ui-smoke-harness-dup-'));

  try {
    const first = await captureNamedUiState({
      page: { async screenshot() {} },
      outputDir: tempDir,
      sliceId: 'inspect-run-viewer',
      stateName: 'Current PR dashboard',
    });

    // A second, logically distinct state that normalizes to the same slug must
    // fail closed at capture time — before it can overwrite the first on disk.
    await assert.rejects(
      captureNamedUiState({
        page: { async screenshot() {} },
        outputDir: tempDir,
        sliceId: 'inspect-run-viewer',
        stateName: 'Current PR / Dashboard',
      }),
      /duplicate named ui state slug/i,
    );

    // The first state's artifacts are intact (not clobbered by the rejected capture).
    const stateJson = JSON.parse(await readFile(first.statePath, 'utf8'));
    assert.equal(stateJson.stateName, 'Current PR dashboard');
    assert.equal(stateJson.stateSlug, 'current-pr-dashboard-default-none');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('captureNamedUiState allows the SAME state name to re-capture the same statePath (Playwright retry)', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'ui-smoke-harness-retry-'));

  try {
    // A Playwright retry re-runs the test in the same reused worker process and,
    // because resolvedOutputDir prefers the retry-STABLE testInfo.project.outputDir,
    // re-captures the SAME stateName to the SAME statePath. That is a legitimate
    // overwrite and must NOT trip the duplicate-slug guard.
    const first = await captureNamedUiState({
      page: { async screenshot() {} },
      outputDir: tempDir,
      sliceId: 'inspect-run-viewer',
      stateName: 'Current PR dashboard',
    });

    const retried = await captureNamedUiState({
      page: { async screenshot() {} },
      outputDir: tempDir,
      sliceId: 'inspect-run-viewer',
      stateName: 'Current PR dashboard',
    });

    assert.equal(retried.statePath, first.statePath);
    const stateJson = JSON.parse(await readFile(retried.statePath, 'utf8'));
    assert.equal(stateJson.stateName, 'Current PR dashboard');
    assert.equal(stateJson.stateSlug, 'current-pr-dashboard-default-none');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('captureNamedUiState normalizes undefined metadata contract keys to null', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'ui-smoke-harness-metadata-'));

  try {
    const artifact = await captureNamedUiState({
      page: {
        async screenshot() {},
      },
      outputDir: tempDir,
      sliceId: 'inspect-run-viewer',
      stateName: 'Metadata defaults',
      metadata: {
        fixture: undefined,
        route: undefined,
        reviewHint: undefined,
      },
    });

    const stateJson = JSON.parse(await readFile(artifact.statePath, 'utf8'));
    assert.equal(Object.hasOwn(stateJson.metadata, 'fixture'), true);
    assert.equal(Object.hasOwn(stateJson.metadata, 'route'), true);
    assert.equal(Object.hasOwn(stateJson.metadata, 'reviewHint'), true);
    assert.equal(stateJson.metadata.fixture, null);
    assert.equal(stateJson.metadata.route, null);
    assert.equal(stateJson.metadata.reviewHint, null);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('captureNamedUiState accepts an explicit outputDir without testInfo metadata', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'ui-smoke-harness-explicit-'));

  try {
    const artifact = await captureNamedUiState({
      page: {
        async screenshot() {},
      },
      outputDir: tempDir,
      sliceId: 'inspect-run-viewer',
      stateName: 'Fallback only',
    });

    const stateJson = JSON.parse(await readFile(artifact.statePath, 'utf8'));
    assert.equal(stateJson.projectName, null);
    assert.equal(stateJson.testTitle, null);
    assert.equal(stateJson.testFile, null);
    assert.equal(stateJson.validationLevel, 'deterministic-smoke');
    assert.equal(stateJson.metadata.fixture, null);
    assert.equal(stateJson.metadata.route, null);
    assert.equal(stateJson.metadata.reviewHint, null);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('captureNamedUiState emits snapshot.json as JSON null when the page exposes no accessible tree', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'ui-smoke-harness-null-tree-'));

  try {
    const artifact = await captureNamedUiState({
      page: {
        async screenshot() {},
        accessibility: {
          async snapshot() {
            return null;
          },
        },
      },
      outputDir: tempDir,
      sliceId: 'inspect-run-viewer',
      stateName: 'No accessible tree',
    });

    // Deterministic emit: still written (never skipped), as JSON null.
    const raw = await readFile(artifact.snapshotPath, 'utf8');
    assert.equal(raw, 'null\n');

    const stateJson = JSON.parse(await readFile(artifact.statePath, 'utf8'));
    assert.equal(stateJson.artifacts.snapshot.fileName, 'snapshot.json');
    assert.equal(stateJson.artifacts.snapshot.relativePath, 'snapshot.json');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('captureNamedUiState emits snapshot.json as JSON null when the accessibility API is unavailable', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'ui-smoke-harness-no-a11y-'));

  try {
    // `page.accessibility` is a deprecated Playwright API that can be genuinely
    // absent in a deployed browser build; capture is best-effort and emits a
    // deterministic JSON null rather than throwing (which would break real smokes).
    const artifact = await captureNamedUiState({
      page: { async screenshot() {} },
      outputDir: tempDir,
      sliceId: 'inspect-run-viewer',
      stateName: 'No accessibility API',
    });
    assert.equal(await readFile(artifact.snapshotPath, 'utf8'), 'null\n');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('captureNamedUiState emits axe.json as JSON null when axe cannot run', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'ui-smoke-harness-axe-null-'));

  try {
    // axe is best-effort: a mock page (or a browser build without the runner)
    // throws inside the axe runner; capture falls back to a deterministic JSON
    // null rather than crashing the whole capture. The default runner is used
    // here (no injection), which dynamic-imports @axe-core/playwright and then
    // fails against the mock page.
    const artifact = await captureNamedUiState({
      page: { async screenshot() {} },
      outputDir: tempDir,
      sliceId: 'inspect-run-viewer',
      stateName: 'No axe run',
    });
    assert.equal(await readFile(artifact.axePath, 'utf8'), 'null\n');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('captureNamedUiState emits axe.json as JSON null when the injected runner throws', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'ui-smoke-harness-axe-throw-'));

  try {
    const artifact = await captureNamedUiState({
      page: { async screenshot() {} },
      outputDir: tempDir,
      sliceId: 'inspect-run-viewer',
      stateName: 'Throwing axe runner',
      runAxe: async () => { throw new Error('axe unsupported'); },
    });
    assert.equal(await readFile(artifact.axePath, 'utf8'), 'null\n');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('captureNamedUiState emits console.json as JSON null when no capture seam is provided', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'ui-smoke-harness-console-null-'));

  try {
    // A plain smoke installs no console capture: this harness never listens on
    // its own (the drive owns the single walk-level buffer), so console.json is a
    // deterministic JSON null rather than skipped.
    const artifact = await captureNamedUiState({
      page: { async screenshot() {} },
      outputDir: tempDir,
      sliceId: 'inspect-run-viewer',
      stateName: 'No console capture',
    });
    assert.equal(await readFile(artifact.consolePath, 'utf8'), 'null\n');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('captureNamedUiState emits console.json as JSON null when the injected capture seam throws', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'ui-smoke-harness-console-throw-'));

  try {
    const artifact = await captureNamedUiState({
      page: { async screenshot() {} },
      outputDir: tempDir,
      sliceId: 'inspect-run-viewer',
      stateName: 'Throwing console capture',
      captureConsole: async () => { throw new Error('slice failed'); },
    });
    assert.equal(await readFile(artifact.consolePath, 'utf8'), 'null\n');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('captureNamedUiState emits snapshot.json as JSON null when the accessibility API throws', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'ui-smoke-harness-a11y-throw-'));

  try {
    // A present-but-throwing accessibility API stays best-effort: fall back to a
    // deterministic JSON null rather than crashing the whole capture.
    const artifact = await captureNamedUiState({
      page: {
        async screenshot() {},
        accessibility: { async snapshot() { throw new Error('accessibility unsupported'); } },
      },
      outputDir: tempDir,
      sliceId: 'inspect-run-viewer',
      stateName: 'Throwing accessibility API',
    });
    assert.equal(await readFile(artifact.snapshotPath, 'utf8'), 'null\n');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// Playwright is an optional peer dependency, so both ways it can be missing must
// surface a stated install instruction rather than a module-resolution stack
// trace or an opaque launch error. Imported through the harness re-export, which
// also proves the shipped adapter module stays reachable from the suite.
test('launchWebkit reports a missing @playwright/test package with install instructions', async () => {
  const absent = Object.assign(new Error("Cannot find package '@playwright/test'"), { code: 'ERR_MODULE_NOT_FOUND' });
  await assert.rejects(
    () => launchWebkit({}, { importPlaywright: () => Promise.reject(absent) }),
    (err) => {
      assert.equal(err.message, PLAYWRIGHT_MISSING_MESSAGE);
      assert.match(err.message, /npm install --save-dev @playwright\/test/);
      assert.equal(err.cause, absent, 'the original resolution error is preserved as cause');
      return true;
    },
  );
});

test('launchWebkit does not mislabel an installed-but-broken @playwright/test as missing', async () => {
  // A throw during module evaluation (corrupt install, bad native binding) is
  // not a resolution failure — telling the user to install what they already
  // have would hide the real cause.
  const broken = new SyntaxError('Unexpected token in @playwright/test');
  await assert.rejects(
    () => launchWebkit({}, { importPlaywright: () => Promise.reject(broken) }),
    (err) => {
      assert.equal(err, broken);
      return true;
    },
  );
});

test('launchWebkit reports a resolvable module with no webkit export instead of an opaque TypeError', async () => {
  await assert.rejects(
    () => launchWebkit({}, { importPlaywright: () => Promise.resolve({}) }),
    (err) => {
      assert.equal(err.message, PLAYWRIGHT_MISSING_MESSAGE);
      assert.doesNotMatch(err.message, /undefined/i);
      return true;
    },
  );
});

test('launchWebkit leaves the missing-host-dependencies error intact', async () => {
  // Playwright's host-deps failure also contains the words "playwright install"
  // (it instructs `npx playwright install-deps`). Rewriting it to "install
  // webkit" would give a Linux/container consumer the wrong remedy and discard
  // the list of missing libraries.
  const hostDeps = new Error(
    'browserType.launch: Host system is missing dependencies to run browsers. Please install them with the following command:\n  sudo npx playwright install-deps',
  );
  await assert.rejects(
    () => launchWebkit({}, { importPlaywright: () => Promise.resolve({ webkit: { launch: () => Promise.reject(hostDeps) } }) }),
    (err) => {
      assert.equal(err, hostDeps, 'the host-deps error is rethrown unmasked');
      assert.match(err.message, /install-deps/);
      return true;
    },
  );
});

test('launchWebkit reports a missing WebKit binary and names webkit specifically', async () => {
  // Playwright's own message says `npx playwright install`, which downloads every
  // browser; the wrapper narrows it to the one browser the stages launch.
  const importPlaywright = () => Promise.resolve({
    webkit: { launch: () => Promise.reject(new Error("browserType.launch: Executable doesn't exist at /x/webkit-1/pw_run.sh")) },
  });
  await assert.rejects(
    () => launchWebkit({}, { importPlaywright }),
    (err) => {
      assert.equal(err.message, WEBKIT_MISSING_MESSAGE);
      assert.match(err.message, /playwright install webkit/);
      assert.match(err.cause?.message ?? '', /Executable doesn't exist/, 'the original launch error is preserved as cause');
      return true;
    },
  );
});

test('launchWebkit rethrows an unrelated launch failure unmasked', async () => {
  const importPlaywright = () => Promise.resolve({
    webkit: { launch: () => Promise.reject(new Error('connection refused by sandbox')) },
  });
  await assert.rejects(() => launchWebkit({}, { importPlaywright }), /connection refused by sandbox/);
});

test('launchWebkit returns the browser and honors headless', async () => {
  const launched = [];
  const importPlaywright = () => Promise.resolve({
    webkit: { launch: (opts) => { launched.push(opts); return Promise.resolve({ id: 'browser' }); } },
  });
  assert.deepEqual(await launchWebkit({}, { importPlaywright }), { id: 'browser' });
  assert.deepEqual(await launchWebkit({ headless: false }, { importPlaywright }), { id: 'browser' });
  assert.deepEqual(launched, [{ headless: true }, { headless: false }]);
});
