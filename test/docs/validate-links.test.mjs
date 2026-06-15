import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { formatBrokenLinkReport, validateMarkdownLinks } from "../../scripts/docs/validate-links.mjs";

const scriptPath = path.resolve("scripts/docs/validate-links.mjs");

async function createRepo(files) {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "dev-loops-validate-links-"));

  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(repoRoot, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });

    if (content === null) {
      await mkdir(absolutePath, { recursive: true });
      continue;
    }

    await writeFile(absolutePath, content, "utf8");
  }

  return repoRoot;
}

test("validateMarkdownLinks scans root docs surfaces, strips fragments, accepts directory links, and skips docs/archive sources", async () => {
  const repoRoot = await createRepo({
    "README.md": "See [Guide](./docs/guide.md).\n",
    "AGENTS.md": "See [Doc folder](./docs/subdir/).\n",
    "docs/guide.md": "Return to [README](../README.md#overview).\n",
    "docs/subdir/": null,
    "docs/archive/old.md": "[Broken](../missing.md)\n",
  });

  try {
    const result = await validateMarkdownLinks({ repoRoot });

    assert.equal(result.ok, true);
    assert.deepEqual(result.brokenLinks, []);
    assert.ok(result.scannedFiles.includes("AGENTS.md"));
    assert.ok(result.scannedFiles.includes("README.md"));
    assert.ok(result.scannedFiles.includes("docs/guide.md"));
    assert.ok(!result.scannedFiles.includes("docs/archive/old.md"));
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("validateMarkdownLinks ignores external links, mailto links, fragment-only links, image links, and fenced-code examples", async () => {
  const repoRoot = await createRepo({
    "README.md": [
      "[External](https://example.com/docs)",
      "[Mail](mailto:test@example.com)",
      "[Fragment](#same-file)",
      "![Image](./missing-image.png)",
      "```md",
      "[Code example](./missing-in-code.md)",
      "```",
    ].join("\n"),
  });

  try {
    const result = await validateMarkdownLinks({ repoRoot });

    assert.equal(result.ok, true);
    assert.deepEqual(result.brokenLinks, []);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("validateMarkdownLinks honors .linkcheckignore placeholder targets", async () => {
  const repoRoot = await createRepo({
    ".linkcheckignore": "# documented placeholder targets\ndocs/phases/phase-x.md # local implementation placeholder\n",
    "skills/local-implementation/SKILL.md": "Read [Phase Plan](../../docs/phases/phase-x.md).\n",
  });

  try {
    const result = await validateMarkdownLinks({ repoRoot });

    assert.equal(result.ok, true);
    assert.deepEqual(result.brokenLinks, []);
    assert.deepEqual(result.ignoredResolvedPaths, ["docs/phases/phase-x.md"]);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("validateMarkdownLinks reports file, line, raw target, resolved path, and a conservative suggestion", async () => {
  const repoRoot = await createRepo({
    "AGENTS.md": "See [Guide](./docs/guid.md).\n",
    "docs/guide.md": "# Guide\n",
  });

  try {
    const result = await validateMarkdownLinks({ repoRoot });

    assert.equal(result.ok, false);
    assert.equal(result.brokenLinks.length, 1);
    assert.deepEqual(result.brokenLinks[0], {
      sourcePath: "AGENTS.md",
      line: 1,
      rawTarget: "./docs/guid.md",
      resolvedPath: "docs/guid.md",
      suggestion: "docs/guide.md",
    });

    const report = formatBrokenLinkReport(result.brokenLinks);
    assert.match(report, /Broken markdown links found:/);
    assert.match(report, /AGENTS\.md:1 -> \.\/docs\/guid\.md/);
    assert.match(report, /resolved: docs\/guid\.md/);
    assert.match(report, /suggestion: docs\/guide\.md/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("validateMarkdownLinks suppresses suggestions when multiple candidates are equally plausible", async () => {
  const repoRoot = await createRepo({
    "README.md": "See [Guide](./docs/guid.md).\n",
    "docs/guide.md": "# Guide\n",
    "docs/guild.md": "# Guild\n",
  });

  try {
    const result = await validateMarkdownLinks({ repoRoot });

    assert.equal(result.ok, false);
    assert.equal(result.brokenLinks.length, 1);
    assert.equal(result.brokenLinks[0].suggestion, null);

    const report = formatBrokenLinkReport(result.brokenLinks);
    assert.doesNotMatch(report, /suggestion:/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});


test("validateMarkdownLinks excludes worktrees from suggestion candidates", async () => {
  const repoRoot = await createRepo({
    "README.md": "See [Guide](./docs/guid.md).\n",
    "worktrees/feature/docs/guide.md": "# Guide from another checkout\n",
  });

  try {
    const result = await validateMarkdownLinks({ repoRoot });

    assert.equal(result.ok, false);
    assert.equal(result.brokenLinks.length, 1);
    assert.equal(result.brokenLinks[0].suggestion, null);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("validateMarkdownLinks skips candidate-index traversal on clean trees", async () => {
  const repoRoot = await createRepo({
    "README.md": "See [Guide](./docs/guide.md).\n",
    "docs/guide.md": "# Guide\n",
    "sandbox/": null,
  });
  const blockedDir = path.join(repoRoot, "sandbox");

  try {
    await chmod(blockedDir, 0o000);
    const result = await validateMarkdownLinks({ repoRoot });

    assert.equal(result.ok, true);
    assert.deepEqual(result.brokenLinks, []);
  } finally {
    await chmod(blockedDir, 0o755).catch(() => {});
    await rm(repoRoot, { recursive: true, force: true });
  }
});


test("validateMarkdownLinks does not suggest archived-doc candidates", async () => {
  const repoRoot = await createRepo({
    "README.md": "See [Guide](./docs/guid.md).\n",
    "docs/archive/guide.md": "# Archived guide\n",
  });

  try {
    const result = await validateMarkdownLinks({ repoRoot });

    assert.equal(result.ok, false);
    assert.equal(result.brokenLinks.length, 1);
    assert.equal(result.brokenLinks[0].suggestion, null);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("validateMarkdownLinks degrades to no suggestions when candidate indexing fails", async () => {
  const repoRoot = await createRepo({
    "README.md": "See [Guide](./docs/guid.md).\n",
    "sandbox/": null,
  });
  const blockedDir = path.join(repoRoot, "sandbox");

  try {
    await chmod(blockedDir, 0o000);
    const result = await validateMarkdownLinks({ repoRoot });

    assert.equal(result.ok, false);
    assert.equal(result.brokenLinks.length, 1);
    assert.equal(result.brokenLinks[0].suggestion, null);
  } finally {
    await chmod(blockedDir, 0o755).catch(() => {});
    await rm(repoRoot, { recursive: true, force: true });
  }
});


test("validateMarkdownLinks does not let .linkcheckignore suppress outside-repo targets", async () => {
  const repoRoot = await createRepo({
    ".linkcheckignore": "../outside.md\n",
    "README.md": "See [Outside](../outside.md).\n",
  });
  const outsidePath = path.join(path.dirname(repoRoot), "outside.md");

  try {
    await writeFile(outsidePath, "outside repo target\n", "utf8");
    const result = await validateMarkdownLinks({ repoRoot });

    assert.equal(result.ok, false);
    assert.equal(result.brokenLinks.length, 1);
    assert.equal(result.brokenLinks[0].rawTarget, "../outside.md");
    assert.equal(result.brokenLinks[0].resolvedPath, "../outside.md");
    assert.equal(result.brokenLinks[0].suggestion, null);
  } finally {
    await unlink(outsidePath).catch(() => {});
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("validate-links CLI exits 1 for broken links and 0 for a clean tree", async () => {
  const brokenRepo = await createRepo({
    "README.md": "See [Missing](./docs/missing.md).\n",
  });
  const cleanRepo = await createRepo({
    "README.md": "See [Guide](./docs/guide.md).\n",
    "docs/guide.md": "# Guide\n",
  });

  try {
    const broken = spawnSync(process.execPath, [scriptPath, "--root", brokenRepo], {
      encoding: "utf8",
    });
    assert.equal(broken.status, 1);
    assert.match(broken.stderr, /Broken markdown links found:/);
    assert.match(broken.stderr, /README\.md:1 -> \.\/docs\/missing\.md/);

    const clean = spawnSync(process.execPath, [scriptPath, "--root", cleanRepo], {
      encoding: "utf8",
    });
    assert.equal(clean.status, 0);
    assert.match(clean.stdout, /Markdown links OK/);
  } finally {
    await rm(brokenRepo, { recursive: true, force: true });
    await rm(cleanRepo, { recursive: true, force: true });
  }
});
