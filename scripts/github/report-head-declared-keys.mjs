#!/usr/bin/env node
// Reports the dotted config key paths a PR head's OWN schema accepts in its own
// `.devloops` (docs/decisions/0234). Runs in the credential-less
// `head-declared-keys` job of .github/workflows/gate-evidence.yml. Its stdout is
// treated as data by the trusted detector. Fails closed: any problem prints an
// empty set and exits 0.
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

function collectKeyPaths(value, prefix, out) {
  // Arrays recurse with the numeric index as the path segment, matching the zod issue path of the base schema.
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const keyPath = prefix ? `${prefix}.${key}` : key;
    out.push(keyPath);
    collectKeyPaths(child, keyPath, out);
  }
}

export async function reportHeadDeclaredKeys(headRoot) {
  try {
    const root = path.resolve(headRoot);
    // The HEAD's own schema decides what it declares; no export added by this fix is required.
    const { loadDevLoopConfig } = await import(pathToFileURL(path.join(root, "packages/core/src/config/config.mjs")).href);
    const { errors = [] } = await loadDevLoopConfig({ repoRoot: root });
    if (errors.some((e) => e.layer === "devloops" || e.layer === "merged")) return [];
    const file = ["", ".yaml", ".yml", ".json"].map((ext) => path.join(root, `.devloops${ext}`)).find((p) => existsSync(p));
    if (!file) return [];
    const { parse } = createRequire(path.join(root, "package.json"))("yaml");
    const keys = [];
    collectKeyPaths(parse(readFileSync(file, "utf8")), "", keys);
    return keys;
  } catch {
    return [];
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { "head-root": { type: "string" } }, strict: false });
  const declaredKeys = values["head-root"] ? await reportHeadDeclaredKeys(values["head-root"]) : [];
  console.log(JSON.stringify({ declaredKeys }));
}
