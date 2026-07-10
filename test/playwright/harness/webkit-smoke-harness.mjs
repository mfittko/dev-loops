import { once } from 'node:events';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

export function normalizeUiStateSegment(value) {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .replace(/-{2,}/gu, '-');

  if (normalized.length === 0) {
    throw new Error('UI state segment must contain at least one alphanumeric character');
  }

  return normalized;
}

function requireOutputDir(outputDir) {
  if (typeof outputDir !== 'string' || outputDir.trim().length === 0) {
    throw new Error('A deterministic outputDir is required for named UI state artifacts');
  }
  return outputDir;
}

function buildRunId({ sliceId, stateSlug, projectName }) {
  return [sliceId, stateSlug, projectName ?? 'unknown'].map((part) => normalizeUiStateSegment(part)).join('-');
}

export function buildNamedUiStateArtifactPaths({ outputDir, sliceId, stateName }) {
  const normalizedSliceId = normalizeUiStateSegment(sliceId);
  const stateSlug = normalizeUiStateSegment(stateName);
  const artifactDir = path.join(requireOutputDir(outputDir), 'named-states', stateSlug);

  return {
    sliceId: normalizedSliceId,
    stateSlug,
    artifactDir,
    screenshotPath: path.join(artifactDir, 'screenshot.png'),
    statePath: path.join(artifactDir, 'state.json'),
    snapshotPath: path.join(artifactDir, 'snapshot.json'),
  };
}

export async function captureNamedUiState({ page, testInfo, sliceId, stateName, metadata = {}, fullPage = true, outputDir } = {}) {
  const resolvedOutputDir = outputDir ?? testInfo?.project?.outputDir ?? testInfo?.config?.outputDir ?? testInfo?.outputDir;
  const paths = buildNamedUiStateArtifactPaths({
    outputDir: resolvedOutputDir,
    sliceId,
    stateName,
  });
  const projectName = testInfo?.project?.name ?? null;

  await mkdir(paths.artifactDir, { recursive: true });
  await page.screenshot({ path: paths.screenshotPath, fullPage });

  // Semantic snapshot: the accessibility tree next to the pixels. A genuinely
  // empty page returns null from `snapshot()` — a valid tree, still emitted
  // deterministically (as JSON null) rather than skipped. But a MISSING
  // accessibility API is an environment failure, not an empty tree — fail closed
  // rather than write an ambiguous null indistinguishable from a real empty tree.
  if (typeof page.accessibility?.snapshot !== 'function') {
    throw new Error('page.accessibility.snapshot() is unavailable — cannot capture the required semantic snapshot');
  }
  const accessibilityTree = (await page.accessibility.snapshot()) ?? null;
  await writeFile(paths.snapshotPath, `${JSON.stringify(accessibilityTree, null, 2)}\n`, 'utf8');

  const normalizedMetadata = {
    ...metadata,
    fixture: metadata.fixture ?? null,
    route: metadata.route ?? null,
    reviewHint: metadata.reviewHint ?? null,
  };

  const stateArtifact = {
    schemaVersion: 2,
    artifactType: 'named-ui-state',
    validationLevel: 'deterministic-smoke',
    sliceId: paths.sliceId,
    stateName,
    stateSlug: paths.stateSlug,
    runId: buildRunId({ sliceId: paths.sliceId, stateSlug: paths.stateSlug, projectName }),
    capturedAt: new Date().toISOString(),
    projectName,
    testTitle: testInfo?.title ?? null,
    testFile: testInfo?.file ?? null,
    artifacts: {
      screenshot: {
        fileName: path.basename(paths.screenshotPath),
        relativePath: path.basename(paths.screenshotPath),
        path: paths.screenshotPath,
      },
      state: {
        fileName: path.basename(paths.statePath),
        relativePath: path.basename(paths.statePath),
        path: paths.statePath,
      },
      snapshot: {
        fileName: path.basename(paths.snapshotPath),
        relativePath: path.basename(paths.snapshotPath),
        path: paths.snapshotPath,
      },
    },
    metadata: normalizedMetadata,
  };

  await writeFile(paths.statePath, `${JSON.stringify(stateArtifact, null, 2)}\n`, 'utf8');
  return paths;
}

export async function startFixtureServer(createServer) {
  const server = await createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
  };
}

export async function stopFixtureServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
