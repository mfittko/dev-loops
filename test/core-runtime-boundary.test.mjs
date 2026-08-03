import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const RUNTIME_ROOTS = ["scripts", "lib", "cli", "extension"];
// The boundary is about module resolution: runtime surfaces must import via
// the @dev-loops/core package entry, never deep into packages/core/src. Only
// import/export/require specifiers count — comments, doc prose, and
// filesystem-path constants (asset copiers, atlas source labels) may name
// packages/core/src freely. The static branch is anchored to a line-leading
// import/export keyword (the STATIC_SPECIFIER_RE shape from
// test/contracts/no-package-escaping-imports.test.mjs) so prose like
// `copied from "packages/core/src/x.mjs"` cannot match; the binding-list char
// class spans newlines for multiline import blocks. Residual known gap:
// comment-embedded code samples still match when they look like real
// specifiers — a quoted `import(...)`/`require(...)` sample anywhere, or a
// block-comment line that itself leads with `import`/`export`.
const deepImportPattern =
  /(?:^[ \t]*(?:import\s*(?:[\w$*,{}\s]*?\bfrom\s*)?|export\s*[\w$*,{}\s]*?\bfrom\s*)|\bimport\s*\(\s*|\brequire\s*\(\s*)["'][^"']*packages\/core\/src\//m;

async function* walk(dirUrl) {
  const { readdir } = await import("node:fs/promises");
  for (const entry of await readdir(dirUrl, { withFileTypes: true })) {
    const childUrl = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dirUrl);
    if (entry.isDirectory()) {
      yield* walk(childUrl);
      continue;
    }
    yield childUrl;
  }
}

test("deep-import pattern catches real import specifiers only", () => {
  assert.match(`import { x } from "../../packages/core/src/config/config.mjs";`, deepImportPattern);
  assert.match(`import "../../packages/core/src/register-globals.mjs";`, deepImportPattern);
  assert.match(`import {\n  a,\n  b,\n} from "../../packages/core/src/config/config.mjs";`, deepImportPattern);
  assert.match(`const m = await import("packages/core/src/loop/run-context.mjs");`, deepImportPattern);
  assert.match(`const m = require("../packages/core/src/x.mjs");`, deepImportPattern);
  assert.match(`export { y } from "../../packages/core/src/y.mjs";`, deepImportPattern);
  assert.doesNotMatch(`// synced from packages/core/src/loop/run-context.mjs`, deepImportPattern);
  assert.doesNotMatch(`// copied from "packages/core/src/config/default.json"`, deepImportPattern);
  assert.doesNotMatch(`// e.g. import { x } from "packages/core/src/y.mjs"`, deepImportPattern);
  assert.doesNotMatch(`const source = "packages/core/src/loop/run-context.mjs";`, deepImportPattern);
});

test("runtime surfaces use the @dev-loops/core boundary instead of deep packages/core/src imports", async () => {
  const offenders = [];

  for (const root of RUNTIME_ROOTS) {
    const rootUrl = new URL(`../${root}/`, import.meta.url);
    for await (const fileUrl of walk(rootUrl)) {
      const relativePath = path.relative(process.cwd(), fileUrl.pathname);
      if (!/\.(mjs|js|ts)$/.test(relativePath)) {
        continue;
      }

      const contents = await readFile(fileUrl, "utf8");
      if (deepImportPattern.test(contents)) {
        offenders.push(relativePath);
      }
    }
  }

  assert.deepEqual(offenders, []);
});
