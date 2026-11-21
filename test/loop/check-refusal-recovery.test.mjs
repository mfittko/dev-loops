import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUDIT_TABLE_HEADER, checkAgainstBaseline, missingCounts, scanRefusals, spliceAudit } from "../../scripts/loop/check-refusal-recovery.mjs";

test("flags a refusal without recovery and passes one with it", () => {
  const dir = mkdtempSync(join(tmpdir(), "pr-refusal-"));
  mkdirSync(join(dir, "scripts/github"), { recursive: true });
  mkdirSync(join(dir, "scripts/loop"));
  mkdirSync(join(dir, "cli"));
  writeFileSync(join(dir, "scripts/github/a.mjs"), 'f({ ok: false, reason: "x" });\ng({ ok: false, recovery: "run y" });\n');
  const sites = scanRefusals(dir);
  assert.deepEqual(sites.map((s) => s.recovery), [false, true]);
  assert.equal(checkAgainstBaseline(sites, {}).length, 1);
  assert.equal(checkAgainstBaseline(sites, { "scripts/github/a.mjs": 1 }).length, 0);
});

function scanSource(src) {
  const dir = mkdtempSync(join(tmpdir(), "pr-refusal-"));
  mkdirSync(join(dir, "lib"));
  writeFileSync(join(dir, "lib/a.mjs"), src);
  return scanRefusals(dir).map((s) => s.recovery);
}

test("a nested recovery does not count for the refusal object", () => {
  assert.deepEqual(scanSource('f({ ok: false, detail: { recovery: "x" } });\n'), [false]);
});

test("a recoveryless string or word does not count", () => {
  assert.deepEqual(scanSource('f({ ok: false, reason: "recoveryless", recoveryless: 1 });\n'), [false]);
});

test("a brace in a string does not break a real recovery", () => {
  assert.deepEqual(scanSource('f({ ok: false, reason: "a } b {", recovery });\n'), [true]);
});

test("a raised count or an unlisted file fails the baseline; a lowered count passes", () => {
  const sites = [{ file: "a.mjs", line: 1, recovery: false }];
  assert.equal(checkAgainstBaseline(sites, { "a.mjs": 0 }).length, 1);
  assert.equal(checkAgainstBaseline(sites, {}).length, 1);
  assert.equal(checkAgainstBaseline(sites, { "a.mjs": 1 }).length, 0);
  assert.equal(checkAgainstBaseline(sites, { "a.mjs": 2 }).length, 0);
  assert.deepEqual(missingCounts(sites), { "a.mjs": 1 });
});

test("an interpolated refusal inside a template expression is a site", () => {
  assert.deepEqual(scanSource("f(`${JSON.stringify({ ok: false, error })}\\n`);\n"), [false]);
  assert.deepEqual(scanSource("f(`x ${g({ ok: false })} y`);\n"), [false]);
  assert.deepEqual(scanSource('f(`${a ? JSON.stringify({ ok: false }) : ""}`);\n'), [false]);
  assert.deepEqual(scanSource("f(`${g({ ok: false, recovery: 'x' })}`);\n"), [true]);
});

test("ok: false in template text, strings and comments is not a site", () => {
  assert.deepEqual(scanSource("const t = `ok: false`;\n"), []);
  assert.deepEqual(scanSource("const t = `text ok: false ${x}`;\n"), []);
  assert.deepEqual(scanSource('const t = "ok: false";\n'), []);
  assert.deepEqual(scanSource("// ok: false\n/* ok: false */\n"), []);
  assert.deepEqual(scanSource("const t = a / b; // ok: false\n"), []);
});

test("a regex literal does not hide a later refusal and its text is not a site", () => {
  assert.deepEqual(scanSource("const r = /'/; return { ok: false, error: \"e\" };\n"), [false]);
  assert.deepEqual(scanSource('s.replace(/\\/\\//g, ""); return { ok: false };\n'), [false]);
  assert.deepEqual(scanSource('if (/"/.test(x)) return { ok: false };\n'), [false]);
  assert.deepEqual(scanSource("const r = /ok: false/;\n"), []);
});

test("recovery in value position is not a recovery key", () => {
  assert.deepEqual(scanSource('f({ ok: false, recovery: "x" });\n'), [true]);
  assert.deepEqual(scanSource("f({ ok: false, recovery });\n"), [true]);
  assert.deepEqual(scanSource("f({ ok: false, error, recovery, });\n"), [true]);
  assert.deepEqual(scanSource("f({ ok: false, reason: recovery });\n"), [false]);
  assert.deepEqual(scanSource("f({ ok: false, steps: [recovery, x] });\n"), [false]);
  assert.deepEqual(scanSource("f({ ok: false, hint: g(recovery, x) });\n"), [false]);
  assert.deepEqual(scanSource("f({ ok: false, reason: c ? recovery : y });\n"), [false]);
});

test("spliceAudit replaces the table and refuses a missing header", () => {
  const table = `${AUDIT_TABLE_HEADER}\n|---|---|\n| \`a.mjs:1\` | MISSING |`;
  const doc = `intro\n\n${AUDIT_TABLE_HEADER}\n|---|---|\n| old | row |\n`;
  assert.equal(spliceAudit(doc, table), `intro\n\n${table}\n`);
  assert.equal(spliceAudit("intro\n| Other header |\n", table), null);
});

test("the scan visits files in sorted name order", () => {
  const dir = mkdtempSync(join(tmpdir(), "pr-refusal-"));
  mkdirSync(join(dir, "lib"));
  for (const n of ["b.mjs", "c.mjs", "a.mjs"]) writeFileSync(join(dir, "lib", n), "f({ ok: false });\n");
  assert.deepEqual(scanRefusals(dir).map((s) => s.file), ["lib/a.mjs", "lib/b.mjs", "lib/c.mjs"]);
});

test("the repo has no refusal path above the committed baseline", () => {
  const baseline = JSON.parse(readFileSync(new URL("../../docs/refusal-recovery-baseline.json", import.meta.url), "utf8"));
  const sites = scanRefusals();
  assert.deepEqual(checkAgainstBaseline(sites, baseline), []);
  // CI never rewrites the baseline, so a fallen count must be committed: the file stays exact.
  assert.deepEqual(missingCounts(sites), baseline);
});

test("checkAgainstBaseline rejects a baseline value that is not a non-negative integer", () => {
  const sites = [{ file: "scripts/loop/x.mjs", line: 1 }];
  for (const bad of ["abc", -1, 1.5, null]) {
    assert.equal(checkAgainstBaseline(sites, { "scripts/loop/x.mjs": bad }).length > 0, true, JSON.stringify(bad));
  }
  for (const good of [0, 3]) {
    assert.equal(checkAgainstBaseline(sites, { "scripts/loop/x.mjs": good }).some((e) => e.includes("not a non-negative integer")), false);
  }
});

test("the CLI prints usage on --help and refuses unknown arguments before any write", () => {
  const script = fileURLToPath(new URL("../../scripts/loop/check-refusal-recovery.mjs", import.meta.url));
  const help = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage:/);
  for (const bad of ["--audits", "--write", "-h2", "audit"]) {
    const r = spawnSync(process.execPath, [script, bad], { encoding: "utf8" });
    assert.equal(r.status, 1, bad);
  }
});

test("scans the shared formatCliError catch-all in scripts/lib", () => {
  const sites = scanRefusals(fileURLToPath(new URL("../..", import.meta.url)));
  assert.ok(sites.some((s) => s.file === "scripts/lib/format-cli-error.mjs"));
});
