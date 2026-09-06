import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { materializeTemplate, parseCliArgs, renderTemplate } from "./render-template.mjs";

test("render-template renders placeholders deterministically", () => {
  assert.equal(
    renderTemplate("# Phase {{phase}} variant {{variant}}\n", {
      phase: "phase-0",
      variant: "a",
    }),
    "# Phase phase-0 variant a\n",
  );
});

test("render-template throws on missing variables", () => {
  assert.throws(() => renderTemplate("Hello {{name}}", {}), /missing template variable: name/i);
});

test("render-template materializes a template file", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dev-loop-render-template-"));
  const templatePath = path.join(tempDir, "template.md");
  const outputPath = path.join(tempDir, "out", "variant-a.md");

  try {
    await writeFile(templatePath, "# {{phase}}\n{{body}}\n", "utf8");
    await materializeTemplate(templatePath, outputPath, {
      phase: "phase-0",
      body: "hello",
    });

    const output = await readFile(outputPath, "utf8");
    assert.equal(output, "# phase-0\nhello\n");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("render-template parses cli args", () => {
  assert.deepEqual(
    parseCliArgs([
      "--template",
      "templates/x.md",
      "--output",
      "tmp/x.md",
      "--vars",
      '{"phase":"phase-0"}',
    ]),
    {
      templatePath: "templates/x.md",
      outputPath: "tmp/x.md",
      variables: { phase: "phase-0" },
    },
  );
});

test("render-template requires template and output args", () => {
  assert.throws(() => parseCliArgs(["--output", "tmp/x.md"]), /missing required --template/i);
  assert.throws(() => parseCliArgs(["--template", "templates/x.md"]), /missing required --output/i);
});
