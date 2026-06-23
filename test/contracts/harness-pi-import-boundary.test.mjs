import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// CA1 (#770) import boundary. The seam this slice introduces covers the *neutral extension
// runtime* (`extension/`) and the *core harness* (`packages/core/src/harness`): within those
// trees only the dedicated Pi adapter module (`extension/pi-extension-adapter.ts`) may import
// `@earendil-works/pi-*`. Everything else there must talk to the neutral seam.
//
// Out of scope by design: `.pi/extensions/` holds standalone Pi-native extensions (e.g.
// `dev-loop-behavioral-review.ts`) that are inherently coupled to the Pi harness and are not
// part of the neutral runtime — they are intentionally NOT covered by this boundary.
// peerDependencies in package.json are not source imports and are exempt.

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

const SCAN_DIRS = ["extension", "packages/core/src/harness"];
const ALLOWED = new Set([path.join("extension", "pi-extension-adapter.ts")]);

// Detect a real ESM import of `@earendil-works/pi-*`, covering all three forms:
//   static:       import ... from '@earendil-works/pi-x'
//   side-effect:  import '@earendil-works/pi-x'
//   dynamic:      import('@earendil-works/pi-x')
// Requires the `import`/`from` keyword immediately before the specifier so prose mentions
// of the module name in comments/strings are not false positives.
const PI_STATIC_OR_SIDE_EFFECT_RE = /\b(?:from|import)\s+['"]@earendil-works\/pi-[^'"]+['"]/;
const PI_DYNAMIC_RE = /\bimport\(\s*['"]@earendil-works\/pi-/;

function importsPiHarness(content) {
  return PI_STATIC_OR_SIDE_EFFECT_RE.test(content) || PI_DYNAMIC_RE.test(content);
}

async function collectSourceFiles(dir) {
  const abs = path.join(repoRoot, dir);
  const out = [];
  let entries;
  try {
    entries = await readdir(abs, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await collectSourceFiles(rel)));
    } else if (/\.(ts|mjs|js)$/.test(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

test("within the neutral extension runtime + core harness, only pi-extension-adapter.ts imports @earendil-works/pi-*", async () => {
  const files = (await Promise.all(SCAN_DIRS.map(collectSourceFiles))).flat();
  assert.ok(files.length > 0, "expected to scan some source files");

  const offenders = [];
  for (const rel of files) {
    if (ALLOWED.has(rel)) continue;
    const content = await readFile(path.join(repoRoot, rel), "utf8");
    if (importsPiHarness(content)) {
      offenders.push(rel);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `These modules import @earendil-works/pi-* outside the dedicated Pi adapter: ${offenders.join(", ")}`,
  );
});

test("importsPiHarness detects static, side-effect, and dynamic Pi imports without prose false positives", () => {
  assert.equal(importsPiHarness("import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';"), true);
  assert.equal(importsPiHarness('import { x } from "@earendil-works/pi-tui";'), true);
  assert.equal(importsPiHarness("import '@earendil-works/pi-coding-agent';"), true, "side-effect import must be caught");
  assert.equal(importsPiHarness('import "@earendil-works/pi-coding-agent";'), true);
  assert.equal(importsPiHarness("await import('@earendil-works/pi-coding-agent');"), true, "dynamic import must be caught");
  // Prose mentions must NOT trip the detector.
  assert.equal(importsPiHarness("// No `@earendil-works/pi-*` import lives here."), false);
  assert.equal(importsPiHarness("a string with @earendil-works/pi-coding-agent in it"), false);
});

test("the dedicated Pi adapter module still owns the Pi import", async () => {
  const content = await readFile(path.join(repoRoot, "extension/pi-extension-adapter.ts"), "utf8");
  assert.match(content, /@earendil-works\/pi-coding-agent/);
});

test("`.pi/extensions/` is a Pi-native surface intentionally outside this boundary", async () => {
  // Documents the known exemption so a reader does not mistake the scoped boundary above
  // for a repo-wide one. This standalone Pi extension legitimately imports the Pi harness.
  const piNativeExtension = path.join(repoRoot, ".pi/extensions/dev-loop-behavioral-review.ts");
  const content = await readFile(piNativeExtension, "utf8").catch(() => null);
  if (content === null) return; // tolerate absence in trimmed/published trees
  assert.match(content, /@earendil-works\/pi-coding-agent/, "expected the documented Pi-native extension to import Pi");
  assert.ok(
    !SCAN_DIRS.some((dir) => path.join(repoRoot, ".pi/extensions/dev-loop-behavioral-review.ts").startsWith(path.join(repoRoot, dir) + path.sep)),
    ".pi/extensions/ must remain outside the scanned trees",
  );
});
