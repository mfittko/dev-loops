import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildCarryForwardPlan,
  main,
  parseResolveAngleCarryForwardCliArgs,
} from "../../scripts/github/resolve-angle-carry-forward.mjs";
import { buildLogPath, parseProvenanceJson } from "../../scripts/github/write-gate-findings-log.mjs";

// Scrub inherited global/system git config and any leaked GIT_DIR/GIT_WORK_TREE
// so host-side commit signing, hooks, templates, or an exported repo pointer
// cannot steer these fixtures. Same convention as the other CLI git fixtures.
const GIT_FIXTURE_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
};

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_FIXTURE_ENV });
}

// Run the CLI main() against a repoRoot and return the parsed JSON result it
// writes to stdout (default emitResult mode).
async function runMain(argv, { repoRoot }) {
  const chunks = [];
  const orig = process.stdout.write;
  process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
  try {
    await main(argv, { repoRoot });
  } finally {
    process.stdout.write = orig;
  }
  return JSON.parse(chunks.join(""));
}

// Run main() capturing stdout+stderr and the exit code, WITHOUT parsing — for the
// fail-closed paths where main writes an error and sets process.exitCode = 1.
async function runMainRaw(argv, { repoRoot }) {
  const out = [];
  const err = [];
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  const origExit = process.exitCode;
  process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { err.push(String(chunk)); return true; };
  process.exitCode = 0;
  try {
    await main(argv, { repoRoot });
    return { stdout: out.join(""), stderr: err.join(""), exitCode: process.exitCode };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    process.exitCode = origExit;
  }
}

async function makeCarryForwardRepo({ mandatoryAngles = [], perAngle, mutate }) {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "carry-forward-cli-"));
  git(repoRoot, ["init", "-q"]);
  git(repoRoot, ["config", "user.email", "test@example.com"]);
  git(repoRoot, ["config", "user.name", "Test"]);
  const angleLines = mandatoryAngles.length > 0
    ? mandatoryAngles.map((name) => `      - name: ${name}\n        mandatory: true`).join("\n")
    : "      []";
  await writeFile(
    path.join(repoRoot, ".devloops.yaml"),
    `version: 1\ngates:\n  draft:\n    angles:\n${angleLines}\n`,
    "utf8",
  );
  const base = {
    "src/foo.mjs": "export function foo() { return 1; }\n",
    "docs/guide.md": "# Guide\n",
  };
  for (const [rel, content] of Object.entries(base)) {
    const abs = path.join(repoRoot, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
  git(repoRoot, ["add", "-A"]);
  git(repoRoot, ["commit", "-q", "-m", "base"]);
  const prevHead = git(repoRoot, ["rev-parse", "HEAD"]).trim().toLowerCase();

  await mutate(repoRoot);
  git(repoRoot, ["add", "-A"]);
  git(repoRoot, ["commit", "-q", "-m", "delta"]);
  const headSha = git(repoRoot, ["rev-parse", "HEAD"]).trim().toLowerCase();

  // Prior CLEAN findings-log recorded at prevHead.
  const logPath = path.join(repoRoot, buildLogPath({ repo: "o/n", pr: 7, gate: "draft_gate", headSha: prevHead, tmpRoot: "tmp" }));
  await mkdir(path.dirname(logPath), { recursive: true });
  await writeFile(logPath, JSON.stringify({
    headSha: prevHead,
    verdict: "clean",
    provenance: { distinctReviewers: perAngle.length, perAngle },
  }), "utf8");

  return { repoRoot, prevHead, headSha };
}

const cleanLog = {
  headSha: "aaaaaaa",
  verdict: "clean",
  provenance: {
    distinctReviewers: 3,
    perAngle: [
      { angle: "correctness", reviewer: "review-a" },
      { angle: "coverage", reviewer: "review-b" },
      { angle: "docs", reviewer: "review-c" },
    ],
  },
};

test("buildCarryForwardPlan carries code angles on a doc-only delta, marks provenance honestly", () => {
  const plan = buildCarryForwardPlan({ log: cleanLog, changedFiles: ["docs/guide.md"] });
  assert.equal(plan.prevHead, "aaaaaaa");
  const carriedAngles = plan.carried.map((c) => c.angle).sort();
  assert.deepEqual(carriedAngles, ["correctness", "coverage"]);
  // Carried verdict records the prior head + the prior reviewer (not fabricated).
  const correctness = plan.carried.find((c) => c.angle === "correctness");
  assert.equal(correctness.carriedFromHead, "aaaaaaa");
  assert.equal(correctness.reviewer, "review-a");
  // docs angle's surface changed -> must re-run.
  assert.deepEqual(plan.mustRerun.map((m) => m.angle), ["docs"]);
});

test("buildCarryForwardPlan carries the FULL reviewer identity (dispatchId/model), not just reviewer", () => {
  // Prior entry recorded its identity under dispatchId (no `reviewer`) — the
  // provenance contract counts dispatchId as a reviewer identity, so the carried
  // entry must preserve it or distinctReviewers breaks at the new head.
  const log = {
    headSha: "aaaaaaa",
    verdict: "clean",
    provenance: {
      distinctReviewers: 2,
      perAngle: [
        { angle: "correctness", dispatchId: "dispatch-42", model: "opus" },
        { angle: "docs", reviewer: "review-c" },
      ],
    },
  };
  const plan = buildCarryForwardPlan({ log, changedFiles: ["docs/guide.md"] });
  const correctness = plan.carried.find((c) => c.angle === "correctness");
  assert.equal(correctness.carriedFromHead, "aaaaaaa");
  assert.equal(correctness.dispatchId, "dispatch-42");
  assert.equal(correctness.model, "opus");
  assert.ok(!("reviewer" in correctness), "no fabricated reviewer when the prior entry had none");
});

test("buildCarryForwardPlan re-runs code angles but carries the docs angle on a code delta", () => {
  const plan = buildCarryForwardPlan({ log: cleanLog, changedFiles: ["src/foo.mjs"] });
  // Code delta touches correctness + coverage surfaces; docs surface untouched.
  assert.deepEqual(plan.mustRerun.map((m) => m.angle).sort(), ["correctness", "coverage"]);
  assert.deepEqual(plan.carried.map((c) => c.angle), ["docs"]);
});

test("buildCarryForwardPlan fails closed on a non-clean or missing prior log", () => {
  assert.throws(() => buildCarryForwardPlan({ log: null, changedFiles: ["docs/x.md"] }), /not found or unreadable/);
  assert.throws(
    () => buildCarryForwardPlan({ log: { ...cleanLog, verdict: "findings_present" }, changedFiles: ["docs/x.md"] }),
    /not "clean"/,
  );
  assert.throws(
    () => buildCarryForwardPlan({ log: { headSha: "aaaaaaa", verdict: "clean", provenance: { distinctReviewers: 0, perAngle: [] } }, changedFiles: ["docs/x.md"] }),
    /no provenance\.perAngle reviewers/,
  );
});

test("buildCarryForwardPlan fails closed on a malformed prior-log headSha (no bad carriedFromHead stamp)", () => {
  for (const badHead of [undefined, null, "", "not-a-sha", "zzzz", "aaa", 1234567]) {
    assert.throws(
      () => buildCarryForwardPlan({ log: { ...cleanLog, headSha: badHead }, changedFiles: ["docs/guide.md"] }),
      /headSha .* not a 7-64 char hex SHA/,
      `headSha=${JSON.stringify(badHead)} must fail closed`,
    );
  }
});

test("buildCarryForwardPlan never carries an alwaysRerun angle even when the delta is outside its surface", () => {
  // `docs` surface is `docs`; a code-only delta does not touch it, so it would
  // carry — but passing it in alwaysRerun (a configured mandatory angle) forces
  // it to re-run.
  const plan = buildCarryForwardPlan({ log: cleanLog, changedFiles: ["src/foo.mjs"], alwaysRerun: ["docs"] });
  assert.ok(!plan.carried.some((c) => c.angle === "docs"), "docs must not be carried");
  assert.ok(plan.mustRerun.some((m) => m.angle === "docs"), "docs must re-run (mandatory)");
});

test("CLI loads the gate's configured mandatoryAngles and never carries them (fail-closed hole)", async () => {
  // `docs` is configured mandatory; the delta is code-only (outside docs' surface),
  // so without loading mandatoryAngles docs would be CARRIED. It must re-run.
  const { repoRoot, prevHead, headSha } = await makeCarryForwardRepo({
    mandatoryAngles: ["docs"],
    perAngle: [
      { angle: "correctness", reviewer: "review-a" },
      { angle: "docs", reviewer: "review-c" },
    ],
    mutate: async (root) => {
      await writeFile(path.join(root, "src/foo.mjs"), "export function foo() { return 2; }\n", "utf8");
    },
  });
  try {
    const result = await runMain([
      "--repo", "o/n", "--pr", "7", "--gate", "draft_gate", "--prev-head", prevHead, "--head-sha", headSha,
    ], { repoRoot });
    assert.equal(result.ok, true);
    const carried = result.carried.map((c) => c.angle);
    const rerun = result.mustRerun.map((m) => m.angle);
    assert.ok(!carried.includes("docs"), "configured mandatory docs must NOT be carried");
    assert.ok(rerun.includes("docs"), "configured mandatory docs must re-run");
    assert.ok(rerun.includes("correctness"), "code delta touches correctness surface");
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("CLI forces the RENAME_ONLY angles to re-run when the delta contains a rename", async () => {
  // Pure rename of a doc file: classifying the destination path alone would only
  // implicate docs; the rename must force scope/correctness/contract-surface/link-check too.
  const { repoRoot, prevHead, headSha } = await makeCarryForwardRepo({
    mandatoryAngles: [],
    perAngle: [
      { angle: "scope", reviewer: "review-a" },
      { angle: "correctness", reviewer: "review-b" },
      { angle: "coverage", reviewer: "review-c" },
    ],
    mutate: async (root) => {
      git(root, ["mv", "docs/guide.md", "docs/handbook.md"]);
    },
  });
  try {
    const result = await runMain([
      "--repo", "o/n", "--pr", "7", "--gate", "draft_gate", "--prev-head", prevHead, "--head-sha", headSha,
    ], { repoRoot });
    assert.equal(result.ok, true);
    const rerun = result.mustRerun.map((m) => m.angle);
    const carried = result.carried.map((c) => c.angle);
    // RENAME_ONLY-mapped angles present in the prior log must re-run.
    assert.ok(rerun.includes("scope"), "rename forces scope");
    assert.ok(rerun.includes("correctness"), "rename forces correctness");
    // coverage is not RENAME_ONLY-mapped and its surface (test/code) is untouched → carries.
    assert.ok(carried.includes("coverage"), "coverage carries (not a rename angle, surface untouched)");
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("CLI re-runs code angles on a DIVERGENT advance where the file equals the merge-base (two-dot delta, not three-dot)", async () => {
  // Divergent history: A reviews src/foo.mjs=v2; B is a SIBLING of the merge-base
  // where foo.mjs is back at v1 (== merge-base) plus a new doc. A three-dot diff
  // (base...HEAD == merge-base..B) would OMIT foo.mjs and wrongly carry the code
  // angles; the two-dot diff (base..HEAD) sees foo.mjs differs A vs B → re-run.
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "carry-forward-divergent-"));
  try {
    git(repoRoot, ["init", "-q"]);
    git(repoRoot, ["config", "user.email", "test@example.com"]);
    git(repoRoot, ["config", "user.name", "Test"]);
    await writeFile(path.join(repoRoot, ".devloops.yaml"), "version: 1\ngates:\n  draft: {}\n", "utf8");
    await mkdir(path.join(repoRoot, "src"), { recursive: true });
    await mkdir(path.join(repoRoot, "docs"), { recursive: true });
    // merge-base M: foo.mjs = v1
    await writeFile(path.join(repoRoot, "src/foo.mjs"), "export function foo() { return 1; }\n", "utf8");
    await writeFile(path.join(repoRoot, "docs/guide.md"), "# Guide\n", "utf8");
    git(repoRoot, ["add", "-A"]);
    git(repoRoot, ["commit", "-q", "-m", "merge-base"]);
    const mergeBase = git(repoRoot, ["rev-parse", "HEAD"]).trim();
    // Head A (reviewed): foo.mjs = v2
    git(repoRoot, ["checkout", "-q", "-b", "headA"]);
    await writeFile(path.join(repoRoot, "src/foo.mjs"), "export function foo() { return 2; }\n", "utf8");
    git(repoRoot, ["add", "-A"]);
    git(repoRoot, ["commit", "-q", "-m", "head A reviews foo=v2"]);
    const prevHead = git(repoRoot, ["rev-parse", "HEAD"]).trim().toLowerCase();
    // Head B: sibling of the merge-base — foo.mjs stays v1 (== merge-base), add a doc.
    git(repoRoot, ["checkout", "-q", "-b", "headB", mergeBase]);
    await writeFile(path.join(repoRoot, "docs/new.md"), "# New\n", "utf8");
    git(repoRoot, ["add", "-A"]);
    git(repoRoot, ["commit", "-q", "-m", "head B reverts foo, adds doc"]);
    const headSha = git(repoRoot, ["rev-parse", "HEAD"]).trim().toLowerCase();

    const perAngle = [
      { angle: "correctness", reviewer: "review-a" },
      { angle: "coverage", reviewer: "review-b" },
      { angle: "docs", reviewer: "review-c" },
    ];
    const logPath = path.join(repoRoot, buildLogPath({ repo: "o/n", pr: 7, gate: "draft_gate", headSha: prevHead, tmpRoot: "tmp" }));
    await mkdir(path.dirname(logPath), { recursive: true });
    await writeFile(logPath, JSON.stringify({ headSha: prevHead, verdict: "clean", provenance: { distinctReviewers: perAngle.length, perAngle } }), "utf8");

    const result = await runMain([
      "--repo", "o/n", "--pr", "7", "--gate", "draft_gate", "--prev-head", prevHead, "--head-sha", headSha,
    ], { repoRoot });
    assert.equal(result.ok, true);
    // Two-dot delta MUST contain foo.mjs even though it equals the merge-base on B's side.
    assert.ok(result.deltaChangedFiles.includes("src/foo.mjs"), "two-dot delta must include the file that differs A vs B");
    const rerun = result.mustRerun.map((m) => m.angle);
    const carried = result.carried.map((c) => c.angle);
    assert.ok(rerun.includes("correctness"), "correctness surface changed A→B → must re-run (would wrongly carry under three-dot)");
    assert.ok(rerun.includes("coverage"), "coverage surface changed A→B → must re-run");
    assert.ok(!carried.includes("correctness"), "correctness must NOT be carried on a divergent code change");
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("CLI fails closed when --head-sha does not match the worktree HEAD (wrong worktree)", async () => {
  const { repoRoot, prevHead } = await makeCarryForwardRepo({
    mandatoryAngles: [],
    perAngle: [{ angle: "correctness", reviewer: "review-a" }],
    mutate: async (root) => {
      await writeFile(path.join(root, "src/foo.mjs"), "export function foo() { return 2; }\n", "utf8");
    },
  });
  try {
    // A syntactically valid SHA that is NOT the worktree HEAD → delta would resolve
    // against the wrong head while the plan claims to be for this --head-sha.
    const bogusHead = "0".repeat(40);
    const { stdout, stderr, exitCode } = await runMainRaw([
      "--repo", "o/n", "--pr", "7", "--gate", "draft_gate", "--prev-head", prevHead, "--head-sha", bogusHead,
    ], { repoRoot });
    assert.equal(exitCode, 1, "must fail closed");
    assert.equal(stdout, "", "no carry-forward plan is emitted on mismatch");
    // stderr may also carry ambient git warnings under the test env's GIT_CONFIG,
    // so match the fail-closed error substring rather than JSON-parsing the stream.
    assert.match(stderr, /"ok":false/);
    assert.match(stderr, /does not match --head-sha/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("parseResolveAngleCarryForwardCliArgs requires the core args", () => {
  assert.throws(() => parseResolveAngleCarryForwardCliArgs(["--repo", "o/n"]), /Missing required arguments/);
  const fullPrevHead = "a".repeat(40);
  const opts = parseResolveAngleCarryForwardCliArgs([
    "--repo", "o/n", "--pr", "5", "--gate", "draft_gate", "--prev-head", fullPrevHead, "--head-sha", "bbbbbbb",
  ]);
  assert.equal(opts.gate, "draft_gate");
  assert.equal(opts.prevHead, fullPrevHead);
  assert.equal(opts.headSha, "bbbbbbb");
});

test("parseResolveAngleCarryForwardCliArgs rejects an abbreviated --prev-head (the log path is keyed by the full SHA)", () => {
  assert.throws(
    () => parseResolveAngleCarryForwardCliArgs([
      "--repo", "o/n", "--pr", "5", "--gate", "draft_gate", "--prev-head", "aaaaaaa", "--head-sha", "bbbbbbb",
    ]),
    /--prev-head must be the FULL head commit SHA/,
  );
});

test("round A→B: a clean angle the delta misses carries, gets no fresh reviewer, and still counts at head B", async () => {
  // Round 1 at head A: correctness/coverage/docs all clean, one reviewer each.
  // Round 2's delta is doc-only, so correctness and coverage carry and only
  // docs is re-dispatched — and the head-B provenance built from that plan
  // still passes the findings-log's consistency + one-reviewer-per-fresh-angle
  // checks, i.e. the carried verdicts genuinely count at head B.
  const { repoRoot, prevHead, headSha } = await makeCarryForwardRepo({
    mandatoryAngles: [],
    perAngle: [
      { angle: "correctness", reviewer: "review-a" },
      { angle: "coverage", reviewer: "review-b" },
      { angle: "docs", reviewer: "review-c" },
    ],
    mutate: async (root) => {
      await writeFile(path.join(root, "docs/guide.md"), "# Guide\n\nMore prose.\n", "utf8");
    },
  });
  try {
    const result = await runMain([
      "--repo", "o/n", "--pr", "7", "--gate", "draft_gate", "--prev-head", prevHead, "--head-sha", headSha,
    ], { repoRoot });
    assert.equal(result.ok, true);
    assert.deepEqual(result.carried.map((c) => c.angle).sort(), ["correctness", "coverage"]);
    assert.deepEqual(result.mustRerun.map((m) => m.angle), ["docs"]);
    // Carried entries name the PRIOR head and the PRIOR reviewer — not a fresh one.
    for (const entry of result.carried) {
      assert.equal(entry.carriedFromHead, prevHead);
    }
    assert.equal(result.carried.find((c) => c.angle === "correctness").reviewer, "review-a");
    assert.equal(result.carried.find((c) => c.angle === "coverage").reviewer, "review-b");

    // Head B's findings-log: carried entries passed through VERBATIM (every
    // identity field the plan carries, not a hand-picked subset — a
    // dispatchId-only prior entry would otherwise land identity-less), plus ONE
    // fresh reviewer for the single re-run angle. This is what the procedure records.
    const provenance = parseProvenanceJson(JSON.stringify({
      distinctReviewers: 3,
      perAngle: [
        ...result.carried.map(({ reason, ...entry }) => entry),
        { angle: "docs", reviewer: "review-d" },
      ],
    }));
    assert.deepEqual(provenance.perAngle.map((a) => a.angle).sort(), ["correctness", "coverage", "docs"]);
    assert.equal(provenance.perAngle.filter((a) => a.carriedFromHead === prevHead).length, 2);
    assert.equal(provenance.perAngle.filter((a) => !("carriedFromHead" in a)).length, 1);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("carrying exempts the CARRIED entry from the reviewer-pairing floor, and nothing else", () => {
  // A carried entry reuses the identity that reviewed it at the PRIOR head, so it
  // is exempt from the one-scoped-reviewer-per-fresh-angle floor — even when a
  // fresh angle at this head names the same reviewer.
  const withCarriedCollision = parseProvenanceJson(JSON.stringify({
    distinctReviewers: 2,
    perAngle: [
      { angle: "correctness", reviewer: "review-a", carriedFromHead: "aaaaaaa" },
      { angle: "docs", reviewer: "review-a" },
      { angle: "scope", reviewer: "review-d" },
    ],
  }));
  assert.equal(withCarriedCollision.perAngle.length, 3);

  // The floor still binds between two FRESH angles: the exemption is for carrying,
  // never a licence to let one fresh reviewer cover two angles at this head.
  assert.throws(
    () => parseProvenanceJson(JSON.stringify({
      distinctReviewers: 2,
      perAngle: [
        { angle: "correctness", reviewer: "review-a", carriedFromHead: "aaaaaaa" },
        { angle: "docs", reviewer: "review-d" },
        { angle: "scope", reviewer: "review-d" },
      ],
    })),
    /reviewer/i,
  );
});

test("an angle named by a prior finding never carries, even from a clean log", () => {
  // A log is `clean` when nothing reached a BLOCKING severity — a `defer` finding
  // still means that angle reported a problem, so it must be re-reviewed.
  const plan = buildCarryForwardPlan({
    log: {
      headSha: "aaaaaaa",
      verdict: "clean",
      findings: [{ angle: "coverage", severity: "nice-to-have", summary: "open nit" }],
      provenance: {
        distinctReviewers: 2,
        perAngle: [
          { angle: "correctness", reviewer: "review-a" },
          { angle: "coverage", reviewer: "review-b" },
        ],
      },
    },
    changedFiles: ["docs/guide.md"],
  });
  assert.deepEqual(plan.carried.map((c) => c.angle), ["correctness"]);
  assert.ok(plan.mustRerun.some((m) => m.angle === "coverage"), "an angle with a prior finding must re-run");
  // The reason is attributed to the actual cause, not the generic
  // mandatory/always-include phrasing resolveCarryForwardAngles uses for that surface.
  const coverageRerun = plan.mustRerun.find((m) => m.angle === "coverage");
  assert.match(coverageRerun.reason, /returned a finding at the prior head/);
});

test("a prior finding on a delta-suffixed re-review entry still forces its BASE angle to re-run", () => {
  // gate-fanin's baseAngleName strips `-delta-at-...`; a finding recorded under
  // that suffixed name must still attribute to the base angle's provenance row.
  const plan = buildCarryForwardPlan({
    log: {
      headSha: "aaaaaaa",
      verdict: "clean",
      findings: [{ angle: "coverage-delta-at-deadbeef", severity: "nice-to-have", summary: "still open" }],
      provenance: {
        distinctReviewers: 2,
        perAngle: [
          { angle: "correctness", reviewer: "review-a" },
          { angle: "coverage", reviewer: "review-b" },
        ],
      },
    },
    changedFiles: ["docs/guide.md"],
  });
  assert.deepEqual(plan.carried.map((c) => c.angle), ["correctness"]);
  assert.ok(plan.mustRerun.some((m) => m.angle === "coverage"), "the base angle must re-run, not just the suffixed name");
});

test("a prior finding attributes to its angle case-insensitively", () => {
  const plan = buildCarryForwardPlan({
    log: {
      headSha: "aaaaaaa",
      verdict: "clean",
      findings: [{ angle: "Coverage", severity: "nice-to-have", summary: "still open" }],
      provenance: {
        distinctReviewers: 2,
        perAngle: [
          { angle: "correctness", reviewer: "review-a" },
          { angle: "coverage", reviewer: "review-b" },
        ],
      },
    },
    changedFiles: ["docs/guide.md"],
  });
  assert.ok(plan.mustRerun.some((m) => m.angle === "coverage"), "case drift between the two authored lists must still attribute");
});

// A base+lowercase key can legitimately collect MORE THAN ONE provenance.perAngle
// row (a base angle plus its `-delta-at-...` sibling, or a case-drifted pair —
// neither is caught by the exact-string duplicate guard). A finding naming that
// base must force EVERY colliding row to re-run, not just whichever one a
// last-wins Map happened to keep — and the outcome must not depend on row order.
for (const [label, perAngle] of [
  ["base row first", [
    { angle: "coverage", reviewer: "review-b" },
    { angle: "coverage-delta-at-cafe", reviewer: "review-d" },
  ]],
  ["delta-suffixed row first", [
    { angle: "coverage-delta-at-cafe", reviewer: "review-d" },
    { angle: "coverage", reviewer: "review-b" },
  ]],
]) {
  test(`a prior finding on "coverage" forces BOTH the base row and its -delta-at- sibling to re-run (${label})`, () => {
    const plan = buildCarryForwardPlan({
      log: {
        headSha: "aaaaaaa",
        verdict: "clean",
        findings: [{ angle: "coverage", severity: "nice-to-have", summary: "still open" }],
        provenance: {
          distinctReviewers: 3,
          perAngle: [{ angle: "correctness", reviewer: "review-a" }, ...perAngle],
        },
      },
      changedFiles: ["docs/guide.md"],
    });
    assert.deepEqual(plan.carried.map((c) => c.angle), ["correctness"]);
    const rerun = plan.mustRerun.map((m) => m.angle);
    assert.ok(rerun.includes("coverage"), `${label}: base row must re-run`);
    assert.ok(rerun.includes("coverage-delta-at-cafe"), `${label}: delta-suffixed sibling must re-run too`);
  });
}

test("a prior finding on a base angle forces every case-drifted row sharing it to re-run", () => {
  const plan = buildCarryForwardPlan({
    log: {
      headSha: "aaaaaaa",
      verdict: "clean",
      findings: [{ angle: "coverage", severity: "nice-to-have", summary: "still open" }],
      provenance: {
        distinctReviewers: 3,
        perAngle: [
          { angle: "correctness", reviewer: "review-a" },
          { angle: "coverage", reviewer: "review-b" },
          { angle: "Coverage", reviewer: "review-c" },
        ],
      },
    },
    changedFiles: ["docs/guide.md"],
  });
  assert.deepEqual(plan.carried.map((c) => c.angle), ["correctness"]);
  const rerun = plan.mustRerun.map((m) => m.angle);
  assert.ok(rerun.includes("coverage"), "the exact-cased row must re-run");
  assert.ok(rerun.includes("Coverage"), "the case-drifted sibling must re-run too, not silently carry");
});

test("buildCarryForwardPlan fails closed when a prior finding's angle matches no provenance.perAngle entry", () => {
  assert.throws(
    () => buildCarryForwardPlan({
      log: {
        headSha: "aaaaaaa",
        verdict: "clean",
        findings: [{ angle: "typo-ed-angle", severity: "nice-to-have", summary: "open nit" }],
        provenance: {
          distinctReviewers: 1,
          perAngle: [{ angle: "correctness", reviewer: "review-a" }],
        },
      },
      changedFiles: ["docs/guide.md"],
    }),
    /matches no provenance\.perAngle entry/,
  );
});

test("buildCarryForwardPlan fails closed when the prior log's findings field is not an array", () => {
  assert.throws(
    () => buildCarryForwardPlan({
      log: {
        headSha: "aaaaaaa",
        verdict: "clean",
        findings: { angle: "correctness" },
        provenance: {
          distinctReviewers: 1,
          perAngle: [{ angle: "correctness", reviewer: "review-a" }],
        },
      },
      changedFiles: ["docs/guide.md"],
    }),
    /findings field is not an array/,
  );
});

test("buildCarryForwardPlan fails closed on a prior log that records one angle twice", () => {
  assert.throws(
    () => buildCarryForwardPlan({
      log: {
        headSha: "aaaaaaa",
        verdict: "clean",
        provenance: {
          distinctReviewers: 2,
          perAngle: [
            { angle: "correctness", reviewer: "review-a" },
            { angle: "correctness", reviewer: "review-b" },
          ],
        },
      },
      changedFiles: ["docs/guide.md"],
    }),
    /records angle "correctness" more than once/,
  );
});

test("CLI fails closed when the prior log's own headSha is not --prev-head", async () => {
  // The log path is keyed by --prev-head while carriedFromHead is stamped from the
  // log's internal headSha; a disagreement would stamp a head that was never diffed.
  const { repoRoot, prevHead, headSha } = await makeCarryForwardRepo({
    mandatoryAngles: [],
    perAngle: [{ angle: "coverage", reviewer: "review-b" }],
    mutate: async (root) => {
      await writeFile(path.join(root, "docs/guide.md"), "# Guide\n\nMore.\n", "utf8");
    },
  });
  try {
    const logPath = path.join(repoRoot, buildLogPath({ repo: "o/n", pr: 7, gate: "draft_gate", headSha: prevHead, tmpRoot: "tmp" }));
    await writeFile(logPath, JSON.stringify({
      headSha: "0123456789abcdef0123456789abcdef01234567",
      verdict: "clean",
      provenance: { distinctReviewers: 1, perAngle: [{ angle: "coverage", reviewer: "review-b" }] },
    }), "utf8");
    const { stderr, exitCode } = await runMainRaw([
      "--repo", "o/n", "--pr", "7", "--gate", "draft_gate", "--prev-head", prevHead, "--head-sha", headSha,
    ], { repoRoot });
    assert.equal(exitCode, 1);
    assert.match(stderr, /is not --prev-head/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("CLI's worktree guard and delta are pinned to repoRoot, not an inherited GIT_DIR/GIT_WORK_TREE pointing at a different repo", async () => {
  // Before the fix, assertWorktreeAtHead's `git rev-parse HEAD` inherited the raw
  // env: an exported GIT_DIR/GIT_WORK_TREE overrides `cwd` outright, so the guard
  // would read the OTHER repo's HEAD instead of repoRoot's — a syntactically valid
  // repo, so it fails EITHER by wrongly refusing (HEADs differ) or, if they
  // happened to match, by validating one repo while the (already-scrubbed) delta
  // capture diffs a different one. Either way the plan must be unaffected.
  const { repoRoot, prevHead, headSha } = await makeCarryForwardRepo({
    mandatoryAngles: [],
    perAngle: [{ angle: "correctness", reviewer: "review-a" }],
    mutate: async (root) => {
      await writeFile(path.join(root, "src/foo.mjs"), "export function foo() { return 2; }\n", "utf8");
    },
  });
  const otherRepo = await mkdtemp(path.join(os.tmpdir(), "carry-forward-other-"));
  git(otherRepo, ["init", "-q"]);
  git(otherRepo, ["config", "user.email", "other@example.com"]);
  git(otherRepo, ["config", "user.name", "Other"]);
  await writeFile(path.join(otherRepo, "unrelated.txt"), "unrelated\n", "utf8");
  git(otherRepo, ["add", "-A"]);
  git(otherRepo, ["commit", "-q", "-m", "unrelated"]);

  const savedGitDir = process.env.GIT_DIR;
  const savedWorkTree = process.env.GIT_WORK_TREE;
  process.env.GIT_DIR = path.join(otherRepo, ".git");
  process.env.GIT_WORK_TREE = otherRepo;
  try {
    const { stdout, stderr, exitCode } = await runMainRaw([
      "--repo", "o/n", "--pr", "7", "--gate", "draft_gate", "--prev-head", prevHead, "--head-sha", headSha,
    ], { repoRoot });
    assert.equal(exitCode, 0, `an inherited GIT_DIR pointing at a different repo must not break the CLI: ${stderr}`);
    const result = JSON.parse(stdout);
    assert.equal(result.ok, true);
    assert.deepEqual(result.deltaChangedFiles, ["src/foo.mjs"], "delta must resolve against repoRoot, not the redirected repo");
    assert.ok(result.mustRerun.some((m) => m.angle === "correctness"), "plan must match the un-redirected run");
  } finally {
    if (savedGitDir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = savedGitDir;
    if (savedWorkTree === undefined) delete process.env.GIT_WORK_TREE; else process.env.GIT_WORK_TREE = savedWorkTree;
    await rm(repoRoot, { recursive: true, force: true });
    await rm(otherRepo, { recursive: true, force: true });
  }
});

test("parseResolveAngleCarryForwardCliArgs fails closed on a same-head carry", () => {
  const sha = "c3".repeat(20);
  assert.throws(
    () => parseResolveAngleCarryForwardCliArgs([
      "--repo", "o/n", "--pr", "7", "--gate", "draft_gate", "--prev-head", sha, "--head-sha", sha,
    ]),
    /same-head carry-forward/,
  );
  // Abbreviated --head-sha spelling of the same commit must not slip past.
  assert.throws(
    () => parseResolveAngleCarryForwardCliArgs([
      "--repo", "o/n", "--pr", "7", "--gate", "draft_gate", "--prev-head", sha, "--head-sha", sha.slice(0, 7),
    ]),
    /same-head carry-forward/,
  );
});
