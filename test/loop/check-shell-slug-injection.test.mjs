import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "bun:test";

import {
  computeShellSlugInjection,
  evaluateShellSlugInjection,
  extractTemplateLiterals,
  SAFE_ALTERNATIVE,
} from "../../scripts/loop/check-shell-slug-injection.mjs";

const scan = (text, path = "scripts/x.mjs") => computeShellSlugInjection([{ path, text }]);

test("flags an unsanitized remote-slug interpolated into a bash -lc sink (the regression class)", () => {
  const out = scan(`
    const remoteUrl = execSync('git config --get remote.origin.url').toString().trim();
    const slug = remoteUrl.split(':')[1].replace('.git', '');
    await runCommand({ command: \`bash -lc "run-gate --repo \${slug} --pr 7"\` });
  `);
  assert.equal(out.outcome, "block");
  assert.equal(out.findings[0].token, "slug");
  assert.ok(out.reasons.some((r) => r.includes("shell-slug-injection guard")));
  assert.ok(out.reasons.some((r) => r.includes(SAFE_ALTERNATIVE)));
  assert.ok(out.reasons.some((r) => /scripts\/x\.mjs:\d+/.test(r)), "names file:line");
});

test("flags the gateCommand shape when the isCleanRepoSlug guard is absent", () => {
  const out = scan("const gateCommand = `${SCRIPT} --repo ${repoContext.repoSlug} --pr ${prNumber}`;");
  assert.equal(out.outcome, "block");
  assert.equal(out.findings[0].token, "repoContext.repoSlug");
});

test("flags an unguarded value that collides on its last dotted segment with a guarded value (token-collision)", () => {
  // isCleanRepoSlug(safe.repoSlug) proves ONLY `safe.repoSlug` clean; `evil.repoSlug` is a
  // different value that happens to share the last segment `repoSlug` and must still be flagged.
  const out = scan(`
    if (!isCleanRepoSlug(safe.repoSlug)) return fail();
    const cmd = \`bash -lc "gate --repo \${evil.repoSlug}"\`;
  `);
  assert.equal(out.outcome, "block");
  assert.equal(out.findings[0].token, "evil.repoSlug");
});

test("flags a transform-through interpolation of an unguarded slug value (.trim())", () => {
  const out = scan("const cmd = `bash -lc \"gate --repo ${slug.trim()}\"`;");
  assert.equal(out.outcome, "block");
  assert.equal(out.findings[0].token, "slug");
});

test("flags a transform-through interpolation of an unguarded slug value (String(slug))", () => {
  const out = scan("const cmd = `bash -lc \"gate --repo ${String(slug)}\"`;");
  assert.equal(out.outcome, "block");
  assert.equal(out.findings[0].token, "slug");
});

test("flags a transform-through interpolation of an unguarded remote-url value (.split/.replace chain)", () => {
  const out = scan(
    "const cmd = `bash -lc \"gate --repo ${remoteUrl.split(':')[1].replace('.git','')}\"`;",
  );
  assert.equal(out.outcome, "block");
  assert.equal(out.findings[0].token, "remoteUrl");
});

test("passes a transform of a guarded slug value (full-path match survives a trailing transform call)", () => {
  const out = scan(`
    if (!isCleanRepoSlug(slug)) return fail();
    const cmd = \`bash -lc "gate --repo \${slug.trim()}"\`;
  `);
  assert.equal(out.outcome, "pass");
});

test("flags a direct-sink argument with no bash marker and no *command binding (SINK_CTX_RE)", () => {
  const out = scan("execSync(`gate --repo ${slug} --pr 7`);");
  assert.equal(out.outcome, "block");
  assert.equal(out.findings[0].token, "slug");
});

test("passes the real gateCommand shape when guarded by isCleanRepoSlug in the same file (current tree)", () => {
  const out = scan(`
    if (repoContext.repoSlug && !isCleanRepoSlug(repoContext.repoSlug)) return fail();
    const gateCommand = \`\${SCRIPT} --repo \${repoContext.repoSlug} --pr \${prNumber}\`;
  `);
  assert.equal(out.outcome, "pass");
});

test("passes a value bound from normalizeGitHubRepoSlug", () => {
  const out = scan(`
    const slug = normalizeGitHubRepoSlug(remote);
    const cmd = \`bash -lc "gate --repo \${slug}"\`;
  `);
  assert.equal(out.outcome, "pass");
});

test("passes an arg-vector slug (the safe alternative, never a shell string)", () => {
  const out = scan("spawn('run-gate', ['--repo', repoSlug, '--pr', String(prNumber)]);");
  assert.equal(out.outcome, "pass");
});

test("does not flag a slug interpolated into a non-shell literal (e.g. a RegExp source)", () => {
  const out = scan("const re = new RegExp(`(?:repos/${slug}/|^)issues`);");
  assert.equal(out.outcome, "pass");
});

test("does not flag a non-slug interpolation into a command", () => {
  const out = scan("const gateCommand = `bash -lc \"gate --pr ${prNumber}\"`;");
  assert.equal(out.outcome, "pass");
});

test("extractTemplateLiterals keeps a ${…} span with an inner brace intact", () => {
  const lits = extractTemplateLiterals("const c = `a ${ f({x:1}) } b`; const d = `plain`;");
  assert.equal(lits.length, 2);
  assert.ok(lits[0].raw.includes("f({x:1})"));
  assert.equal(lits[1].raw, "`plain`");
});

test("a guard mention living only inside a comment does not exempt a real sink (fail-open regression)", () => {
  const out = scan(`
    // isCleanRepoSlug(slug) — looks guarded, but this line is only a comment
    /* normalizeGitHubRepoSlug(slug) */
    const cmd = \`bash -lc "gate --repo \${slug}"\`;
  `);
  assert.equal(out.outcome, "block");
  assert.equal(out.findings[0].token, "slug");
});

test("a URL template literal (// inside a string) survives comment stripping intact", () => {
  const out = scan(
    "const url = `https://registry.npmjs.org/dev-loops/-/dev-loops-${version}.tgz`; // trailing comment",
  );
  assert.equal(out.outcome, "pass");
});

test("does not flag an argv-vector API (spawn/execFile are not shell-string sinks)", () => {
  const out = scan("execFileSync(`gate --repo ${slug}`, []);");
  assert.equal(out.outcome, "pass");
});

test("does not flag the positional runCommand(cmd, args) argv API", () => {
  const out = scan("await runCommand(`gate --repo ${slug}`, []);");
  assert.equal(out.outcome, "pass");
});

test("still flags the object-form runCommand({ command: ... }) shell sink", () => {
  const out = scan("await runCommand({ command: `gate --repo ${slug}` });");
  assert.equal(out.outcome, "block");
  assert.equal(out.findings[0].token, "slug");
});

test("evaluateShellSlugInjection blocks a hostile file under a scanned root and names it", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "shell-slug-injection-"));
  try {
    mkdirSync(path.join(tmp, "scripts"), { recursive: true });
    mkdirSync(path.join(tmp, "test"), { recursive: true });
    const hostile = 'const cmd = `bash -lc "gate --repo ${slug}"`;\n';
    writeFileSync(path.join(tmp, "scripts", "foo.mjs"), hostile);
    // Excluded by TEST_FILE_RE (under test/) — proves the exclusion, not just the traversal.
    writeFileSync(path.join(tmp, "test", "foo.mjs"), hostile);
    const out = evaluateShellSlugInjection({ repoRoot: tmp });
    assert.equal(out.outcome, "block");
    assert.ok(out.findings.some((f) => f.path === "scripts/foo.mjs"));
    assert.ok(!out.findings.some((f) => f.path.startsWith("test/")));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
