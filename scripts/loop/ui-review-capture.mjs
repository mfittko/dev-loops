/**
 * Browser-adapter layer for the UI-review stages: named-state artifact capture
 * and the guarded Playwright load.
 *
 * This lives under `scripts/loop/` (shipped) rather than `test/` (not shipped)
 * because `ui-review-drive.mjs` and `visual-grill-capture.mjs` depend on it at
 * runtime — a shipped entrypoint must never import from the test tree. The
 * Playwright test suite reaches the capture seams through
 * `test/playwright/harness/webkit-smoke-harness.mjs`, which re-exports them
 * alongside its own fixture-server helpers; the stage-envelope helpers
 * (`toStopReason`, `STOP_REASON_MAX_CHARS`) are imported from here directly.
 */
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

// Playwright is an OPTIONAL peer dependency: a consumer who never runs a UI
// review should not carry the download. So the browser-driving stages load it
// here, dynamically, and get a stated install instruction instead of a raw
// module-resolution stack trace. Same shape as defaultRunAxe's optional
// @axe-core/playwright load below.
// Single line, and well inside the stop-reason cap below, so the commands
// survive into every fail-closed envelope that reports them.
export const PLAYWRIGHT_MISSING_MESSAGE =
  "UI review needs Playwright (an optional peer dependency): run `npm install --save-dev @playwright/test`, then `npx playwright install webkit`";

// Launching WebKit needs BOTH the package and the downloaded browser binary, and
// they fail at different moments — a missing package throws at import, a missing
// binary throws at launch. Owning both here keeps each call site a single call,
// and lets the binary case name `webkit` specifically: Playwright's own message
// says `npx playwright install`, which downloads every browser when only WebKit
// is ever launched.
export const WEBKIT_MISSING_MESSAGE =
  "UI review needs the Playwright WebKit browser: run `npx playwright install webkit`";

export const STOP_REASON_MAX_CHARS = 300;

/**
 * Shape any error into ONE bounded stop-reason line.
 *
 * Collapses rather than taking the first line: Playwright's missing-host-
 * libraries error puts its remedy (`npx playwright install-deps`) on a later
 * line, and first-line-only would hand the operator a problem with no fix. The
 * cap keeps a pathological error from bloating a stage's stdout envelope.
 */
export function toStopReason(err) {
  // Total by construction: this runs inside handlers that owe the caller a
  // structured envelope, so a thrown non-Error must not crash the formatter.
  const detail = String(err?.message ?? err);
  // Keyed on the wrapper's own identity, not on the cause's wording: matching
  // "playwright install" as a substring would also swallow the host-deps remedy
  // (`playwright install-deps`), which is precisely what launchWebkit preserves.
  const cause = err?.cause?.message;
  const combined = cause && detail !== WEBKIT_MISSING_MESSAGE ? `${detail} (${cause})` : detail;

  // Keep the headline plus any remedy lines, rather than every line: Playwright
  // puts remedies on later lines (so first-line-only would drop the fix), but a
  // browser-walk failure's `Call log:` carries selectors and element markup from
  // the app under test, which has no business in a stage envelope.
  const [headline = "", ...rest] = combined.split("\n").map((line) => line.trim()).filter(Boolean);
  const remedies = rest.filter((line) => /\b(npx|sudo|npm install|yarn|pnpm)\b/i.test(line));
  return [headline, ...remedies].join(" ").slice(0, STOP_REASON_MAX_CHARS);
}

// Only a genuine resolution failure means "not installed". An installed but
// broken package (bad native binding, a throw during module evaluation) must
// keep its own error: telling someone to install what they already have hides
// the real cause.
const MODULE_ABSENT_CODES = new Set(["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND", "ERR_PACKAGE_PATH_NOT_EXPORTED"]);

export async function launchWebkit({ headless = true } = {}, { importPlaywright = () => import("@playwright/test") } = {}) {
  let playwright;
  try {
    playwright = await importPlaywright();
  } catch (err) {
    // The code alone is not enough: a transitive dependency missing from INSIDE
    // an installed @playwright/test raises the same codes, and reporting that as
    // "not installed" hides the real cause. Require the error to name the
    // package itself before claiming it is absent.
    const names = typeof err?.message === "string" && err.message.includes("@playwright/test");
    if (!MODULE_ABSENT_CODES.has(err?.code) || !names) throw err;
    throw new Error(PLAYWRIGHT_MISSING_MESSAGE, { cause: err });
  }
  const webkit = playwright?.webkit;
  // A resolvable module with no `webkit` export is version skew or a partial
  // install; say so rather than letting `undefined.launch` surface as an opaque
  // "cannot read properties of undefined".
  if (typeof webkit?.launch !== "function") {
    throw new Error(PLAYWRIGHT_MISSING_MESSAGE);
  }
  try {
    return await webkit.launch({ headless });
  } catch (err) {
    // Match ONLY the missing-binary error. Playwright's missing-host-libraries
    // failure also contains the words "playwright install" (it instructs `npx
    // playwright install-deps`), and rewriting that one to "install webkit"
    // would hand a Linux/container consumer the wrong remedy and discard the
    // list of missing libraries — so it is left to propagate unchanged.
    if (/Executable doesn't exist/i.test(err?.message ?? String(err))) {
      throw new Error(WEBKIT_MISSING_MESSAGE, { cause: err });
    }
    throw err;
  }
}

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

// The interaction states the slug can encode. `none` is the default render state;
// the others are the stateful renders reviewers care about distinguishing.
const UI_INTERACTION_STATES = new Set(['none', 'focus', 'hover', 'error']);

// Normalize a viewport descriptor into a stable slug segment. A `{ width, height }`
// object becomes `w<width>h<height>`; a named breakpoint string is normalized like
// any other segment; an unspecified viewport defaults to `default`. A malformed
// viewport (non-positive/non-integer dimensions, or a non-object/non-string) is
// rejected — a bad descriptor must fail closed, never collapse to a silent default.
export function normalizeViewportSegment(viewport) {
  if (viewport === undefined || viewport === null) {
    return 'default';
  }
  if (typeof viewport === 'string') {
    return normalizeUiStateSegment(viewport);
  }
  if (typeof viewport === 'object') {
    const { width, height } = viewport;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new Error('UI state viewport must provide positive integer width and height');
    }
    return `w${width}h${height}`;
  }
  throw new Error('UI state viewport must be a { width, height } object or a named breakpoint string');
}

// Normalize an interaction state into a stable slug segment. Unspecified defaults to
// `none`; anything outside the known set is rejected (fail closed, not silently kept).
export function normalizeInteractionSegment(interactionState) {
  if (interactionState === undefined || interactionState === null) {
    return 'none';
  }
  const normalized = String(interactionState).trim().toLowerCase();
  if (!UI_INTERACTION_STATES.has(normalized)) {
    throw new Error(`UI state interaction must be one of ${[...UI_INTERACTION_STATES].join(', ')}`);
  }
  return normalized;
}

// Per-process registry mapping each claimed named-state artifact path to the
// stateName that claimed it. The artifact path is slice-scoped, not run-unique
// (the same sliceId re-renders to the same dir, and runId is deterministic), so a
// raw existsSync would false-positive against a prior run's on-disk leftovers.
// Scoping the guard to this process instead catches the real hazard — two
// logically distinct states in the SAME walk normalizing to one slug — and resets
// naturally on a fresh run.
// ponytail: keyed on stateName. `resolvedOutputDir` prefers
// `testInfo.project.outputDir`, which is stable per project (NOT retry-suffixed),
// so a Playwright retry in a reused worker re-captures the SAME statePath. Keying
// on the claiming stateName lets a same-state retry re-claim/overwrite, while a
// DIFFERENT state slug-colliding to that path is still rejected.
const claimedStatePaths = new Map();

function requireOutputDir(outputDir) {
  if (typeof outputDir !== 'string' || outputDir.trim().length === 0) {
    throw new Error('A deterministic outputDir is required for named UI state artifacts');
  }
  return outputDir;
}

function buildRunId({ sliceId, stateSlug, projectName }) {
  return [sliceId, stateSlug, projectName ?? 'unknown'].map((part) => normalizeUiStateSegment(part)).join('-');
}

export function buildNamedUiStateArtifactPaths({ outputDir, sliceId, stateName, viewport, interactionState }) {
  const normalizedSliceId = normalizeUiStateSegment(sliceId);
  // The slug bakes viewport + interaction into the directory so a mobile vs desktop
  // render, or a default vs error state, are distinct reviewable dirs that never
  // collide/overwrite. Each part is normalized independently, then joined with `-`.
  const viewportSlug = normalizeViewportSegment(viewport);
  const interactionSlug = normalizeInteractionSegment(interactionState);
  const stateSlug = `${normalizeUiStateSegment(stateName)}-${viewportSlug}-${interactionSlug}`;
  const artifactDir = path.join(requireOutputDir(outputDir), 'named-states', stateSlug);

  return {
    sliceId: normalizedSliceId,
    stateSlug,
    viewport: viewportSlug,
    interactionState: interactionSlug,
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

export async function captureNamedUiState({ page, testInfo, sliceId, stateName, viewport, interactionState, metadata = {}, fullPage = true, outputDir, runAxe = defaultRunAxe, captureConsole = defaultCaptureConsole } = {}) {
  const resolvedOutputDir = outputDir ?? testInfo?.project?.outputDir ?? testInfo?.config?.outputDir ?? testInfo?.outputDir;
  const paths = buildNamedUiStateArtifactPaths({
    outputDir: resolvedOutputDir,
    sliceId,
    stateName,
    viewport,
    interactionState,
  });
  const projectName = testInfo?.project?.name ?? null;

  // Fail-closed capture-time collision guard: if a DIFFERENT state already claimed
  // these on-disk artifacts in this run, throw before writing anything so the
  // second colliding slug can never silently overwrite the first. A re-capture by
  // the SAME stateName (a Playwright retry hitting the same statePath) is a
  // legitimate overwrite and is allowed. The bundle validator's
  // blocked_duplicate_state_slug seam is defense-in-depth after this.
  const claimedBy = claimedStatePaths.get(paths.statePath);
  if (claimedBy !== undefined && claimedBy !== stateName) {
    throw new Error(`Duplicate named UI state slug "${paths.stateSlug}" for slice "${paths.sliceId}": a second state resolves to ${paths.statePath} and would overwrite the first. Give it a distinct state name, viewport, or interaction state.`);
  }
  claimedStatePaths.set(paths.statePath, stateName);

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
    schemaVersion: 5,
    artifactType: 'named-ui-state',
    validationLevel: 'deterministic-smoke',
    sliceId: paths.sliceId,
    stateName,
    stateSlug: paths.stateSlug,
    viewport: paths.viewport,
    interactionState: paths.interactionState,
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
