// CLI-CHECKOUT-DELEGATION: an installed CLI runs the source checkout's CLI for gate, loop and pr.
import { afterAll, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { findSkewedCheckout, runCli } from "../cli/index.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmpRoots = [];
afterAll(() => { for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true }); });

function makeCheckout(entrySource) {
  const root = mkdtempSync(path.join(tmpdir(), "devloops-delegation-"));
  tmpRoots.push(root);
  mkdirSync(path.join(root, "cli"));
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "dev-loops", version: "9.9.9" }));
  writeFileSync(path.join(root, "cli/index.mjs"), entrySource);
  return root;
}

const ECHO_ENTRY = `
console.log(JSON.stringify({ argv: process.argv.slice(2), delegated: process.env.DEVLOOPS_CHECKOUT_DELEGATED === "1" }));
`;

function collector() {
  let text = "";
  return { write: (chunk) => { text += chunk; }, get text() { return text; } };
}

async function run(argv, cwd, extra = {}) {
  const stdout = collector();
  const stderr = collector();
  const code = await runCli({ argv, cwd, stdout, stderr, env: {}, ...extra });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

test("loop startup delegates to the checkout and names both versions", async () => {
  const root = makeCheckout(ECHO_ENTRY);
  const result = await run(["loop", "startup", "--issue", "1"], root);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), { argv: ["loop", "startup", "--issue", "1"], delegated: true });
  assert.match(result.stderr, /version skew: installed \S+, checkout 9\.9\.9;/);
  assert.match(result.stderr, /CLI-CHECKOUT-DELEGATION/);
});

test("a flag the installed CLI would not know reaches the checkout unchanged", async () => {
  const root = makeCheckout(ECHO_ENTRY);
  const result = await run(["loop", "pre-push-delta", "--site-coverage", "x"], root);
  assert.deepEqual(JSON.parse(result.stdout).argv, ["loop", "pre-push-delta", "--site-coverage", "x"]);
});

test("gate and pr categories delegate", async () => {
  const root = makeCheckout(ECHO_ENTRY);
  for (const argv of [["gate", "consolidate-fanin"], ["pr", "ready-for-review"]]) {
    const result = await run(argv, root);
    assert.deepEqual(JSON.parse(result.stdout), { argv, delegated: true });
  }
});

test("a nested working directory finds the checkout", async () => {
  const root = makeCheckout(ECHO_ENTRY);
  const nested = path.join(root, "a/b");
  mkdirSync(nested, { recursive: true });
  const result = await run(["loop", "startup"], nested);
  assert.equal(JSON.parse(result.stdout).delegated, true);
});

test("other categories are not delegated", async () => {
  const root = makeCheckout(ECHO_ENTRY);
  const result = await run(["--version"], root);
  assert.match(result.stdout, /^dev-loops /);
  assert.equal(result.stderr, "");
});

test("DEVLOOPS_CHECKOUT_DELEGATED skips delegation", async () => {
  const root = makeCheckout(ECHO_ENTRY);
  const result = await run(["loop"], root, { env: { DEVLOOPS_CHECKOUT_DELEGATED: "1" } });
  assert.doesNotMatch(result.stdout, /"delegated"/);
  assert.doesNotMatch(result.stderr, /CLI-CHECKOUT-DELEGATION/);
});

test("the running checkout does not delegate to itself", () => {
  assert.equal(findSkewedCheckout(REPO_ROOT), null);
  assert.equal(findSkewedCheckout(path.join(REPO_ROOT, "cli")), null);
});

test("the checkout exit status is returned", async () => {
  const root = makeCheckout(`process.exit(7);`);
  assert.equal((await run(["pr", "x"], root)).code, 7);
});

test("a checkout CLI that cannot run names the rerun command", async () => {
  const root = makeCheckout(ECHO_ENTRY);
  const result = await run(["loop", "startup"], root, { spawnMaxBuffer: 1 });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /cli_version_skew: installed \S+, checkout 9\.9\.9; the checkout CLI did not start/);
  assert.match(result.stderr, /Rerun: dev-loops-run --repo-root .+ cli\/index\.mjs loop startup/);
});
