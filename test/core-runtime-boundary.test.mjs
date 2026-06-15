import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const RUNTIME_ROOTS = ["scripts", "lib", "cli", "extension"];
const deepImportPattern = /packages\/core\/src\//;

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
