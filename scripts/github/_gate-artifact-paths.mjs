/**
 * LEAF module: the deterministic gate-artifact PATH SCHEME, shared by the gate
 * fan-out producer (write-gate-context.mjs) and the durable findings-log writer
 * (write-gate-findings-log.mjs).
 *
 * It is a leaf on purpose. Both consumers need the same scheme
 * (`<tmpRoot>/<family>/<repo-slug>/pr-<N>/<gate>-<headSha><suffix>`), and the
 * writer resolves it while its own CLI entry's top-level `await main()` is still
 * pending. When write-gate-context.mjs imported `buildLogPath` out of the writer
 * and the writer reached back into write-gate-context.mjs through
 * `await import("./write-gate-context.mjs")`, the two formed an ESM cycle Node
 * could never settle: the event loop drained with the dynamic import
 * unresolved, and Node exited 13 ("Detected unsettled top-level await") without
 * writing the ledger — no durable ledger, no gate evidence. Importing nothing
 * but this module (and `_gate-names.mjs`) keeps both consumers on one scheme
 * with no edge between them, so that cycle cannot come back.
 *
 * Regression coverage: test/github/write-gate-findings-log-cli-provenance.test.mjs
 * spawns the writer as a CLI child under Node with --provenance (the whole
 * existing suite imports the modules, which is exactly the blind spot that let
 * the cycle ship).
 */
import path from "node:path";
import { GATE_NAMES } from "./_gate-names.mjs";

/**
 * Internal deterministic-path builder shared by every gate-artifact path
 * function in write-gate-context.mjs (buildGateContextPath, buildGateReviewsDir,
 * buildGateDiffPath, buildGateBriefingPrefixPath, buildGateBriefingScopePath,
 * buildValidationResultsPath): validates/sanitizes the repo/pr/gate/headSha
 * segments once and joins `<tmpRoot>/<dir>/<repo-slug>/pr-<N>/<gate>-<headSha><suffix>`.
 * `dir` distinguishes the "gate-context" artifact family from the
 * "gate-reviews" per-angle findings directory; `suffix` (empty for the
 * directory case) distinguishes the file extension within a family.
 *
 * @param {string} [input.dir] — top-level artifact-family directory, default "gate-context"
 * @param {string} [input.suffix] — filename suffix (extension), default ""
 */
export function buildGateArtifactPath({ repo, pr, gate, headSha, tmpRoot = "tmp", dir = "gate-context", suffix = "" }) {
  const repoSlug = repoSlugFor(repo);
  const { pr: safePr, gate: safeGate, headSha: safeSha } = validatePathSegments({ pr, gate, headSha });
  return path.join(tmpRoot, dir, repoSlug, `pr-${safePr}`, `${safeGate}-${safeSha}${suffix}`);
}

// Deterministic artifact path for a gate-review context handoff. Mirrors
// buildLogPath below. Exported for reuse by the fork fan-out reviewers so
// producer and consumer agree on the path. Param shapes: see
// buildGateArtifactPath above.
export function buildGateContextPath({ repo, pr, gate, headSha, tmpRoot = "tmp" }) {
  return buildGateArtifactPath({ repo, pr, gate, headSha, tmpRoot, suffix: ".json" });
}

// Deterministic artifact path for the durable per-round findings log. Mirrors
// buildGateContextPath's scheme in the "gate-findings" family, keyed by the
// FULL head SHA so a new head never reuses a prior head's ledger. Validates the
// repo segments here and the pr/gate/headSha segments through
// {@link assertSafeSegment}, so both builders in this leaf module reject a
// traversal sequence (a `../../..` gate, a `/`-bearing SHA) identically rather
// than interpolating it into the `gate-findings/<repo>/pr-<N>/` directory. The
// check is a bare segment-safety one (not buildGateArtifactPath's GATE_NAMES
// vocabulary + canonical-form check): this ledger also keys the pseudo-gate
// `fixer-disposition`, and its readers derive only the DIRECTORY from the
// sample path, so a safe non-hex headSha label must still resolve.
export function buildLogPath({ repo, pr, gate, headSha, tmpRoot }) {
  const parts = repo.split("/");
  if (parts.length !== 2 || parts.some(p => p.length === 0)) {
    throw new Error(`--repo must be in owner/name format, got: ${JSON.stringify(repo)}`);
  }
  for (const p of parts) {
    if (p === "." || p === ".." || /[\s\\]/.test(p)) {
      throw new Error(`--repo segment ${JSON.stringify(p)} contains unsafe characters (dots, whitespace, or backslashes)`);
    }
  }
  const repoSlug = parts.join("-");
  const safePr = assertSafeSegment("pr", pr);
  const safeGate = assertSafeSegment("gate", gate);
  const safeSha = assertSafeSegment("head-sha", headSha);
  return path.join(tmpRoot, "gate-findings", repoSlug, `pr-${safePr}`, `${safeGate}-${safeSha}.json`);
}

/**
 * Validate the non-repo path components (gate, pr, headSha) that are
 * interpolated into a filesystem path which is later `path.resolve()`d and
 * read/written. Mirrors the repo-segment safety check in {@link repoSlugFor} so
 * both path builders reject traversal sequences and odd filenames coming from
 * untrusted inputs. Returns sanitized values for interpolation.
 *
 * @param {object} input
 * @param {number|string} input.pr — must coerce to a positive integer
 * @param {string} input.gate — draft_gate | pre_approval_gate
 * @param {string} input.headSha — 7-64 char hex SHA
 * @returns {{ pr: number, gate: string, headSha: string }}
 */
export function validatePathSegments({ pr, gate, headSha }) {
  if (!GATE_NAMES.includes(gate)) {
    throw new Error(`--gate segment ${JSON.stringify(gate)} is unsafe (expected ${GATE_NAMES.join(" or ")})`);
  }
  // Require a CANONICAL positive integer: the trimmed string must be all digits
  // (`/^\d+$/`) and > 0. This mirrors the CLI's parsePrNumber rule so the path
  // builder cannot accept non-canonical numeric forms ("1e3" → 1000, "0x10" →
  // 16, "1.5") that Number() would coerce to a DIFFERENT pr-<N> segment than the
  // operator/CLI intended, breaking the deterministic producer/consumer
  // round-trip. " 9 " trims to "9" and stays valid; numbers are stringified first.
  const prStr = String(pr).trim();
  const prNum = Number(prStr);
  if (!/^\d+$/.test(prStr) || !Number.isInteger(prNum) || prNum <= 0) {
    throw new Error(`--pr segment ${JSON.stringify(pr)} is unsafe (expected a positive integer)`);
  }
  // Lowercase the validated SHA so the path segment is case-canonical regardless
  // of caller casing, matching the CLI's normalizeHeadSha. A mixed-case
  // headRefOid (e.g. ABC123) must compute the SAME filename as its lowercase
  // form (abc123) or readGateContext / the .diff lookup would miss it — a
  // determinism bug.
  const sha = String(headSha).trim().toLowerCase();
  if (!/^[0-9a-f]{7,64}$/i.test(sha)) {
    throw new Error(`--head-sha segment ${JSON.stringify(headSha)} is unsafe (expected a 7-64 character hex SHA)`);
  }
  return { pr: prNum, gate, headSha: sha };
}

// Reject a single path segment that would escape or alias the intended
// directory: an empty string, a bare `.`/`..`, or any path separator, whitespace,
// or backslash. buildLogPath applies it to its `pr`/`gate`/`headSha` segments, so
// a traversal value (`../../..`, a `/`-bearing SHA) is refused rather than
// interpolated. It is deliberately weaker than validatePathSegments' GATE_NAMES
// vocabulary + canonical-form checks because buildLogPath also keys the
// pseudo-gate `fixer-disposition` and its readers only need the directory.
function assertSafeSegment(name, value) {
  const str = typeof value === "string" ? value : String(value);
  if (str.length === 0 || str === "." || str === ".." || /[/\\\s]/.test(str)) {
    throw new Error(`--${name} segment ${JSON.stringify(value)} is unsafe (a "." or ".." path segment, or contains a separator, whitespace, or backslash)`);
  }
  return str;
}

// Validate the repo string and return its `owner-name` slug, applying the same
// safety checks (no `.`/`..` segments, no whitespace/backslashes) shared by the
// artifact and diff path builders.
export function repoSlugFor(repo) {
  const parts = String(repo).split("/");
  if (parts.length !== 2 || parts.some((p) => p.length === 0)) {
    throw new Error(`--repo must be in owner/name format, got: ${JSON.stringify(repo)}`);
  }
  for (const p of parts) {
    if (p === "." || p === ".." || /[\s\\]/.test(p)) {
      throw new Error(`--repo segment ${JSON.stringify(p)} is unsafe (a "." or ".." path segment, or contains whitespace/backslashes)`);
    }
  }
  return parts.join("-");
}
