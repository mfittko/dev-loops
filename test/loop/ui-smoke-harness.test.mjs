import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';

import {
  buildNamedUiStateArtifactPaths,
  captureNamedUiState,
  normalizeUiStateSegment,
} from '../playwright/harness/webkit-smoke-harness.mjs';

test('normalizeUiStateSegment collapses UI state names into stable path segments', () => {
  assert.equal(normalizeUiStateSegment(' Current PR / Dashboard '), 'current-pr-dashboard');
  assert.equal(normalizeUiStateSegment('100% zoom'), '100-zoom');
  assert.equal(normalizeUiStateSegment('a__b'), 'a-b');
  assert.throws(() => normalizeUiStateSegment('!!!'), /must contain at least one/i);
});

test('buildNamedUiStateArtifactPaths derives deterministic screenshot and state paths', () => {
  const paths = buildNamedUiStateArtifactPaths({
    outputDir: 'test-results/ui-smoke/inspect-run-viewer',
    sliceId: 'inspect-run-viewer',
    stateName: 'Current PR dashboard',
  });

  assert.equal(paths.stateSlug, 'current-pr-dashboard');
  assert.equal(paths.artifactDir, path.join('test-results/ui-smoke/inspect-run-viewer', 'named-states', 'current-pr-dashboard'));
  assert.equal(paths.screenshotPath, path.join(paths.artifactDir, 'screenshot.png'));
  assert.equal(paths.statePath, path.join(paths.artifactDir, 'state.json'));
  assert.equal(paths.snapshotPath, path.join(paths.artifactDir, 'snapshot.json'));
});

test('captureNamedUiState writes the deterministic screenshot and state artifact bundle', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'ui-smoke-harness-'));
  const screenshots = [];
  const accessibilityTree = { role: 'WebArea', name: 'Current PR dashboard', children: [{ role: 'heading', name: 'Runs' }] };

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
      testInfo: {
        config: { outputDir: tempDir },
        project: { name: 'webkit', outputDir: tempDir },
        title: 'viewer smoke generates named artifacts',
        file: 'test/playwright/inspect-run-viewer.spec.mjs',
      },
      sliceId: 'inspect-run-viewer',
      stateName: 'Current PR dashboard',
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
    assert.equal(stateJson.schemaVersion, 2);
    assert.equal(stateJson.artifactType, 'named-ui-state');
    assert.equal(stateJson.validationLevel, 'deterministic-smoke');
    assert.equal(stateJson.sliceId, 'inspect-run-viewer');
    assert.equal(stateJson.stateName, 'Current PR dashboard');
    assert.equal(stateJson.stateSlug, 'current-pr-dashboard');
    assert.equal(stateJson.runId, 'inspect-run-viewer-current-pr-dashboard-webkit');
    assert.equal(stateJson.projectName, 'webkit');
    assert.equal(stateJson.artifacts.screenshot.fileName, 'screenshot.png');
    assert.equal(stateJson.artifacts.screenshot.relativePath, 'screenshot.png');
    assert.equal(stateJson.artifacts.state.fileName, 'state.json');
    assert.equal(stateJson.artifacts.state.relativePath, 'state.json');
    assert.equal(stateJson.artifacts.snapshot.fileName, 'snapshot.json');
    assert.equal(stateJson.artifacts.snapshot.relativePath, 'snapshot.json');
    assert.equal(stateJson.metadata.fixture, 'makeInspectionSnapshot');
    assert.equal(stateJson.metadata.route, '/');
    assert.match(stateJson.capturedAt, /^\d{4}-\d{2}-\d{2}T/);

    assert.equal(artifact.snapshotPath, path.join(artifact.artifactDir, 'snapshot.json'));
    const snapshotJson = JSON.parse(await readFile(artifact.snapshotPath, 'utf8'));
    assert.deepEqual(snapshotJson, accessibilityTree);
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
        accessibility: { async snapshot() { return null; } },
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
        accessibility: { async snapshot() { return null; } },
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

test('captureNamedUiState fails closed when the accessibility API is unavailable', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'ui-smoke-harness-no-a11y-'));

  try {
    // A page with NO accessibility API is an environment failure, not an empty
    // tree: it must fail closed rather than emit an ambiguous JSON null that
    // can't be told apart from a genuinely empty accessible tree.
    await assert.rejects(
      captureNamedUiState({
        page: { async screenshot() {} },
        outputDir: tempDir,
        sliceId: 'inspect-run-viewer',
        stateName: 'No accessibility API',
      }),
      /accessibility\.snapshot\(\) is unavailable/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
