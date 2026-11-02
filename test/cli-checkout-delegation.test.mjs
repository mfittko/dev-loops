// CLI-CHECKOUT-DELEGATION: an installed CLI runs the source checkout's CLI for gate, loop and pr.
import { afterAll, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { delegationStdio, findSkewedCheckout, runCli, withSigintGuard } from "../cli/index.mjs";
import { checkoutDelegationRefusal } from "../scripts/lib/checkout-delegation-refusal.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmpRoots = [];
afterAll(() => { for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true }); });

function makeCheckout(entrySource, version = "9.9.9") {
  const root = mkdtempSync(path.join(tmpdir(), "devloops-delegation-"));
  tmpRoots.push(root);
  mkdirSync(path.join(root, "cli"));
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "dev-loops", version }));
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
  const result = await run(["loop", "startup"], root, { execPath: "/nonexistent/node" });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /cli_version_skew: installed \S+, checkout 9\.9\.9; the checkout CLI did not start/);
  assert.match(result.stderr, /Rerun: dev-loops-run --repo-root .+ cli\/index\.mjs loop startup/);
});

test("rerun hint quotes args with spaces", async () => {
  const root = makeCheckout(ECHO_ENTRY);
  const result = await run(["loop", "startup", "--note", "a b"], root, { execPath: "/nonexistent/node" });
  assert.match(result.stderr, /--note 'a b'/);
});

test("rerun hint is shell-safe for the root and every argument", () => {
  const hint = (root, argv) => checkoutDelegationRefusal({ installed: "1", checkoutVersion: "2", root, code: "ENOENT", argv });
  assert.match(hint("/a/b/dev-loops", ["startup", "--issue=1"]), /--repo-root \/a\/b\/dev-loops cli\/index\.mjs startup --issue=1$/);
  assert.match(hint("/Users/a/My Repos/dev-loops", []), /--repo-root '\/Users\/a\/My Repos\/dev-loops' cli/);
  assert.match(hint("/r", ["$(id)", "cost $5", "`id`"]), / '\$\(id\)' 'cost \$5' '`id`'$/);
  assert.match(hint("/r", ["it's"]), / 'it'\\''s'$/);
  assert.match(hint("/r", [""]), / ''$/);
});

test("equal installed and checkout versions delegate without a skew notice", async () => {
  const { version } = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  const root = makeCheckout(ECHO_ENTRY, version);
  const result = await run(["loop", "startup"], root);
  assert.equal(JSON.parse(result.stdout).delegated, true);
  assert.doesNotMatch(result.stderr, /version skew/);
});

test("findSkewedCheckout walks past an incomplete or malformed inner package.json", () => {
  const outer = makeCheckout(ECHO_ENTRY);
  const noCli = path.join(outer, "a");
  const malformed = path.join(noCli, "b");
  mkdirSync(malformed, { recursive: true });
  writeFileSync(path.join(noCli, "package.json"), JSON.stringify({ name: "dev-loops", version: "1.0.0" }));
  writeFileSync(path.join(malformed, "package.json"), "{ not json");
  assert.equal(findSkewedCheckout(malformed)?.root, realpathSync(outer));
});

test("inherited delegation registers a SIGINT listener only during the spawn", () => {
  const before = process.listenerCount("SIGINT");
  let during = null;
  withSigintGuard("inherit", () => { during = process.listenerCount("SIGINT"); });
  assert.equal(during, before + 1);
  assert.equal(process.listenerCount("SIGINT"), before);
  withSigintGuard(["ignore", "pipe", "pipe"], () => { during = process.listenerCount("SIGINT"); });
  assert.equal(during, before);
});

test("checkout output over the buffer is child_output_too_large without a rerun hint", async () => {
  const root = makeCheckout(ECHO_ENTRY);
  const result = await run(["loop", "startup"], root, { spawnMaxBuffer: 1 });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /child_output_too_large/);
  assert.doesNotMatch(result.stderr, /Rerun/);
});

test("delegation inherits stdio only for the real process streams", () => {
  assert.equal(delegationStdio(process.stdout, process.stderr), "inherit");
  assert.deepEqual(delegationStdio(collector(), process.stderr), ["ignore", "pipe", "pipe"]);
});

test("the delegation guard is removed from process.env but still skips delegation", async () => {
  const root = makeCheckout(ECHO_ENTRY);
  process.env.DEVLOOPS_CHECKOUT_DELEGATED = "1";
  const stdout = collector();
  await runCli({ argv: ["--version"], cwd: root, stdout, stderr: collector() });
  assert.equal(process.env.DEVLOOPS_CHECKOUT_DELEGATED, undefined);
  process.env.DEVLOOPS_CHECKOUT_DELEGATED = "1";
  const out = collector();
  await runCli({ argv: ["loop"], cwd: root, stdout: out, stderr: collector() });
  assert.doesNotMatch(out.text, /"delegated"/);
  assert.equal(process.env.DEVLOOPS_CHECKOUT_DELEGATED, undefined);
});
