// #3259: a procedure doc must prescribe the launcher form for issue/PR body writes, because the
// Claude pre-check denies a raw body write and an agent copying the raw form hits that denial.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

const docsDir = path.resolve(fileURLToPath(new URL("../../skills/docs/", import.meta.url)));
const RAW_BODY_WRITE = /\bgh (?:issue|pr) (?:create|edit)\b[^`\n]*(?:--body\b|--body-file\b|\s-b\s|\s-F\s)/u;

test("no procedure doc prescribes a raw issue/PR create or edit with a body flag", () => {
  const hits = [];
  for (const name of readdirSync(docsDir).filter((n) => n.endsWith(".md"))) {
    readFileSync(path.join(docsDir, name), "utf8").split("\n").forEach((line, i) => {
      if (RAW_BODY_WRITE.test(line)) hits.push(`${name}:${i + 1}`);
    });
  }
  assert.deepEqual(hits, []);
});
