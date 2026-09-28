import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  parseSpecContextCliArgs,
  runCli,
  specContextChangedPaths,
  specContextExtract,
} from "../../scripts/loop/spec-context.mjs";
import { computeContentDigest, computeSpecDigest, specCriterionIds } from "@dev-loops/core/loop/spec-authority";
import { readSpecAuthorityIdentity } from "../../scripts/lib/spec-authority-stamp.mjs";
import { GRAPHQL_RATE_LIMIT_MAX_WAIT_MS } from "@dev-loops/core/loop/policy-constants";

const BODY = [
  "## Acceptance criteria",
  "- [ ] Remove repetitive A/B contrast scaffolding",
  "- [ ] Ship a working demo",
  "## Definition of done",
  "- [ ] npm run verify passes",
  "## Non-goals",
  "- Do not flatten the decks' voice or product identity",
].join("\n");

function stubTracker(body = BODY) {
  return {
    getIssue: async ({ repo, id }) => ({
      id,
      title: "Test issue",
      body,
      url: `https://github.com/${repo}/issues/${id}`,
      state: "open",
    }),
  };
}

// --- extract mode ---

test("specContextExtract resolves the spec + both revision-identity digests + criterionIds", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "spec-context-extract-"));
  try {
    const contentPath = path.join(tmpDir, "content.txt");
    await writeFile(contentPath, "reviewed implementation content", "utf8");
    const result = await specContextExtract(
      { repo: "mfittko/dev-loops", issue: 2008, contentFile: "./content.txt", headSha: "a".repeat(40) },
      { repoRoot: tmpDir, tracker: stubTracker() },
    );
    assert.equal(result.ok, true);
    assert.equal(result.repo, "mfittko/dev-loops");
    assert.equal(result.issue, 2008);
    assert.equal(result.spec.acceptanceCriteria.length, 2);
    assert.equal(result.specDigest, computeSpecDigest(result.spec));
    assert.equal(result.contentDigest, computeContentDigest("reviewed implementation content"));
    assert.deepEqual(result.criterionIds, specCriterionIds(result.spec));
    assert.equal(result.headSha, "a".repeat(40));
    assert.equal(result.specOut, undefined);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("specContextExtract writes --spec-out in the shape judge-pass --spec-file expects", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "spec-context-specout-"));
  try {
    await writeFile(path.join(tmpDir, "content.txt"), "impl", "utf8");
    const result = await specContextExtract(
      { repo: "mfittko/dev-loops", issue: 7, contentFile: "./content.txt", specOut: "./spec.json" },
      { repoRoot: tmpDir, tracker: stubTracker() },
    );
    assert.equal(result.specOut, "./spec.json");
    const written = JSON.parse(await readFile(path.join(tmpDir, "spec.json"), "utf8"));
    assert.deepEqual(written, result.spec);
    assert.ok(Array.isArray(written.acceptanceCriteria));
    assert.ok(Array.isArray(written.definitionOfDone));
    assert.ok(Array.isArray(written.nonGoals));
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("specContextExtract --identity-out emits the four-field identity stamp {specDigest,headSha,contentDigest,checkedCriteria}", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "spec-context-identity-"));
  try {
    await writeFile(path.join(tmpDir, "content.txt"), "reviewed implementation content", "utf8");
    const result = await specContextExtract(
      {
        repo: "mfittko/dev-loops",
        issue: 2008,
        contentFile: "./content.txt",
        headSha: "a".repeat(40),
        identityOut: "./identity.json",
      },
      { repoRoot: tmpDir, tracker: stubTracker() },
    );
    assert.equal(result.identityOut, "./identity.json");
    const written = JSON.parse(await readFile(path.join(tmpDir, "identity.json"), "utf8"));
    assert.deepEqual(Object.keys(written).sort(), ["checkedCriteria", "contentDigest", "headSha", "specDigest"]);
    assert.equal(written.specDigest, result.specDigest);
    assert.equal(written.headSha, "a".repeat(40));
    assert.equal(written.contentDigest, result.contentDigest);
    assert.deepEqual(written.checkedCriteria, result.criterionIds);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("specContextExtract --identity-out round-trips through a writer's --spec-authority reader", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "spec-context-identity-roundtrip-"));
  try {
    await writeFile(path.join(tmpDir, "content.txt"), "reviewed implementation content", "utf8");
    await specContextExtract(
      {
        repo: "mfittko/dev-loops",
        issue: 2008,
        contentFile: "./content.txt",
        headSha: "b".repeat(40),
        identityOut: "./identity.json",
      },
      { repoRoot: tmpDir, tracker: stubTracker() },
    );
    const identity = await readSpecAuthorityIdentity(
      path.join(tmpDir, "identity.json"),
      (message) => new Error(message),
    );
    assert.equal(identity.headSha, "b".repeat(40));
    assert.ok(Array.isArray(identity.checkedCriteria));
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("specContextExtract fails closed on --identity-out without --head-sha", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "spec-context-identity-nohead-"));
  try {
    await writeFile(path.join(tmpDir, "content.txt"), "impl", "utf8");
    await assert.rejects(
      specContextExtract(
        { repo: "mfittko/dev-loops", issue: 1, contentFile: "./content.txt", identityOut: "./identity.json" },
        { repoRoot: tmpDir, tracker: stubTracker() },
      ),
      /--identity-out requires --head-sha/,
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("specContextExtract fails closed on an unreadable --content-file", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "spec-context-badcontent-"));
  try {
    await assert.rejects(
      specContextExtract(
        { repo: "mfittko/dev-loops", issue: 1, contentFile: "./missing.txt" },
        { repoRoot: tmpDir, tracker: stubTracker() },
      ),
      /Cannot read --content-file/,
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("specContextExtract fails closed on a spec with no acceptance criteria (empty tracker body)", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "spec-context-nospec-"));
  try {
    await writeFile(path.join(tmpDir, "content.txt"), "impl", "utf8");
    await assert.rejects(
      specContextExtract(
        { repo: "mfittko/dev-loops", issue: 1, contentFile: "./content.txt" },
        { repoRoot: tmpDir, tracker: stubTracker("no structured sections here") },
      ),
      /no acceptance criteria and no definition of done; expected .*any heading level.*`- \[ \]` checkbox items/,
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// --- changed-paths mode ---

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_DIR: undefined, GIT_WORK_TREE: undefined },
  });
}

async function makeChangedPathsRepo() {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "spec-context-changed-paths-"));
  git(repoRoot, ["init", "-q"]);
  git(repoRoot, ["config", "user.email", "test@example.com"]);
  git(repoRoot, ["config", "user.name", "Test"]);
  await mkdir(path.join(repoRoot, "src"), { recursive: true });
  await writeFile(path.join(repoRoot, "src", "a.mjs"), "export const a = 1;\n", "utf8");
  git(repoRoot, ["add", "-A"]);
  git(repoRoot, ["commit", "-q", "-m", "base"]);
  const base = git(repoRoot, ["rev-parse", "HEAD"]).trim();
  await writeFile(path.join(repoRoot, "src", "a.mjs"), "export const a = 2;\n", "utf8");
  await writeFile(path.join(repoRoot, "src", "b.mjs"), "export const b = 1;\n", "utf8");
  git(repoRoot, ["add", "-A"]);
  git(repoRoot, ["commit", "-q", "-m", "delta"]);
  const head = git(repoRoot, ["rev-parse", "HEAD"]).trim();
  return { repoRoot, base, head };
}

test("specContextChangedPaths emits the JSON string array of changed repo-relative paths", async () => {
  const { repoRoot, base, head } = await makeChangedPathsRepo();
  try {
    const result = await specContextChangedPaths({ base, head }, { repoRoot });
    assert.equal(result.ok, true);
    assert.deepEqual(result.changedFiles.sort(), ["src/a.mjs", "src/b.mjs"]);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("specContextChangedPaths resolves --repo-root relative to the caller's repoRoot", async () => {
  const { repoRoot, base, head } = await makeChangedPathsRepo();
  const parent = path.dirname(repoRoot);
  try {
    const result = await specContextChangedPaths({ base, head, repoRoot: path.basename(repoRoot) }, { repoRoot: parent });
    assert.deepEqual(result.changedFiles.sort(), ["src/a.mjs", "src/b.mjs"]);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("specContextChangedPaths fails closed on a leading-'-' --base (ref-shape guard)", async () => {
  const { repoRoot, head } = await makeChangedPathsRepo();
  try {
    await assert.rejects(
      specContextChangedPaths({ base: "-ohno", head }, { repoRoot }),
      /plausible git refs/,
    );
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("specContextChangedPaths fails closed on a '..'-embedding --head (ref-shape guard)", async () => {
  const { repoRoot, base } = await makeChangedPathsRepo();
  try {
    await assert.rejects(
      specContextChangedPaths({ base, head: "HEAD..evil" }, { repoRoot }),
      /plausible git refs/,
    );
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

// --- CLI arg parsing / mode dispatch ---

test("parseSpecContextCliArgs dispatches to extract mode by default", () => {
  const opts = parseSpecContextCliArgs(["--repo", "o/n", "--issue", "1", "--content-file", "c.txt"]);
  assert.equal(opts.mode, "extract");
  assert.equal(opts.repo, "o/n");
  assert.equal(opts.issue, 1);
  assert.equal(opts.contentFile, "c.txt");
});

test("parseSpecContextCliArgs requires --repo/--issue/--content-file in extract mode", () => {
  assert.throws(() => parseSpecContextCliArgs(["--repo", "o/n"]), /extract mode requires/);
});

test("parseSpecContextCliArgs validates --head-sha shape in extract mode", () => {
  assert.throws(
    () => parseSpecContextCliArgs(["--repo", "o/n", "--issue", "1", "--content-file", "c.txt", "--head-sha", "not-a-sha"]),
    /--head-sha must be a 7-64 char hex SHA/,
  );
});

test("parseSpecContextCliArgs dispatches to changed-paths mode on the leading positional", () => {
  const opts = parseSpecContextCliArgs(["changed-paths", "--base", "abc1234", "--head", "def5678"]);
  assert.equal(opts.mode, "changed-paths");
  assert.equal(opts.base, "abc1234");
  assert.equal(opts.head, "def5678");
});

test("parseSpecContextCliArgs requires --base/--head in changed-paths mode", () => {
  assert.throws(() => parseSpecContextCliArgs(["changed-paths", "--base", "abc1234"]), /changed-paths mode requires/);
});

test("parseSpecContextCliArgs accepts --identity-out alongside --head-sha", () => {
  const opts = parseSpecContextCliArgs([
    "--repo", "o/n", "--issue", "1", "--content-file", "c.txt",
    "--head-sha", "a".repeat(40), "--identity-out", "identity.json",
  ]);
  assert.equal(opts.identityOut, "identity.json");
});

test("parseSpecContextCliArgs fails closed on --identity-out without --head-sha", () => {
  assert.throws(
    () => parseSpecContextCliArgs(["--repo", "o/n", "--issue", "1", "--content-file", "c.txt", "--identity-out", "identity.json"]),
    /--identity-out requires --head-sha/,
  );
});

test("parseSpecContextCliArgs fails closed on an unknown extract-mode flag", () => {
  assert.throws(() => parseSpecContextCliArgs(["--repo", "o/n", "--issue", "1", "--content-file", "c.txt", "--bogus"]), /Unknown argument/);
});

// --- GraphQL rate-limit reset wait ---

function rateLimitedTracker() {
  let reads = 0;
  const inner = stubTracker();
  return {
    getIssue: async (args) => {
      reads += 1;
      if (reads === 1) throw new Error("gh command failed: GraphQL: API rate limit exceeded for user ID 1.");
      return inner.getIssue(args);
    },
  };
}

function rateLimitRunChild(reset, calls) {
  return async (_command, args) => {
    calls.push(args.join(" "));
    return { code: 0, stdout: JSON.stringify({ resources: { graphql: { remaining: 0, reset } } }), stderr: "" };
  };
}

test("specContextExtract rethrows a non-rate-limit HTTP 404 unchanged without a rate_limit read or sleep", async () => {
  const message = "gh command failed: HTTP 404: Not Found";
  const sleeps = [];
  const reads = [];
  await assert.rejects(
    specContextExtract(
      { repo: "mfittko/dev-loops", issue: 7, contentFile: "./content.txt" },
      {
        repoRoot: os.tmpdir(), env: {},
        tracker: { getIssue: async () => { throw new Error(message); } },
        runChild: rateLimitRunChild(1, reads),
        sleep: async (ms) => { sleeps.push(ms); },
        now: () => 1_000_000_000_000,
      },
    ),
    (error) => error.message === message,
  );
  assert.deepEqual(sleeps, []);
  assert.deepEqual(reads, []);
});

test("specContextExtract waits for the GraphQL reset inside GRAPHQL_RATE_LIMIT_MAX_WAIT_MS and retries once", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "spec-context-ratelimit-"));
  try {
    await writeFile(path.join(tmpDir, "content.txt"), "impl", "utf8");
    const nowMs = 1_000_000_000_000;
    const sleeps = [];
    const reads = [];
    const result = await specContextExtract(
      { repo: "mfittko/dev-loops", issue: 7, contentFile: "./content.txt" },
      {
        repoRoot: tmpDir, tracker: rateLimitedTracker(), env: {},
        runChild: rateLimitRunChild(nowMs / 1000 + 300, reads),
        sleep: async (ms) => { sleeps.push(ms); },
        now: () => nowMs,
      },
    );
    assert.equal(result.ok, true);
    assert.deepEqual(sleeps, [300_000]);
    assert.deepEqual(reads, ["api rate_limit"]);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("specContextExtract returns RATE_LIMITED with resetAt, without sleeping, when the reset is beyond the cap", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "spec-context-ratelimit-cap-"));
  try {
    await writeFile(path.join(tmpDir, "content.txt"), "impl", "utf8");
    const nowMs = 1_000_000_000_000;
    const reset = nowMs / 1000 + GRAPHQL_RATE_LIMIT_MAX_WAIT_MS / 1000 + 60;
    const sleeps = [];
    const result = await specContextExtract(
      { repo: "mfittko/dev-loops", issue: 7, contentFile: "./content.txt" },
      {
        repoRoot: tmpDir, tracker: rateLimitedTracker(), env: {},
        runChild: rateLimitRunChild(reset, []),
        sleep: async (ms) => { sleeps.push(ms); },
        now: () => nowMs,
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, "RATE_LIMITED");
    assert.equal(result.resetAt, new Date(reset * 1000).toISOString());
    assert.deepEqual(sleeps, []);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("spec-context --jq '.contentDigest' still writes RATE_LIMITED with resetAt to stderr and exits 1", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "spec-context-ratelimit-jq-"));
  try {
    await writeFile(path.join(tmpDir, "content.txt"), "impl", "utf8");
    const nowMs = 1_000_000_000_000;
    const reset = nowMs / 1000 + GRAPHQL_RATE_LIMIT_MAX_WAIT_MS / 1000 + 60;
    let out = "";
    let err = "";
    const code = await runCli(
      ["--repo", "mfittko/dev-loops", "--issue", "7", "--content-file", "./content.txt", "--jq", ".contentDigest"],
      {
        stdout: { write: (chunk) => { out += chunk; return true; } },
        stderr: { write: (chunk) => { err += chunk; return true; } },
        extractDeps: {
          repoRoot: tmpDir, tracker: rateLimitedTracker(), env: {},
          runChild: rateLimitRunChild(reset, []),
          sleep: async () => {},
          now: () => nowMs,
        },
      },
    );
    assert.equal(code, 1);
    assert.equal(out.trim(), "null");
    const envelope = JSON.parse(err.trim().split("\n")[0]);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.code, "RATE_LIMITED");
    assert.equal(envelope.resetAt, new Date(reset * 1000).toISOString());
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("spec-context --help names the RATE_LIMITED result and its resetAt field", () => {
  const stdout = execFileSync(process.execPath, [path.resolve("scripts/loop/spec-context.mjs"), "--help"], { encoding: "utf8" });
  assert(stdout.includes("RATE_LIMITED"));
  assert(stdout.includes("resetAt"));
});
