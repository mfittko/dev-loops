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
    axePath: path.join(artifactDir, 'axe.json'),
    consolePath: path.join(artifactDir, 'console.json'),
  };
}

// Run axe-core against the live page via @axe-core/playwright, best-effort.
// The import is dynamic (and try/catch-wrapped) on purpose: axe only runs
// against a real Playwright page, so mock-page smokes/tests and browser builds
// where axe can't load degrade to a deterministic JSON null rather than throwing
// — mirroring the snapshot.json best-effort policy. Real UI smokes install
// @axe-core/playwright and get populated results.
async function defaultRunAxe(page) {
  try {
    const { default: AxeBuilder } = await import('@axe-core/playwright');
    return (await new AxeBuilder({ page }).analyze()) ?? null;
  } catch {
    return null;
  }
}

// Per-state console errors + failed network requests. Best-effort, and by
// default a no-op that degrades to JSON null: this harness captures NO events on
// its own — the drive owns the single walk-level listener buffer and injects a
// `captureConsole` seam that SLICES its per-state window (without clearing the
// buffer, so the same events still drive the drive's walk-level fail-closed
// gate). A plain smoke or a mock-page test with no seam emits a deterministic
// JSON null, mirroring the snapshot/axe best-effort policy.
function defaultCaptureConsole() {
  return null;
}

export async function captureNamedUiState({ page, testInfo, sliceId, stateName, metadata = {}, fullPage = true, outputDir, runAxe = defaultRunAxe, captureConsole = defaultCaptureConsole } = {}) {
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

  // Computed a11y facts: axe-core results next to the pixels/tree. Best-effort
  // for the same reason as the snapshot (see defaultRunAxe); either way a
  // deterministic JSON payload (raw axe results, or null) is emitted, never skipped.
  let axeResults = null;
  try {
    axeResults = (await runAxe(page)) ?? null;
  } catch {
    axeResults = null;
  }
  await writeFile(paths.axePath, `${JSON.stringify(axeResults, null, 2)}\n`, 'utf8');

  // Per-state console/network errors: the drive's `captureConsole` seam slices
  // the window of walk-level events attributed to this state. Best-effort for the
  // same reason as snapshot/axe (see defaultCaptureConsole); either way a
  // deterministic JSON payload (a {consoleErrors,failedRequests} report, or null
  // when nothing was captured) is emitted last — after the pixels/tree/axe — so
  // slicing events can never pollute the earlier artifacts.
  let consoleReport = null;
  try {
    consoleReport = (await captureConsole(page)) ?? null;
  } catch {
    consoleReport = null;
  }
  await writeFile(paths.consolePath, `${JSON.stringify(consoleReport, null, 2)}\n`, 'utf8');

  const normalizedMetadata = {
    ...metadata,
    fixture: metadata.fixture ?? null,
    route: metadata.route ?? null,
    reviewHint: metadata.reviewHint ?? null,
  };

  const stateArtifact = {
    schemaVersion: 4,
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
      axe: {
        fileName: path.basename(paths.axePath),
        relativePath: path.basename(paths.axePath),
        path: paths.axePath,
      },
      console: {
        fileName: path.basename(paths.consolePath),
        relativePath: path.basename(paths.consolePath),
        path: paths.consolePath,
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
