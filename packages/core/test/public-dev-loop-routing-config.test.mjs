import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEV_LOOP_GATE,
  DEV_LOOP_PUBLIC_INTENT,
  DEV_LOOP_ROUTE_KIND,
  DEV_LOOP_TARGET_KIND,
  DEV_LOOP_TARGET_PREFERENCE,
} from "../src/loop/public-dev-loop-routing-contract.mjs";

const ROUTING_MODULE_URL = new URL("../src/loop/public-dev-loop-routing.mjs", import.meta.url);

let routingModuleVersion = 0;

async function withTempRepo(fn) {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "public-routing-config-"));
  try {
    await fn(repoRoot);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}

async function writeDefaultsConfig(repoRoot, config) {
  const configDir = path.join(repoRoot, ".pi", "dev-loop");
  await mkdir(configDir, { recursive: true });
  await writeFile(path.join(configDir, "defaults.json"), JSON.stringify(config));
}

async function loadRoutingModuleForRepo(repoRoot) {
  const priorCwd = process.cwd();

  process.chdir(repoRoot);
  try {
    const version = routingModuleVersion += 1;
    const routing = await import(`${ROUTING_MODULE_URL.href}?config-test=${version}`);
    return { routing };
  } finally {
    process.chdir(priorCwd);
  }
}

test("built-in default is local-first and routes to local_implementation", async () => {
  await withTempRepo(async (repoRoot) => {
    const { routing } = await loadRoutingModuleForRepo(repoRoot);
    const result = routing.evaluatePublicDevLoopRouting({
      intent: DEV_LOOP_PUBLIC_INTENT.START_ON_ISSUE,
      target: { kind: DEV_LOOP_TARGET_KIND.ISSUE, issue: 86 },
    });
    assert.equal(result.selectedStrategy, "local_implementation");
  });
});

test("explicit prefer_github_first targetPreference routes correctly", async () => {
  const { routing } = await loadRoutingModuleForRepo(process.cwd());
  const result = routing.evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.START_ON_ISSUE,
    target: { kind: DEV_LOOP_TARGET_KIND.ISSUE, issue: 86 },
    targetPreference: DEV_LOOP_TARGET_PREFERENCE.PREFER_GITHUB_FIRST,
  });
  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.ROUTE);
  assert.equal(result.selectedGate, DEV_LOOP_GATE.ISSUE_INTAKE);
  assert.equal(result.selectedStrategy, "issue_intake");
});

test("explicit prefer_local targetPreference routes locally", async () => {
  const { routing } = await loadRoutingModuleForRepo(process.cwd());
  const result = routing.evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.START_ON_ISSUE,
    target: { kind: DEV_LOOP_TARGET_KIND.ISSUE, issue: 86 },
    targetPreference: DEV_LOOP_TARGET_PREFERENCE.PREFER_LOCAL,
  });
  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.ROUTE);
  assert.equal(result.selectedGate, DEV_LOOP_GATE.LOCAL_IMPLEMENTATION);
  assert.equal(result.selectedStrategy, "local_implementation");
});

test("explicit prefer_local routes start_on_issue with linked PR through github-first path", async () => {
  const { routing } = await loadRoutingModuleForRepo(process.cwd());
  const result = routing.evaluatePublicDevLoopRouting({
    intent: DEV_LOOP_PUBLIC_INTENT.START_ON_ISSUE,
    target: { kind: DEV_LOOP_TARGET_KIND.ISSUE, issue: 86 },
    targetPreference: DEV_LOOP_TARGET_PREFERENCE.PREFER_LOCAL,
    issueLinkageResolution: "resolved_linked_pr",
  });
  assert.equal(result.routeKind, DEV_LOOP_ROUTE_KIND.ROUTE);
  assert.equal(result.selectedGate, DEV_LOOP_GATE.LOCAL_IMPLEMENTATION);
  assert.equal(result.selectedStrategy, "local_implementation");
});
