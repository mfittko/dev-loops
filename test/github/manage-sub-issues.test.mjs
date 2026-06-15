import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { runNode as runNodeHelper, writeGhStub as writeGhStubHelper, writeJson as writeJsonHelper } from "../_helpers.mjs";

import {
  computeVerifyResult,
  parseManageSubIssuesCliArgs,
} from "../../scripts/github/manage-sub-issues.mjs";

const scriptPath = path.resolve("scripts/github/manage-sub-issues.mjs");

const runNode = (args = [], options = {}) => runNodeHelper(scriptPath, args, options);

async function writeGhStub(tempDir, entries) {
  const { env } = await writeGhStubHelper(tempDir, entries);
  return env;
}

function subIssuePayload(subIssues) {
  return `${JSON.stringify(subIssues)}\n`;
}

function issuePayload({ id, number, title = "Test issue", state = "open" }) {
  return `${JSON.stringify({ id, number, title, state })}\n`;
}

// ─── parseManageSubIssuesCliArgs unit tests ───────────────────────────────────

test("parseManageSubIssuesCliArgs returns help for --help", () => {
  assert.deepEqual(parseManageSubIssuesCliArgs(["--help"]), { help: true });
});

test("parseManageSubIssuesCliArgs returns help for -h", () => {
  assert.deepEqual(parseManageSubIssuesCliArgs(["-h"]), { help: true });
});

test("parseManageSubIssuesCliArgs returns help for empty args", () => {
  assert.deepEqual(parseManageSubIssuesCliArgs([]), { help: true });
});

test("parseManageSubIssuesCliArgs parses list command", () => {
  const opts = parseManageSubIssuesCliArgs(["list", "--repo", "owner/repo", "--issue", "42"]);
  assert.equal(opts.command, "list");
  assert.equal(opts.repo, "owner/repo");
  assert.equal(opts.issue, 42);
  assert.equal(opts.help, false);
});

test("parseManageSubIssuesCliArgs parses add command", () => {
  const opts = parseManageSubIssuesCliArgs([
    "add",
    "--repo",
    "owner/repo",
    "--issue",
    "42",
    "--child",
    "10",
  ]);
  assert.equal(opts.command, "add");
  assert.equal(opts.repo, "owner/repo");
  assert.equal(opts.issue, 42);
  assert.equal(opts.child, 10);
});

test("parseManageSubIssuesCliArgs parses reorder command", () => {
  const opts = parseManageSubIssuesCliArgs([
    "reorder",
    "--repo",
    "owner/repo",
    "--issue",
    "42",
    "--order",
    "10,11,12",
  ]);
  assert.equal(opts.command, "reorder");
  assert.deepEqual(opts.order, [10, 11, 12]);
});

test("parseManageSubIssuesCliArgs parses verify command with ordered flag", () => {
  const opts = parseManageSubIssuesCliArgs([
    "verify",
    "--repo",
    "owner/repo",
    "--issue",
    "42",
    "--expected",
    "10,11",
    "--ordered",
  ]);
  assert.equal(opts.command, "verify");
  assert.deepEqual(opts.expected, [10, 11]);
  assert.equal(opts.ordered, true);
});

test("parseManageSubIssuesCliArgs rejects unknown command", () => {
  assert.throws(
    () => parseManageSubIssuesCliArgs(["unknown", "--repo", "owner/repo", "--issue", "1"]),
    /Unknown command: unknown/,
  );
});

test("parseManageSubIssuesCliArgs rejects missing --repo", () => {
  assert.throws(
    () => parseManageSubIssuesCliArgs(["list", "--issue", "1"]),
    /--repo.*--issue.*required|Both.*required/i,
  );
});

test("parseManageSubIssuesCliArgs rejects missing --issue", () => {
  assert.throws(
    () => parseManageSubIssuesCliArgs(["list", "--repo", "owner/repo"]),
    /--repo.*--issue.*required|Both.*required/i,
  );
});

test("parseManageSubIssuesCliArgs rejects add without --child", () => {
  assert.throws(
    () => parseManageSubIssuesCliArgs(["add", "--repo", "owner/repo", "--issue", "42"]),
    /--child/i,
  );
});

test("parseManageSubIssuesCliArgs rejects reorder without --order", () => {
  assert.throws(
    () => parseManageSubIssuesCliArgs(["reorder", "--repo", "owner/repo", "--issue", "42"]),
    /--order/i,
  );
});

test("parseManageSubIssuesCliArgs rejects verify without --expected", () => {
  assert.throws(
    () => parseManageSubIssuesCliArgs(["verify", "--repo", "owner/repo", "--issue", "42"]),
    /--expected/i,
  );
});

test("parseManageSubIssuesCliArgs rejects duplicate numbers in --order", () => {
  assert.throws(
    () =>
      parseManageSubIssuesCliArgs([
        "reorder",
        "--repo",
        "owner/repo",
        "--issue",
        "42",
        "--order",
        "10,11,10",
      ]),
    /Duplicate issue number/i,
  );
});

test("parseManageSubIssuesCliArgs rejects zero issue number", () => {
  assert.throws(
    () => parseManageSubIssuesCliArgs(["list", "--repo", "owner/repo", "--issue", "0"]),
    /positive integer/i,
  );
});

test("parseManageSubIssuesCliArgs rejects invalid repo slug", () => {
  assert.throws(
    () => parseManageSubIssuesCliArgs(["list", "--repo", "not-a-valid/slug/extra", "--issue", "1"]),
    /owner\/name/i,
  );
});


test("parseManageSubIssuesCliArgs rejects irrelevant flags for the selected command", () => {
  assert.throws(
    () => parseManageSubIssuesCliArgs(["list", "--repo", "owner/repo", "--issue", "42", "--child", "10"]),
    /does not accept --child/i,
  );

  assert.throws(
    () => parseManageSubIssuesCliArgs(["add", "--repo", "owner/repo", "--issue", "42", "--child", "10", "--order", "10,11"]),
    /does not accept --order/i,
  );

  assert.throws(
    () => parseManageSubIssuesCliArgs(["verify", "--repo", "owner/repo", "--issue", "42", "--expected", "10,11", "--child", "10"]),
    /does not accept --child/i,
  );
});

// ─── computeVerifyResult unit tests ──────────────────────────────────────────

test("computeVerifyResult returns verified:true when sets match (unordered)", () => {
  const result = computeVerifyResult({
    repo: "owner/repo",
    issue: 42,
    expected: [10, 11, 12],
    ordered: false,
    subIssues: [
      { number: 10, title: "A", state: "open", id: 1001 },
      { number: 12, title: "C", state: "open", id: 1003 },
      { number: 11, title: "B", state: "open", id: 1002 },
    ],
  });

  assert.equal(result.verified, true);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.unexpected, []);
  assert.equal("orderMismatch" in result, false);
});

test("computeVerifyResult returns verified:false when a sub-issue is missing", () => {
  const result = computeVerifyResult({
    repo: "owner/repo",
    issue: 42,
    expected: [10, 11, 12],
    ordered: false,
    subIssues: [
      { number: 10, title: "A", state: "open", id: 1001 },
      { number: 12, title: "C", state: "open", id: 1003 },
    ],
  });

  assert.equal(result.verified, false);
  assert.deepEqual(result.missing, [11]);
  assert.deepEqual(result.unexpected, []);
});

test("computeVerifyResult returns verified:false when an unexpected sub-issue is present", () => {
  const result = computeVerifyResult({
    repo: "owner/repo",
    issue: 42,
    expected: [10, 11],
    ordered: false,
    subIssues: [
      { number: 10, title: "A", state: "open", id: 1001 },
      { number: 11, title: "B", state: "open", id: 1002 },
      { number: 99, title: "X", state: "open", id: 1099 },
    ],
  });

  assert.equal(result.verified, false);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.unexpected, [99]);
});


test("computeVerifyResult reports duplicate actual sub-issues as unexpected", () => {
  const result = computeVerifyResult({
    repo: "owner/repo",
    issue: 42,
    expected: [10, 11],
    ordered: false,
    subIssues: [
      { number: 10, title: "A", state: "open", id: 1001 },
      { number: 11, title: "B", state: "open", id: 1002 },
      { number: 11, title: "B duplicate", state: "open", id: 1003 },
    ],
  });

  assert.equal(result.verified, false);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.unexpected, [11]);
});

test("computeVerifyResult with --ordered: verified:false when order is wrong", () => {
  const result = computeVerifyResult({
    repo: "owner/repo",
    issue: 42,
    expected: [10, 11, 12],
    ordered: true,
    subIssues: [
      { number: 11, title: "B", state: "open", id: 1002 },
      { number: 10, title: "A", state: "open", id: 1001 },
      { number: 12, title: "C", state: "open", id: 1003 },
    ],
  });

  assert.equal(result.verified, false);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.unexpected, []);
  assert.equal(result.orderMismatch, true);
});

test("computeVerifyResult with --ordered: verified:true when sets match and order matches", () => {
  const result = computeVerifyResult({
    repo: "owner/repo",
    issue: 42,
    expected: [10, 11, 12],
    ordered: true,
    subIssues: [
      { number: 10, title: "A", state: "open", id: 1001 },
      { number: 11, title: "B", state: "open", id: 1002 },
      { number: 12, title: "C", state: "open", id: 1003 },
    ],
  });

  assert.equal(result.verified, true);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.unexpected, []);
  assert.equal("orderMismatch" in result, false);
});

// ─── CLI integration tests ────────────────────────────────────────────────────

test("manage-sub-issues list returns sub-issues from API", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-manage-sub-issues-list-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "repos/owner/repo/issues/42/sub_issues"],
        stdout: subIssuePayload([
          { id: 1001, number: 10, title: "Slice A", state: "open" },
          { id: 1002, number: 11, title: "Slice B", state: "closed" },
        ]),
      },
    ]);

    const result = await runNode(["list", "--repo", "owner/repo", "--issue", "42"], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.command, "list");
    assert.equal(parsed.repo, "owner/repo");
    assert.equal(parsed.issue, 42);
    assert.deepEqual(parsed.subIssues, [
      { id: 1001, number: 10, title: "Slice A", state: "open" },
      { id: 1002, number: 11, title: "Slice B", state: "closed" },
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("manage-sub-issues list drops entries with unsupported states", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-manage-sub-issues-bad-state-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "repos/owner/repo/issues/42/sub_issues"],
        stdout: subIssuePayload([
          { id: 1001, number: 10, title: "Slice A", state: "open" },
          { id: 1002, number: 11, title: "Slice B", state: "draft" },
        ]),
      },
    ]);

    const result = await runNode(["list", "--repo", "owner/repo", "--issue", "42"], { env });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    const parsed = JSON.parse(result.stdout);
    assert.deepEqual(parsed.subIssues, [
      { id: 1001, number: 10, title: "Slice A", state: "open" },
    ]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("manage-sub-issues list returns empty array when no sub-issues", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-manage-sub-issues-empty-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "repos/owner/repo/issues/42/sub_issues"],
        stdout: subIssuePayload([]),
      },
    ]);

    const result = await runNode(["list", "--repo", "owner/repo", "--issue", "42"], { env });

    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.subIssues, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("manage-sub-issues add resolves child id and posts to sub_issues endpoint", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-manage-sub-issues-add-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "repos/owner/repo/issues/10"],
        stdout: issuePayload({ id: 5001, number: 10 }),
      },
      {
        assertArgs: [
          "api",
          "-X",
          "POST",
          "repos/owner/repo/issues/42/sub_issues",
          "-F",
          "sub_issue_id=5001",
        ],
        stdout: "",
      },
    ]);

    const result = await runNode(
      ["add", "--repo", "owner/repo", "--issue", "42", "--child", "10"],
      { env },
    );

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.command, "add");
    assert.equal(parsed.issue, 42);
    assert.equal(parsed.child, 10);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("manage-sub-issues reorder sets execution order via sequential PATCH calls", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-manage-sub-issues-reorder-"));

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "repos/owner/repo/issues/42/sub_issues"],
        stdout: subIssuePayload([
          { id: 1001, number: 10, title: "A", state: "open" },
          { id: 1002, number: 11, title: "B", state: "open" },
          { id: 1003, number: 12, title: "C", state: "open" },
        ]),
      },
      {
        assertArgs: [
          "api",
          "-X",
          "PATCH",
          "repos/owner/repo/issues/42/sub_issues/priority",
          "-F",
          "sub_issue_id=1002",
          "-F",
          "after_id=0",
        ],
        stdout: "",
      },
      {
        assertArgs: [
          "api",
          "-X",
          "PATCH",
          "repos/owner/repo/issues/42/sub_issues/priority",
          "-F",
          "sub_issue_id=1003",
          "-F",
          "after_id=1002",
        ],
        stdout: "",
      },
      {
        assertArgs: [
          "api",
          "-X",
          "PATCH",
          "repos/owner/repo/issues/42/sub_issues/priority",
          "-F",
          "sub_issue_id=1001",
          "-F",
          "after_id=1003",
        ],
        stdout: "",
      },
    ]);

    const result = await runNode(
      ["reorder", "--repo", "owner/repo", "--issue", "42", "--order", "11,12,10"],
      { env },
    );

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.command, "reorder");
    assert.deepEqual(parsed.order, [11, 12, 10]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("manage-sub-issues reorder fails when a specified issue is not a sub-issue", async () => {
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), "dev-loops-manage-sub-issues-reorder-fail-"),
  );

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "repos/owner/repo/issues/42/sub_issues"],
        stdout: subIssuePayload([
          { id: 1001, number: 10, title: "A", state: "open" },
          { id: 1002, number: 11, title: "B", state: "open" },
        ]),
      },
    ]);

    const result = await runNode(
      ["reorder", "--repo", "owner/repo", "--issue", "42", "--order", "10,99"],
      { env },
    );

    assert.equal(result.code, 1);
    const parsed = JSON.parse(result.stderr);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /not a sub-issue/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("manage-sub-issues verify returns verified:true when sub-issues match", async () => {
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), "dev-loops-manage-sub-issues-verify-ok-"),
  );

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "repos/owner/repo/issues/42/sub_issues"],
        stdout: subIssuePayload([
          { id: 1001, number: 10, title: "A", state: "open" },
          { id: 1002, number: 11, title: "B", state: "open" },
        ]),
      },
    ]);

    const result = await runNode(
      ["verify", "--repo", "owner/repo", "--issue", "42", "--expected", "10,11"],
      { env },
    );

    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.verified, true);
    assert.deepEqual(parsed.expected, [10, 11]);
    assert.deepEqual(parsed.missing, []);
    assert.deepEqual(parsed.unexpected, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("manage-sub-issues verify returns verified:false with missing and unexpected", async () => {
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), "dev-loops-manage-sub-issues-verify-fail-"),
  );

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "repos/owner/repo/issues/42/sub_issues"],
        stdout: subIssuePayload([
          { id: 1001, number: 10, title: "A", state: "open" },
          { id: 1099, number: 99, title: "X", state: "open" },
        ]),
      },
    ]);

    const result = await runNode(
      ["verify", "--repo", "owner/repo", "--issue", "42", "--expected", "10,11"],
      { env },
    );

    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.verified, false);
    assert.deepEqual(parsed.missing, [11]);
    assert.deepEqual(parsed.unexpected, [99]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("manage-sub-issues verify --ordered detects order mismatch", async () => {
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), "dev-loops-manage-sub-issues-verify-order-"),
  );

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "repos/owner/repo/issues/42/sub_issues"],
        stdout: subIssuePayload([
          { id: 1002, number: 11, title: "B", state: "open" },
          { id: 1001, number: 10, title: "A", state: "open" },
        ]),
      },
    ]);

    const result = await runNode(
      ["verify", "--repo", "owner/repo", "--issue", "42", "--expected", "10,11", "--ordered"],
      { env },
    );

    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.verified, false);
    assert.equal(parsed.orderMismatch, true);
    assert.deepEqual(parsed.missing, []);
    assert.deepEqual(parsed.unexpected, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("manage-sub-issues emits usage error to stderr and exits 1 on bad args", async () => {
  const result = await runNode(["--unknown-flag"]);

  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  const parsed = JSON.parse(result.stderr);
  assert.equal(parsed.ok, false);
  assert.ok(typeof parsed.error === "string" && parsed.error.length > 0);
  assert.ok(typeof parsed.usage === "string" && parsed.usage.length > 0);
});

test("manage-sub-issues prints usage to stdout and exits 0 for --help", async () => {
  const result = await runNode(["--help"]);

  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /manage-sub-issues\.mjs/);
  assert.match(result.stdout, /list|add|reorder|verify/i);
});

test("manage-sub-issues add fails when gh returns an error", async () => {
  const tempDir = await mkdtemp(
    path.join(os.tmpdir(), "dev-loops-manage-sub-issues-add-fail-"),
  );

  try {
    const env = await writeGhStub(tempDir, [
      {
        assertArgs: ["api", "repos/owner/repo/issues/10"],
        stdout: issuePayload({ id: 5001, number: 10 }),
      },
      {
        assertArgs: ["api", "-X", "POST"],
        exitCode: 1,
        stderr: "HTTP 422: Sub-issue already exists\n",
      },
    ]);

    const result = await runNode(
      ["add", "--repo", "owner/repo", "--issue", "42", "--child", "10"],
      { env },
    );

    assert.equal(result.code, 1);
    const parsed = JSON.parse(result.stderr);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /gh api command failed/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
