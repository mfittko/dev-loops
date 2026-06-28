// UI e2e auto-scoping (issue #976).
//
// Deterministic, path-triggered criterion: a PR that adds or modifies a
// *rendered* HTML artifact (a presentation deck, an article page, or the
// inspect-run viewer's served page/component) MUST run the shared UI e2e
// assertions (mobile + desktop) AND have that artifact registered in the e2e
// suite (DECK_REGISTRY / VIEWER_REGISTRY). Inclusion is triggered by the
// changed-file set, never by a human annotating the PR.
//
// This module is the testable core of that criterion: classify changed paths
// → rendered-artifact set → check each is registered → fail closed if a
// rendered artifact changed with no registered/passing coverage.

// Explicit path globs for rendered artifacts. Kept conservative and explicit
// (issue #976 scope discipline): only artifacts that render to a page/component.
export const RENDERED_ARTIFACT_GLOBS = Object.freeze([
  "docs/articles/*.html",
  "docs/presentations/*.html",
]);

// The inspect-run viewer is served from a component, not a static .html file,
// so its trigger is the served-page source (matches the existing
// inspect-run-viewer-ci-changes.mjs trigger seam).
export const VIEWER_SOURCE_PATHS = Object.freeze([
  "scripts/loop/inspect-run-viewer.mjs",
]);

// Registered artifacts — mirrors DECK_REGISTRY (the `deck` filenames) and
// VIEWER_REGISTRY. ponytail: kept as an explicit list here rather than
// importing the harness (which pulls @playwright/test into core); the
// ui-e2e-scoping.test.mjs sync test fails if a registry deck is added without
// updating this list, so it can't silently drift.
export const REGISTERED_DECK_FILES = Object.freeze([
  "introducing-dev-loops.html",
  "dev-loops-deep-dive.html",
]);

export const VIEWER_ARTIFACT_ID = "inspect-run-viewer";

// CI check names that constitute the shared UI e2e coverage. The detect layer
// reads these from the statusCheckRollup to set uiE2ePassed. ponytail: a plain
// substring/name match against the rollup is enough; the gate only needs to
// know whether the suite passed for this head.
export const UI_E2E_CHECK_NAMES = Object.freeze(["viewer-smoke"]);

function normalizePath(filePath) {
  return String(filePath ?? "").trim().replace(/^\.\/+/u, "");
}

// Match a single explicit "dir/*.ext" glob (one path segment, no recursion).
function matchesGlob(normalizedPath, glob) {
  const [dir, file] = [glob.slice(0, glob.lastIndexOf("/")), glob.slice(glob.lastIndexOf("/") + 1)];
  if (!file.startsWith("*.")) return normalizedPath === glob;
  const ext = file.slice(1); // ".html"
  if (!normalizedPath.startsWith(`${dir}/`)) return false;
  const rest = normalizedPath.slice(dir.length + 1);
  return rest.length > 0 && !rest.includes("/") && rest.endsWith(ext);
}

// Classify one changed path into a rendered-artifact descriptor, or null.
// A descriptor carries the path, a stable `id` (the deck filename or the
// viewer id) and whether that id is registered in the e2e suite.
export function classifyRenderedArtifactPath(filePath) {
  const normalized = normalizePath(filePath);
  if (normalized.length === 0) return null;

  if (VIEWER_SOURCE_PATHS.includes(normalized)) {
    return { path: normalized, kind: "viewer", id: VIEWER_ARTIFACT_ID, registered: true };
  }

  for (const glob of RENDERED_ARTIFACT_GLOBS) {
    if (matchesGlob(normalized, glob)) {
      const file = normalized.slice(normalized.lastIndexOf("/") + 1);
      return {
        path: normalized,
        kind: "deck",
        id: file,
        registered: REGISTERED_DECK_FILES.includes(file),
      };
    }
  }
  return null;
}

/**
 * Deterministic UI e2e scoping check.
 *
 * @param {string[]} changedPaths - PR changed-file paths.
 * @param {{ uiE2ePassed?: boolean|null }} [coverage]
 *   uiE2ePassed: whether the shared UI e2e suite passed for this head.
 *   null/undefined means "not run / unknown" → fails closed.
 * @returns {{
 *   required: boolean,
 *   artifacts: Array<{path,kind,id,registered}>,
 *   unregistered: string[],
 *   satisfied: boolean,
 *   reason: string|null,
 * }}
 */
export function evaluateUiE2eScoping(changedPaths = [], { uiE2ePassed = null } = {}) {
  const artifacts = [];
  const seen = new Set();
  for (const p of Array.isArray(changedPaths) ? changedPaths : []) {
    const descriptor = classifyRenderedArtifactPath(p);
    if (descriptor && !seen.has(descriptor.path)) {
      seen.add(descriptor.path);
      artifacts.push(descriptor);
    }
  }

  const required = artifacts.length > 0;
  if (!required) {
    return { required: false, artifacts, unregistered: [], satisfied: true, reason: null };
  }

  // Fail closed: any touched rendered artifact that is not registered blocks
  // and names itself so the fix is unambiguous (register it in the suite).
  const unregistered = artifacts.filter((a) => !a.registered).map((a) => a.id);
  if (unregistered.length > 0) {
    return {
      required: true,
      artifacts,
      unregistered,
      satisfied: false,
      reason:
        `UI e2e coverage is required: this PR changes rendered artifact(s) ` +
        `${unregistered.join(", ")} that are not registered in the shared UI e2e suite ` +
        `(DECK_REGISTRY in test/playwright/harness/deck-fit-harness.mjs, or VIEWER_REGISTRY ` +
        `in inspect-run-viewer-harness.mjs). Register the artifact and add a spec that runs ` +
        `the mobile + desktop assertions before this gate can pass.`,
    };
  }

  // All touched artifacts are registered — coverage must have actually passed.
  if (uiE2ePassed !== true) {
    const touched = artifacts.map((a) => a.id).join(", ");
    return {
      required: true,
      artifacts,
      unregistered: [],
      satisfied: false,
      reason:
        `UI e2e coverage is required: this PR changes rendered artifact(s) ${touched}, ` +
        `but the shared UI e2e suite (mobile + desktop) has not passed for this head ` +
        `(uiE2ePassed=${String(uiE2ePassed)}). Run the UI/mobile e2e loop and let it pass ` +
        `before this gate can proceed.`,
    };
  }

  return { required: true, artifacts, unregistered: [], satisfied: true, reason: null };
}
