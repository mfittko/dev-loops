/**
 * Diagnose + anchor for the ui_review route (Stage 3).
 *
 * Consumes the structured captured-failures feed from the drive stage and maps
 * each failure — exception + JS stack or server-log traceback context — to a
 * source location (the top in-repo stack frame), then to a diff line on the PR
 * head so the poster stage can anchor an inline comment on a real changed line.
 *
 * This module is PURE: the diff text and the drive result are inputs, the
 * in-repo-frame predicate is an injectable seam. The thin CLI wires the real IO
 * (loop info for PR state + the PR diff fetch).
 *
 * Contract: a failure is NEVER silently dropped. One that has no source
 * location, whose file is not in the diff, whose line is not on a changed diff
 * line, or whose file maps ambiguously to more than one changed file, is
 * RETAINED as a finding flagged non-anchorable (with a stated reason) so the
 * poster body-attaches it instead of inlining.
 *
 * Out of scope (later stages): review posting, artifact publishing, auto-fixing.
 */

const RIGHT = "RIGHT";

/** Severity ordering for the ranked findings list. Unknown severities sort last
 * but before nothing — a finding is never dropped for an unrecognized severity. */
const SEVERITY_RANK = Object.freeze({ "must-fix": 0, note: 1 });
const severityRank = (s) => (s in SEVERITY_RANK ? SEVERITY_RANK[s] : 2);

/** Frames whose file matches a vendor/framework/runtime marker are NOT in-repo:
 * the diagnosis anchors the change's own code, not a dependency's internals. The
 * default is deliberately conservative — a project with an unusual layout injects
 * its own predicate rather than loosening this shared default. */
const VENDOR_FRAME = /node_modules|[/\\]gems[/\\]|[/\\]vendor[/\\]|\bwebpack:\/\/|^node:|[/\\]ruby[/\\]|[/\\]dist-packages[/\\]/u;

/** Default in-repo predicate: a non-empty file path that is not a vendor frame. */
export function isInRepoFrame(file) {
  return typeof file === "string" && file.length > 0 && !VENDOR_FRAME.test(file);
}

/** Extract the exception type + message from stack/traceback text. Matches the
 * first exception token and the text that follows it: a `SomethingError`/
 * `SomethingException`-suffixed name (JS `TypeError: msg`, Ruby `NoMethodError
 * (msg)`, Python/dotted `django.core.exceptions.ValidationError: msg`) OR a Ruby
 * `::`-namespaced constant like `ActiveRecord::RecordNotFound` /
 * `Mongoid::Errors::DocumentNotFound`, captured whole. The `::` alternative
 * requires at least one namespace segment so it signals a class, not an
 * arbitrary identifier. Returns nulls when no recognizable exception name is
 * present. */
export function parseException(text = "") {
  const m = String(text).match(/([A-Z]\w*(?:::[A-Z]\w*)+|[A-Za-z_][\w.]*(?:Error|Exception))\b[:\s(]*([^\n)]*)/u);
  if (!m) return { type: null, message: null };
  const message = m[2].trim();
  return { type: m[1], message: message.length > 0 ? message : null };
}

/** Parse a single stack/traceback line into `{file, line}` or null. Tries the
 * three shapes the drive feed can carry: Python `File "path", line N`, JS
 * `at ... (file:line:col)`, then a generic `path.ext:line` (Ruby, and JS frames
 * without an `at` prefix). */
function extractFrameFromLine(line) {
  let m = line.match(/File "([^"]+)", line (\d+)/u);
  if (m) return { file: m[1], line: Number(m[2]) };
  // The file capture excludes only whitespace/parens (not `:`) and is lazy, so a
  // served URL (`http://host:3000/assets/x.js`) is captured whole up to the
  // trailing `:line:col` — normalizeFrameFile then strips the scheme/authority.
  m = line.match(/\bat\s+(?:.*\()?([^\s()]+?):(\d+)(?::\d+)?\)?\s*$/u);
  if (m) return { file: m[1], line: Number(m[2]) };
  m = line.match(/([^\s():]+\.[A-Za-z0-9_]+):(\d+)\b/u);
  if (m) return { file: m[1], line: Number(m[2]) };
  return null;
}

/** Extract all frames from multi-line stack/traceback text, preserving order. */
export function extractFrames(text = "") {
  const frames = [];
  for (const line of String(text).split("\n")) {
    const frame = extractFrameFromLine(line);
    if (frame) frames.push(frame);
  }
  return frames;
}

/** The top in-repo frame drives the anchor: the first frame (topmost, closest to
 * the throw) whose file passes the in-repo predicate. We do NOT search deeper for
 * a frame that happens to be in the diff — anchoring a lower frame would point at
 * a caller, not the failing line. A deeper frame that is in-repo but not in the
 * diff is handled downstream as non-anchorable, never by guessing past the top. */
export function topInRepoFrame(frames, inRepo = isInRepoFrame) {
  return frames.find((f) => inRepo(f.file)) ?? null;
}

/**
 * Parse a unified diff into a map of changed file -> set of ADDED head line
 * numbers (the RIGHT side). EVERY changed file is a key (registered from its
 * `diff --git`/`+++ ` header) so a file that is changed but adds no anchorable
 * line (deletion-only, binary, or mode-only) still reports as changed with an
 * empty set — distinct from a file the PR never touched. Only added (`+`) lines
 * are anchor targets: an inline comment on an added line points at code the PR
 * introduced. Unchanged context lines advance the head counter but are not
 * anchor targets — a defect on an unchanged line is body-attached, not falsely
 * pinned to "changed" code.
 *
 * @param {string} diffOutput - raw `gh pr diff` / `git diff` unified output.
 * @returns {Map<string, Set<number>>}
 */
export function parseDiffAnchors(diffOutput = "") {
  const map = new Map();
  const register = (p) => {
    if (p !== null && !map.has(p)) map.set(p, new Set());
  };
  let currentPath = null;
  let newLine = 0;
  let inHunk = false;
  for (const line of String(diffOutput).split("\n")) {
    if (line.startsWith("diff --git")) {
      // The only hunk terminator: a bare `diff --git` can never be hunk content
      // (content lines always carry a `+`/`-`/space prefix), so it always resets.
      currentPath = null;
      inHunk = false;
      // Register the RIGHT-side path so binary/mode-only changes (which carry no
      // `+++ ` header) still count as changed files.
      const m = line.match(/^diff --git a\/.+ b\/(.+)$/u);
      if (m) register(m[1]);
      continue;
    }
    // File headers appear only before the first hunk. Inside a hunk a line
    // beginning `+++ `/`--- ` is content (an added `++ x` / a deleted `-- x`),
    // so it must fall through to the `+`/`-` content handling below, not be
    // misread as a header that rebinds the path or drops the rest of the hunk.
    if (!inHunk && line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      currentPath = p === "/dev/null" ? null : p.replace(/^b\//u, "");
      // Register even deletion-only files (they keep a `+++ b/path` header but
      // add no line) so they report as changed rather than not-among-changed.
      register(currentPath);
      continue;
    }
    if (!inHunk && line.startsWith("--- ")) {
      continue;
    }
    if (line.startsWith("@@")) {
      const m = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u);
      newLine = m ? Number(m[1]) : 0;
      inHunk = Boolean(m);
      continue;
    }
    if (!inHunk || currentPath === null) continue;
    if (line.startsWith("+")) {
      if (!map.has(currentPath)) map.set(currentPath, new Set());
      map.get(currentPath).add(newLine);
      newLine += 1;
    } else if (line.startsWith("-")) {
      // Deleted line: present only on the old side, so it does not advance the head counter.
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file": a marker, not a content line.
    } else {
      // Context line: on both sides, so it advances the head counter but is not an anchor target.
      newLine += 1;
    }
  }
  return map;
}

/** Normalize a stack-frame file to a repo-relative-comparable form: strip a URL
 * scheme+authority (`http://host/assets/x.js` -> `/assets/x.js`) and any
 * query/hash, then fold Windows `\` separators to `/`, so an absolute, served,
 * or Windows-style path can be suffix-matched to a (forward-slash) diff path. */
function normalizeFrameFile(file) {
  let s = String(file);
  const scheme = s.match(/^[a-z][a-z0-9+.\-]*:\/\/[^/]*(\/.*)$/iu);
  if (scheme) s = scheme[1];
  return s.split(/[?#]/u)[0].replace(/\\/gu, "/");
}

/** The source-file -> changed-file mapping is the fragile axis (bundlers, moved
 * code, served paths). Match a frame file to a diff path by exact match or path
 * suffix. Return every match so an ambiguous mapping (more than one changed file
 * is a suffix of the frame path) is flagged rather than guessed. */
function matchDiffPaths(frameFile, anchorPaths) {
  const nf = normalizeFrameFile(frameFile);
  return anchorPaths.filter((p) => nf === p || nf.endsWith(`/${p}`));
}

/**
 * Map one Stage-2 failure to a finding: parse its exception + source location,
 * resolve an anchor on the diff, or retain it flagged non-anchorable.
 *
 * @param {object} failure - a `classifyFailures` entry `{kind, severity, message, ...}`.
 * @param {Map<string,Set<number>>} anchorsByPath
 * @param {(file:string)=>boolean} inRepo
 * @param {object|null} evidence - the reproduced-evidence reference to attach.
 */
function diagnoseOne(failure, anchorsByPath, inRepo, evidence) {
  // page-error carries `stack`; server-log-exception carries `context`; the
  // wire-level failures (error/request) carry neither -> no source location.
  const sourceText =
    failure.kind === "page-error" ? failure.stack :
    failure.kind === "server-log-exception" ? failure.context :
    "";
  const exception = parseException(sourceText || failure.message || "");
  const finding = {
    severity: failure.severity ?? null,
    kind: failure.kind,
    message: failure.message ?? null,
    exception,
    source: null,
    anchor: null,
    anchorable: false,
    nonAnchorableReason: null,
    evidence,
  };

  const frame = topInRepoFrame(extractFrames(sourceText || ""), inRepo);
  if (!frame) {
    finding.nonAnchorableReason = "no source location (no in-repo stack frame in the captured failure)";
    return finding;
  }
  finding.source = frame;

  const matches = matchDiffPaths(frame.file, [...anchorsByPath.keys()]);
  if (matches.length === 0) {
    finding.nonAnchorableReason = "source file is not among the PR's changed files";
    return finding;
  }
  if (matches.length > 1) {
    finding.nonAnchorableReason = `ambiguous: source file maps to more than one changed file (${matches.join(", ")})`;
    return finding;
  }
  const path = matches[0];
  if (!anchorsByPath.get(path).has(frame.line)) {
    finding.nonAnchorableReason = "source line is not on an added diff line";
    return finding;
  }
  finding.anchor = { path, line: frame.line, side: RIGHT };
  finding.anchorable = true;
  return finding;
}

/**
 * Rank findings deterministically — no wall-clock, no input-order dependence.
 * Order: severity (must-fix first), then anchorable-first (the poster can inline
 * these), then kind, then source file, then source line. Every key is a total
 * order over the data so the result is stable for a given input set.
 */
export function rankFindings(findings) {
  const key = (f) => [
    severityRank(f.severity),
    f.anchorable ? 0 : 1,
    f.kind ?? "",
    f.source?.file ?? "",
    f.source?.line ?? 0,
  ];
  return [...findings].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i += 1) {
      if (ka[i] < kb[i]) return -1;
      if (ka[i] > kb[i]) return 1;
    }
    return 0;
  });
}

/**
 * Diagnose the drive stage's captured failures into a ranked findings list with
 * diff-line anchors or explicit non-anchorable flags plus reproduced-evidence
 * references. Pure; inject `isInRepoFrame` to override the in-repo heuristic.
 *
 * @param {object} input
 * @param {object[]} [input.failures] - the drive stage's `failures`.
 * @param {object[]} [input.captures] - the drive stage's `captures` (evidence).
 * @param {string} [input.diffOutput] - the PR's unified diff.
 * @param {object} [seams]
 * @param {(file:string)=>boolean} [seams.isInRepoFrame]
 * @returns {{ok:boolean, findings:object[], counts:{total:number,anchorable:number,nonAnchorable:number}}}
 */
export function diagnoseFailures(
  { failures = [], captures = [], diffOutput = "" } = {},
  { isInRepoFrame: inRepo = isInRepoFrame } = {},
) {
  const anchorsByPath = parseDiffAnchors(diffOutput);
  // ponytail: one reproduced-evidence reference per finding — the drive's final
  // captured state (the last screenshot/state pair). Per-step attribution would
  // need brittle parsing of the step-failure message; wire flow/step through the
  // drive feed first if a stage needs frame-accurate evidence.
  const last = captures.length > 0 ? captures[captures.length - 1] : null;
  const evidence = last
    ? { flow: last.flow ?? null, step: last.step ?? null, screenshotPath: last.screenshotPath ?? null, statePath: last.statePath ?? null }
    : null;

  const findings = rankFindings(failures.map((f) => diagnoseOne(f, anchorsByPath, inRepo, evidence)));
  const anchorable = findings.filter((f) => f.anchorable).length;
  return {
    ok: findings.length === 0,
    findings,
    counts: { total: findings.length, anchorable, nonAnchorable: findings.length - anchorable },
  };
}
