// #2123: the generated `.claude` plugin ships without `scripts/`, `packages/core`, or
// `node_modules`. Bare `node scripts/…` and `dev-loops <ns> …` invocations in generated
// skill/command/agent bodies do not resolve on a plugin-only install and silently fail. This
// unit-tests the pure mechanical rewrite that routes both forms through the resolver launcher
// (`.claude/bin/dev-loops-run`), byte-identical on args, leaving prose and the already-pinned
// `npx dev-loops@<version>` CLI form untouched.
import assert from "node:assert/strict";
import { test } from "bun:test";

import { WRAPPER_LAUNCHER, rewriteWrapperInvocation } from "../../packages/core/src/claude/asset-generation.mjs";

test("WRAPPER_LAUNCHER is the fixed launcher name the launcher file must equal", () => {
  assert.equal(WRAPPER_LAUNCHER, "dev-loops-run");
});

test("rewrites the `node scripts/…mjs` form to `dev-loops-run scripts/…mjs`, args byte-identical", () => {
  const body = "Run `node scripts/loop/watch-cycle.mjs --pr 5 --strict`.";
  const out = rewriteWrapperInvocation(body);
  assert.equal(out, "Run `dev-loops-run scripts/loop/watch-cycle.mjs --pr 5 --strict`.");
});

test("rewrites the `dev-loops <ns> <sub>` CLI form to `dev-loops-run cli/index.mjs <ns> <sub>`, args byte-identical", () => {
  const body = "Run `dev-loops gate judge-pass --pr 5` then `dev-loops queue ensure`.";
  const out = rewriteWrapperInvocation(body);
  assert.equal(
    out,
    "Run `dev-loops-run cli/index.mjs gate judge-pass --pr 5` then `dev-loops-run cli/index.mjs queue ensure`.",
  );
});

test("every real CLI namespace is routed", () => {
  for (const ns of ["gate", "loop", "pr", "issue", "queue", "project", "inspect", "refine"]) {
    const out = rewriteWrapperInvocation(`dev-loops ${ns} sub-command`);
    assert.equal(out, `dev-loops-run cli/index.mjs ${ns} sub-command`);
  }
});

test("rewrites a nested (multi-level) scripts/ path, not just one subdirectory level", () => {
  const body = "Run `node scripts/loop/inspect-run-viewer/foo.mjs --pr 5`.";
  const out = rewriteWrapperInvocation(body);
  assert.equal(out, "Run `dev-loops-run scripts/loop/inspect-run-viewer/foo.mjs --pr 5`.");
});

test("prose mentions of the CLI namespace are left untouched (no trailing lowercase subcommand)", () => {
  const cases = [
    "Do not confuse with any dev-loops gate.",
    "…dev-loops gate — it never satisfies the check.",
    "Use `dev-loops queue` for queue helpers.",
    "See the dev-loops repo layout.",
    "Read the dev-loops CLI docs.",
  ];
  for (const body of cases) {
    assert.equal(rewriteWrapperInvocation(body), body, body);
  }
});

test("the already-pinned npx CLI form is left untouched", () => {
  const body = "Run `npx dev-loops@1.0.2 loop watch-cycle --pr 5`.";
  assert.equal(rewriteWrapperInvocation(body), body);
});

test("idempotent: re-running on already-rewritten output is a no-op", () => {
  const body = "Run `node scripts/loop/watch-cycle.mjs --pr 5` and `dev-loops gate judge-pass --pr 5`.";
  const once = rewriteWrapperInvocation(body);
  const twice = rewriteWrapperInvocation(once);
  assert.equal(twice, once);
});

test("accepts a custom launcher name", () => {
  const body = "Run `node scripts/loop/watch-cycle.mjs` and `dev-loops gate judge-pass`.";
  const out = rewriteWrapperInvocation(body, "custom-run");
  assert.equal(out, "Run `custom-run scripts/loop/watch-cycle.mjs` and `custom-run cli/index.mjs gate judge-pass`.");
});

// #2123: a source-authored invocation line-wrapped between `node` and `scripts/` (prose reflow,
// `node` ending one line and `scripts/…mjs` beginning the next) must still route — a single-space
// pattern left it bare on a plugin-only install and the guard passed falsely.
test("routes an invocation wrapped across a newline between `node` and `scripts/`", () => {
  const body = "then `node\n   scripts/github/upsert-checkpoint-verdict.mjs --repo <owner/repo>`";
  const out = rewriteWrapperInvocation(body);
  assert.equal(out, "then `dev-loops-run scripts/github/upsert-checkpoint-verdict.mjs --repo <owner/repo>`");
});
