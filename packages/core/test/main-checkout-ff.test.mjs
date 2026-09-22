import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  buildMainCheckoutNotOnMainDiagnostic,
  buildWorktreeCleanupCommand,
  classifyMainCheckoutRef,
  MAIN_CHECKOUT_FF_FETCH_TIMEOUT_MS,
  MAIN_CHECKOUT_FF_MERGE_TIMEOUT_MS,
  MAIN_CHECKOUT_NOT_ON_MAIN_KIND,
  syncMainCheckout,
  WORKTREE_CLEANUP_TIMEOUT_MS,
} from "../src/loop/main-checkout-ff.mjs";

// --- classifyMainCheckoutRef ---

test("classifyMainCheckoutRef: main", () => {
  assert.equal(classifyMainCheckoutRef("main"), "main");
});

test("classifyMainCheckoutRef: HEAD is detached", () => {
  assert.equal(classifyMainCheckoutRef("HEAD"), "detached");
});

test("classifyMainCheckoutRef: any other branch name", () => {
  assert.equal(classifyMainCheckoutRef("feature/x"), "other_branch");
  assert.equal(classifyMainCheckoutRef("issue-2363"), "other_branch");
});

test("classifyMainCheckoutRef: empty/whitespace/non-string is unreadable", () => {
  assert.equal(classifyMainCheckoutRef(""), "unreadable");
  assert.equal(classifyMainCheckoutRef("   "), "unreadable");
  assert.equal(classifyMainCheckoutRef(null), "unreadable");
  assert.equal(classifyMainCheckoutRef(undefined), "unreadable");
  assert.equal(classifyMainCheckoutRef(42), "unreadable");
});

// --- buildMainCheckoutNotOnMainDiagnostic ---

test("buildMainCheckoutNotOnMainDiagnostic: full fields for a detached checkout", () => {
  const diagnostic = buildMainCheckoutNotOnMainDiagnostic({
    mainCheckout: "/Users/x/dev-loops",
    ref: "detached@abc1234",
    behindCount: 3,
  });
  assert.equal(diagnostic.kind, MAIN_CHECKOUT_NOT_ON_MAIN_KIND);
  assert.equal(diagnostic.severity, "error");
  assert.equal(diagnostic.mainCheckout, "/Users/x/dev-loops");
  assert.equal(diagnostic.ref, "detached@abc1234");
  assert.equal(diagnostic.behindCount, 3);
  assert.equal(typeof diagnostic.message, "string");
  assert.ok(diagnostic.message.includes(MAIN_CHECKOUT_NOT_ON_MAIN_KIND), diagnostic.message);
  assert.ok(diagnostic.message.includes("/Users/x/dev-loops"), diagnostic.message);
  assert.ok(diagnostic.message.includes("detached@abc1234"), diagnostic.message);
  assert.ok(diagnostic.message.includes("3"), diagnostic.message);
  assert.ok(!/\breset\b/i.test(diagnostic.message), diagnostic.message);
  assert.ok(!/--force\b/i.test(diagnostic.message), diagnostic.message);
});

test("buildMainCheckoutNotOnMainDiagnostic: accepts a zero behind count", () => {
  const diagnostic = buildMainCheckoutNotOnMainDiagnostic({
    mainCheckout: "/Users/x/dev-loops",
    ref: "feature/x",
    behindCount: 0,
  });
  assert.equal(diagnostic.behindCount, 0);
  assert.ok(diagnostic.message.includes("feature/x"), diagnostic.message);
  assert.ok(diagnostic.message.includes("0"), diagnostic.message);
});

test("buildMainCheckoutNotOnMainDiagnostic: null when mainCheckout is not absolute", () => {
  assert.equal(
    buildMainCheckoutNotOnMainDiagnostic({ mainCheckout: "relative/path", ref: "feature/x", behindCount: 1 }),
    null,
  );
});

test("buildMainCheckoutNotOnMainDiagnostic: null when mainCheckout is missing", () => {
  assert.equal(
    buildMainCheckoutNotOnMainDiagnostic({ ref: "feature/x", behindCount: 1 }),
    null,
  );
});

test("buildMainCheckoutNotOnMainDiagnostic: null when ref is empty", () => {
  assert.equal(
    buildMainCheckoutNotOnMainDiagnostic({ mainCheckout: "/x", ref: "", behindCount: 1 }),
    null,
  );
});

test("buildMainCheckoutNotOnMainDiagnostic: null when ref is missing", () => {
  assert.equal(
    buildMainCheckoutNotOnMainDiagnostic({ mainCheckout: "/x", behindCount: 1 }),
    null,
  );
});

test("buildMainCheckoutNotOnMainDiagnostic: null when behindCount is not a non-negative integer", () => {
  assert.equal(
    buildMainCheckoutNotOnMainDiagnostic({ mainCheckout: "/x", ref: "feature/x", behindCount: -1 }),
    null,
  );
  assert.equal(
    buildMainCheckoutNotOnMainDiagnostic({ mainCheckout: "/x", ref: "feature/x", behindCount: 1.5 }),
    null,
  );
  assert.equal(
    buildMainCheckoutNotOnMainDiagnostic({ mainCheckout: "/x", ref: "feature/x", behindCount: "3" }),
    null,
  );
  assert.equal(
    buildMainCheckoutNotOnMainDiagnostic({ mainCheckout: "/x", ref: "feature/x" }),
    null,
  );
});

// --- syncMainCheckout ---

function recordingRun(handlers) {
  const calls = [];
  const run = async (command) => {
    calls.push(command);
    for (const [matcher, respond] of handlers) {
      const matches = typeof matcher === "string" ? command === matcher : matcher.test(command);
      if (matches) {
        return respond(command);
      }
    }
    throw new Error(`recordingRun: no handler matched command: ${command}`);
  };
  return { run, calls };
}

const ok = (stdout = "") => ({ ok: true, stdout, reason: "" });
const fail = (reason) => ({ ok: false, stdout: "", reason });

function assertNoMutatingCommand(calls) {
  for (const command of calls) {
    assert.ok(!/\bmerge\b/.test(command), `command must not merge: ${command}`);
    assert.ok(!/\bswitch\b/.test(command), `command must not switch: ${command}`);
    assert.ok(!/\bcheckout\b/.test(command), `command must not checkout: ${command}`);
    assert.ok(!/\breset\b/.test(command), `command must not reset: ${command}`);
  }
}

test("syncMainCheckout: on main and fast-forwardable", async () => {
  const { run, calls } = recordingRun([
    [/fetch origin main$/, () => ok()],
    [/rev-parse --abbrev-ref HEAD$/, () => ok("main\n")],
    [/merge --ff-only origin\/main$/, () => ok()],
  ]);
  const result = await syncMainCheckout("/m", run);
  assert.deepEqual(result, { status: "fast_forwarded" });
  assert.equal(calls.length, 3);
});

test("syncMainCheckout: on main but diverged (merge --ff-only fails) is skipped", async () => {
  const { run } = recordingRun([
    [/fetch origin main$/, () => ok()],
    [/rev-parse --abbrev-ref HEAD$/, () => ok("main\n")],
    [/merge --ff-only origin\/main$/, () => fail("Not possible to fast-forward")],
  ]);
  const result = await syncMainCheckout("/m", run);
  assert.deepEqual(result, { status: "skipped", reason: "Not possible to fast-forward" });
});

test("syncMainCheckout: fetch failure is skipped, no further commands", async () => {
  const { run, calls } = recordingRun([
    [/fetch origin main$/, () => fail("could not resolve host")],
  ]);
  const result = await syncMainCheckout("/m", run);
  assert.deepEqual(result, { status: "skipped", reason: "could not resolve host" });
  assert.equal(calls.length, 1);
  assertNoMutatingCommand(calls);
});

test("syncMainCheckout: rev-parse failure is skipped", async () => {
  const { run } = recordingRun([
    [/fetch origin main$/, () => ok()],
    [/rev-parse --abbrev-ref HEAD$/, () => fail("not a git repository")],
  ]);
  const result = await syncMainCheckout("/m", run);
  assert.deepEqual(result, { status: "skipped", reason: "not a git repository" });
});

test("syncMainCheckout: empty/unreadable ref is skipped", async () => {
  const { run, calls } = recordingRun([
    [/fetch origin main$/, () => ok()],
    [/rev-parse --abbrev-ref HEAD$/, () => ok("   \n")],
  ]);
  const result = await syncMainCheckout("/m", run);
  assert.equal(result.status, "skipped");
  assertNoMutatingCommand(calls);
});

test("syncMainCheckout: detached HEAD reports the not_on_main diagnostic", async () => {
  const { run, calls } = recordingRun([
    [/fetch origin main$/, () => ok()],
    [/rev-parse --abbrev-ref HEAD$/, () => ok("HEAD\n")],
    [/rev-parse --short HEAD$/, () => ok("abc1234\n")],
    [/rev-list --count HEAD\.\.origin\/main$/, () => ok("6\n")],
  ]);
  const result = await syncMainCheckout("/m", run);
  assert.equal(result.status, "not_on_main");
  assert.equal(result.diagnostic.kind, MAIN_CHECKOUT_NOT_ON_MAIN_KIND);
  assert.equal(result.diagnostic.severity, "error");
  assert.equal(result.diagnostic.ref, "detached@abc1234");
  assert.equal(result.diagnostic.behindCount, 6);
  assert.equal(result.diagnostic.mainCheckout, "/m");
  assertNoMutatingCommand(calls);
});

test("syncMainCheckout: other named branch reports the not_on_main diagnostic", async () => {
  const { run, calls } = recordingRun([
    [/fetch origin main$/, () => ok()],
    [/rev-parse --abbrev-ref HEAD$/, () => ok("feature/x\n")],
    [/rev-list --count HEAD\.\.origin\/main$/, () => ok("0\n")],
  ]);
  const result = await syncMainCheckout("/m", run);
  assert.equal(result.status, "not_on_main");
  assert.equal(result.diagnostic.ref, "feature/x");
  assert.equal(result.diagnostic.behindCount, 0);
  assertNoMutatingCommand(calls);
});

test("syncMainCheckout: detached HEAD short-sha failure is skipped", async () => {
  const { run, calls } = recordingRun([
    [/fetch origin main$/, () => ok()],
    [/rev-parse --abbrev-ref HEAD$/, () => ok("HEAD\n")],
    [/rev-parse --short HEAD$/, () => fail("ambiguous HEAD")],
  ]);
  const result = await syncMainCheckout("/m", run);
  assert.equal(result.status, "skipped");
  assertNoMutatingCommand(calls);
});

test("syncMainCheckout: detached HEAD empty short-sha is skipped", async () => {
  const { run } = recordingRun([
    [/fetch origin main$/, () => ok()],
    [/rev-parse --abbrev-ref HEAD$/, () => ok("HEAD\n")],
    [/rev-parse --short HEAD$/, () => ok("  \n")],
  ]);
  const result = await syncMainCheckout("/m", run);
  assert.equal(result.status, "skipped");
});

test("syncMainCheckout: behind-count failure is skipped", async () => {
  const { run } = recordingRun([
    [/fetch origin main$/, () => ok()],
    [/rev-parse --abbrev-ref HEAD$/, () => ok("feature/x\n")],
    [/rev-list --count HEAD\.\.origin\/main$/, () => fail("bad revision")],
  ]);
  const result = await syncMainCheckout("/m", run);
  assert.deepEqual(result, { status: "skipped", reason: "bad revision" });
});

test("syncMainCheckout: non-numeric behind-count stdout is skipped", async () => {
  const { run } = recordingRun([
    [/fetch origin main$/, () => ok()],
    [/rev-parse --abbrev-ref HEAD$/, () => ok("feature/x\n")],
    [/rev-list --count HEAD\.\.origin\/main$/, () => ok("not-a-number\n")],
  ]);
  const result = await syncMainCheckout("/m", run);
  assert.equal(result.status, "skipped");
});

test("syncMainCheckout: a thrown run() is treated as a failed step", async () => {
  const run = async () => {
    throw new Error("spawn ENOENT");
  };
  const result = await syncMainCheckout("/m", run);
  assert.deepEqual(result, { status: "skipped", reason: "spawn ENOENT" });
});

test("syncMainCheckout: every step command POSIX single-quotes a path with a space and a quote", async () => {
  const path = "/Users/My 'User'/dev-loops";
  const { run, calls } = recordingRun([
    [/fetch origin main$/, () => ok()],
    [/rev-parse --abbrev-ref HEAD$/, () => ok("HEAD\n")],
    [/rev-parse --short HEAD$/, () => ok("abc1234\n")],
    [/rev-list --count HEAD\.\.origin\/main$/, () => ok("1\n")],
  ]);
  await syncMainCheckout(path, run);
  const quoted = "'/Users/My '\\''User'\\''/dev-loops'";
  assert.ok(calls.length > 0);
  for (const command of calls) {
    assert.ok(command.includes(`-C ${quoted} `), `expected quoted path in command: ${command}`);
  }
});

test("the ff timeouts are finite numbers", () => {
  assert.equal(Number.isFinite(MAIN_CHECKOUT_FF_FETCH_TIMEOUT_MS), true);
  assert.equal(Number.isFinite(MAIN_CHECKOUT_FF_MERGE_TIMEOUT_MS), true);
  assert.ok(MAIN_CHECKOUT_FF_FETCH_TIMEOUT_MS > 0);
  assert.ok(MAIN_CHECKOUT_FF_MERGE_TIMEOUT_MS > 0);
});

test("buildWorktreeCleanupCommand: runs cleanup-worktree.mjs from the main checkout for the PR", () => {
  const cmd = buildWorktreeCleanupCommand("/Users/My User/dev-loops", "1234");
  // Runs from the main checkout (hook cwd can be inside the worktree being removed).
  assert.ok(cmd.includes("node '/Users/My User/dev-loops/scripts/loop/cleanup-worktree.mjs'"), cmd);
  assert.ok(cmd.includes("--repo-root '/Users/My User/dev-loops'"), cmd);
  assert.ok(cmd.includes('--pr "1234"'), cmd);
  // Non-fatal: a failure must not break the merge-completion flow.
  assert.ok(cmd.includes("|| true"), cmd);
  // Consumer no-op when the checkout lacks the dev-loops cleanup script.
  assert.ok(cmd.includes("if [ -f '"), cmd);
});

test("buildWorktreeCleanupCommand: returns empty string when no PR number", () => {
  assert.equal(buildWorktreeCleanupCommand("/Users/x/dev-loops"), "");
  assert.equal(buildWorktreeCleanupCommand("/Users/x/dev-loops", null), "");
  assert.equal(buildWorktreeCleanupCommand("/Users/x/dev-loops", "  "), "");
});

test("WORKTREE_CLEANUP_TIMEOUT_MS is a positive finite number", () => {
  assert.equal(Number.isFinite(WORKTREE_CLEANUP_TIMEOUT_MS), true);
  assert.ok(WORKTREE_CLEANUP_TIMEOUT_MS > 0);
});
