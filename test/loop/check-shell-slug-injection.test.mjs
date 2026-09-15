import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  computeShellSlugInjection,
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
  assert.equal(out.findings[0].token, "repoSlug");
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
