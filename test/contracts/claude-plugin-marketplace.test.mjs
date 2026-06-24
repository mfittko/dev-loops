import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// #828: the repo ships a Claude Code marketplace CATALOG at the repo root
// (`.claude-plugin/marketplace.json`) — distinct from the plugin MANIFEST at
// `.claude/.claude-plugin/plugin.json`. The catalog is what `/plugin marketplace add
// mfittko/dev-loops` reads; its single plugin entry sources the in-repo plugin at `./.claude`.
// Verified end-to-end with `claude plugin validate` + `marketplace add`/`install`.

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const marketplacePath = path.join(repoRoot, ".claude-plugin", "marketplace.json");

test("marketplace catalog exists and names the dev-loops marketplace", async () => {
  const catalog = JSON.parse(await readFile(marketplacePath, "utf8"));
  assert.equal(catalog.name, "dev-loops");
  assert.ok(
    catalog.owner && typeof catalog.owner === "object" && typeof catalog.owner.name === "string",
    "owner must be an object with a name (not a string) per the marketplace schema",
  );
  assert.ok(Array.isArray(catalog.plugins) && catalog.plugins.length === 1, "exactly one plugin entry");
});

test("the plugin entry sources the in-repo plugin at ./.claude", async () => {
  const catalog = JSON.parse(await readFile(marketplacePath, "utf8"));
  const entry = catalog.plugins[0];
  assert.equal(entry.name, "dev-loops");
  assert.equal(entry.source, "./.claude", "source must point at the plugin dir (the one holding .claude-plugin/)");
  assert.equal(entry.source.includes(".."), false, "source must not contain path traversal");
  // The source dir must actually contain a plugin manifest.
  assert.ok(
    existsSync(path.join(repoRoot, ".claude", ".claude-plugin", "plugin.json")),
    "source ./.claude must contain .claude-plugin/plugin.json",
  );
});

test("the catalog defers versioning to plugin.json (no entry-level version to drift)", async () => {
  const catalog = JSON.parse(await readFile(marketplacePath, "utf8"));
  const entry = catalog.plugins[0];
  assert.equal(
    "version" in entry,
    false,
    "do not pin a version in the catalog entry — plugin.json is the single authoritative source",
  );
  // Catalog plugin name and manifest plugin name must agree.
  const manifest = JSON.parse(await readFile(path.join(repoRoot, ".claude", ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(entry.name, manifest.name, "catalog entry name must match plugin.json name");
});

test("the publish files allowlist ships the marketplace catalog", async () => {
  const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  assert.ok(pkg.files.includes(".claude-plugin/"), "files allowlist must include .claude-plugin/");
});
