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

  // Semantic snapshot: the accessibility tree next to the pixels. Captured
  // best-effort — Playwright's `page.accessibility` is a deprecated API that is
  // genuinely unavailable in some deployed browser builds, so the optional chain
  // (and the try/catch around a present-but-throwing `snapshot()`) is intentional:
  // failing here would break real smokes. A working API that returns null for a
  // page with no accessible tree is a valid tree; either way a deterministic JSON
  // null is emitted rather than skipped.
  let accessibilityTree = null;
  try {
    accessibilityTree = (await page.accessibility?.snapshot?.()) ?? null;
  } catch {
    accessibilityTree = null;
  }
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
