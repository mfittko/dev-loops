import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import {
  parseDiffAnchors,
  parseException,
  extractFrames,
  diagnoseFailures,
  rankFindings,
  isInRepoFrame,
  topInRepoFrame,
} from "@dev-loops/core/loop/ui-review-diagnose";
import { parseUiReviewDiagnoseCliArgs, LOOP_INFO_SCRIPT } from "../../scripts/loop/ui-review-diagnose.mjs";

// A synthetic PR diff over two changed files. Added (RIGHT-side) head lines:
//   app/models/user.rb  -> {11, 12, 14}   (line 13 is an unchanged context line)
//   app/assets/widget.js -> {2, 3, 5}     (lines 1, 4 are context)
const DIFF = `diff --git a/app/models/user.rb b/app/models/user.rb
index 1111111..2222222 100644
--- a/app/models/user.rb
+++ b/app/models/user.rb
@@ -10,3 +10,5 @@ class User
   def name
+    raise NoMethodError
+    do_thing
   end
+  attr_reader :x
diff --git a/app/assets/widget.js b/app/assets/widget.js
index 3333333..4444444 100644
--- a/app/assets/widget.js
+++ b/app/assets/widget.js
@@ -1,2 +1,4 @@
 const x = 1;
+function boom() {
+  throw new TypeError("bad");
 }
+export default boom;
`;

// ── unified-diff hunk parsing (added lines only, RIGHT side) ────────────────

test("parseDiffAnchors: maps each changed file to its added head lines (RIGHT side)", () => {
  const anchors = parseDiffAnchors(DIFF);
  assert.deepEqual([...anchors.get("app/models/user.rb")].sort((a, b) => a - b), [11, 12, 14]);
  assert.deepEqual([...anchors.get("app/assets/widget.js")].sort((a, b) => a - b), [2, 3, 5]);
  // The unchanged context lines are NOT anchor targets.
  assert.ok(!anchors.get("app/models/user.rb").has(13));
  assert.ok(!anchors.get("app/assets/widget.js").has(1));
});

test("parseDiffAnchors: hunk content that renders as +++/--- is not misread as a file header", () => {
  // A deleted line whose content is `-- x` renders `--- x`; an added line whose
  // content is `++ x` renders `+++ x`. Both must be treated as hunk content, so
  // the deletion does not drop the rest of the hunk and the added `++`/later
  // added lines still anchor to the correct path and head line numbers.
  const diff = `diff --git a/app/x.rb b/app/x.rb
--- a/app/x.rb
+++ b/app/x.rb
@@ -1,4 +1,5 @@
 line1
--- deleted comment
+++ added marker
 line3
+real_added
`;
  const anchors = parseDiffAnchors(diff);
  // Added head lines: `++ added marker` at 2, `real_added` at 4. The deletion
  // (present only on the old side) does not advance the head counter.
  assert.deepEqual([...anchors.get("app/x.rb")].sort((a, b) => a - b), [2, 4]);
});

// ── exception + frame parsing ───────────────────────────────────────────────

test("parseException: extracts the type and message from a JS stack and a Ruby traceback", () => {
  assert.deepEqual(parseException("TypeError: cannot read x\n    at boom (a.js:1:1)"), {
    type: "TypeError",
    message: "cannot read x",
  });
  assert.deepEqual(parseException("NoMethodError (undefined method `foo' for nil):").type, "NoMethodError");
  assert.deepEqual(parseException("nothing here"), { type: null, message: null });
});

test("extractFrames: parses JS, Ruby, and Python frames in order", () => {
  const frames = extractFrames(
    `    at boom (/repo/app/assets/widget.js:3:9)\napp/models/user.rb:11:in 'save'\n  File "svc/job.py", line 7, in run`,
  );
  assert.deepEqual(frames, [
    { file: "/repo/app/assets/widget.js", line: 3 },
    { file: "app/models/user.rb", line: 11 },
    { file: "svc/job.py", line: 7 },
  ]);
});

test("extractFrames: a served-URL frame is captured whole (scheme+host:port), not port-glued garbage", () => {
  // A browser page-error stack frame is a served URL. The host:port must not
  // break the file capture — the whole URL is captured so normalizeFrameFile
  // can strip the scheme/authority and suffix-match the repo-relative diff path.
  assert.deepEqual(extractFrames("    at boom (http://localhost:3000/app/assets/widget.js:3:9)"), [
    { file: "http://localhost:3000/app/assets/widget.js", line: 3 },
  ]);
});

test("isInRepoFrame/topInRepoFrame: a non-node_modules vendor top frame (gems) is skipped", () => {
  assert.equal(isInRepoFrame("/usr/local/gems/rails/lib/foo.rb"), false);
  const frames = [
    { file: "/usr/local/gems/rails/lib/foo.rb", line: 9 },
    { file: "app/models/user.rb", line: 11 },
  ];
  assert.deepEqual(topInRepoFrame(frames), { file: "app/models/user.rb", line: 11 });
});

// ── the AC test: source -> diff-line anchoring, incl. the non-anchorable path ─

test("diagnoseFailures: anchors in-repo frames to changed diff lines and retains non-anchorable failures", () => {
  const captures = [
    { flow: "account", step: "save", screenshotPath: "/out/account-save.png", statePath: "/out/account-save.json" },
  ];
  const failures = [
    // (1) page-error: the top frame is in node_modules (skipped); the next
    //     in-repo frame lands on an added line -> anchorable.
    {
      kind: "page-error",
      severity: "must-fix",
      message: "uncaught page error: cannot read properties of undefined",
      stack:
        "TypeError: cannot read properties of undefined\n    at dep (/repo/node_modules/lib/index.js:5:1)\n    at boom (/repo/app/assets/widget.js:3:9)",
    },
    // (2) server-log exception: a Ruby traceback whose top in-repo frame is on
    //     an added line -> anchorable, with the exception type parsed.
    {
      kind: "server-log-exception",
      severity: "must-fix",
      message: "server log exception: NoMethodError (undefined method `foo')",
      context:
        "Started POST \"/users\"\nNoMethodError (undefined method `foo' for nil):\napp/models/user.rb:11:in `save'\napp/controllers/users_controller.rb:5:in `create'",
    },
    // (3) server-log exception on an UNCHANGED context line (13) of a changed
    //     file -> retained, non-anchorable (line not on a changed diff line).
    {
      kind: "server-log-exception",
      severity: "must-fix",
      message: "server log exception: RuntimeError",
      context: "RuntimeError (boom):\napp/models/user.rb:13:in `name'",
    },
    // (4) page-error whose source file is NOT among the changed files ->
    //     retained, non-anchorable (file not changed).
    {
      kind: "page-error",
      severity: "must-fix",
      message: "uncaught page error: oops",
      stack: "Error: oops\n    at x (/repo/app/other.js:1:1)",
    },
    // (5) error-response: no source location at all -> retained, non-anchorable.
    { kind: "error-response", severity: "must-fix", status: 500, url: "http://app/save", message: "error response 500 at http://app/save" },
  ];

  const { ok, findings, counts } = diagnoseFailures({ failures, captures, diffOutput: DIFF });

  assert.equal(ok, false, "failures present => not clean");
  assert.equal(counts.total, 5);
  assert.equal(counts.anchorable, 2);
  assert.equal(counts.nonAnchorable, 3);

  // Deterministic ranking: must-fix, then anchorable-first, then kind, then file:line.
  assert.deepEqual(findings.map((f) => f.anchorable), [true, true, false, false, false]);

  // (1) anchorable page-error -> widget.js:3 on the RIGHT side.
  assert.equal(findings[0].kind, "page-error");
  assert.equal(findings[0].exception.type, "TypeError");
  assert.deepEqual(findings[0].source, { file: "/repo/app/assets/widget.js", line: 3 });
  assert.deepEqual(findings[0].anchor, { path: "app/assets/widget.js", line: 3, side: "RIGHT" });
  assert.equal(findings[0].nonAnchorableReason, null);
  // Reproduced-evidence reference points at a Stage 2 artifact.
  assert.equal(findings[0].evidence.screenshotPath, "/out/account-save.png");

  // (2) anchorable server-log -> user.rb:11, NoMethodError.
  assert.equal(findings[1].kind, "server-log-exception");
  assert.equal(findings[1].exception.type, "NoMethodError");
  assert.deepEqual(findings[1].anchor, { path: "app/models/user.rb", line: 11, side: "RIGHT" });

  // (5) no-source failure sorts first among non-anchorable (kind order), reason stated.
  assert.equal(findings[2].kind, "error-response");
  assert.equal(findings[2].anchorable, false);
  assert.equal(findings[2].anchor, null);
  assert.match(findings[2].nonAnchorableReason, /no source location/i);

  // (4) file-not-changed reason.
  assert.equal(findings[3].kind, "page-error");
  assert.match(findings[3].nonAnchorableReason, /not among the PR's changed files/i);

  // (3) line-not-changed reason (unchanged context line of a changed file).
  assert.equal(findings[4].kind, "server-log-exception");
  assert.match(findings[4].nonAnchorableReason, /not on a changed diff line/i);
});

test("diagnoseFailures: an ambiguous suffix match is flagged non-anchorable, never guessed", () => {
  // Two changed files whose paths are both suffixes of the frame path.
  const diff = `diff --git a/lib/util.rb b/lib/util.rb
--- a/lib/util.rb
+++ b/lib/util.rb
@@ -1,1 +1,2 @@
 x = 1
+y = 2
diff --git a/util.rb b/util.rb
--- a/util.rb
+++ b/util.rb
@@ -1,1 +1,2 @@
 a = 1
+b = 2
`;
  const failures = [
    { kind: "page-error", severity: "must-fix", message: "x", stack: "Error: x\n    at f (/srv/lib/util.rb:2:1)" },
  ];
  const { findings } = diagnoseFailures({ failures, diffOutput: diff });
  assert.equal(findings[0].anchorable, false);
  assert.match(findings[0].nonAnchorableReason, /ambiguous/i);
});

test("diagnoseFailures: a page-error whose frame is a served URL anchors to the repo-relative diff path", () => {
  const diff = `diff --git a/app/assets/widget.js b/app/assets/widget.js
--- a/app/assets/widget.js
+++ b/app/assets/widget.js
@@ -1,2 +1,4 @@
 const x = 1;
+function boom() {
+  throw new TypeError("bad");
 }
`;
  const failures = [
    {
      kind: "page-error",
      severity: "must-fix",
      message: "uncaught page error",
      // Browser page-error stack frame served over http with a host:port.
      stack: "TypeError: bad\n    at boom (http://localhost:3000/app/assets/widget.js:3:9)",
    },
  ];
  const { findings } = diagnoseFailures({ failures, diffOutput: diff });
  // The whole served URL is retained as the source; the scheme/authority is
  // stripped only for matching, so the anchor lands on the repo-relative path.
  assert.equal(findings[0].source.file, "http://localhost:3000/app/assets/widget.js");
  assert.deepEqual(findings[0].anchor, { path: "app/assets/widget.js", line: 3, side: "RIGHT" });
  assert.equal(findings[0].anchorable, true);
});

test("rankFindings: is stable and deterministic across input order", () => {
  const a = { severity: "note", anchorable: false, kind: "z", source: { file: "b", line: 2 } };
  const b = { severity: "must-fix", anchorable: false, kind: "a", source: { file: "a", line: 1 } };
  const c = { severity: "must-fix", anchorable: true, kind: "a", source: { file: "a", line: 1 } };
  assert.deepEqual(rankFindings([a, b, c]), rankFindings([c, a, b]));
  // must-fix + anchorable ranks first, note ranks last.
  assert.equal(rankFindings([a, b, c])[0], c);
  assert.equal(rankFindings([a, b, c])[2], a);
});

// ── CLI parsing ─────────────────────────────────────────────────────────────

test("parseUiReviewDiagnoseCliArgs: requires --pr and --drive-result", () => {
  assert.throws(() => parseUiReviewDiagnoseCliArgs(["--drive-result", "/r.json"]), /pr/);
  assert.throws(() => parseUiReviewDiagnoseCliArgs(["--pr", "7"]), /drive-result/);
  const o = parseUiReviewDiagnoseCliArgs(["--pr", "7", "--drive-result", "/r.json", "--repo", "o/n"]);
  assert.equal(o.pr, 7);
  assert.equal(o.driveResult, "/r.json");
  assert.equal(o.repo, "o/n");
});

test("LOOP_INFO_SCRIPT resolves to the real sibling loop-info script (the CLI non-help path)", () => {
  // The CLI's non-help path shells out to this script via execFileSync; a wrong
  // path throws ENOENT the moment `loop info` is reused. Assert it exists.
  assert.ok(LOOP_INFO_SCRIPT.endsWith("scripts/loop/info.mjs"), LOOP_INFO_SCRIPT);
  assert.ok(existsSync(LOOP_INFO_SCRIPT), `loop-info script must exist at ${LOOP_INFO_SCRIPT}`);
});
