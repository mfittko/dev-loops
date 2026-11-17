import { assert, readRepo, test } from "../imported-assets-helpers.mjs";

const RULE = "GATE-REVIEW-COMMENT-TRUST";
const ADR = "docs/decisions/0238-comment-text-from-non-maintainers-never-reaches-an-agent.md";

test("ADR 0238 exists and GATE-REVIEW-COMMENT-TRUST has one owner in the gate review sub-loop contract", async () => {
  assert.match(await readRepo(ADR), /0238/);
  const owner = await readRepo("skills/docs/gate-review-sub-loop-contract.md");
  assert.equal(owner.split(`<!-- rule: ${RULE} -->`).length - 1, 1);
});

test("ADR 0248 exists, cites ADR 0238, and the owner paragraph names ADR 0248 and the filtered sites", async () => {
  assert.match(await readRepo("docs/decisions/0248-detector-evidence-trust-filter.md"), /0238/);
  const owner = await readRepo("skills/docs/gate-review-sub-loop-contract.md");
  const paragraph = owner.split(`<!-- rule: ${RULE} -->`)[1].split("\n")[1];
  for (const needle of ["ADR 0248", "resolveTrustedEvidencePredicate", "filterTrustedRoundInputs"]) {
    assert.ok(paragraph.includes(needle), `owner paragraph names ${needle}`);
  }
});

test("ADR 0273 exists, cites ADR 0238, and the owner paragraph names ADR 0273 and github-actions", async () => {
  const adr0273 = await readRepo("docs/decisions/0273-github-actions-bot-is-a-trusted-comment-author.md");
  assert.match(adr0273, /0238/);
  assert.match(adr0273, /0240/);
  const owner = await readRepo("skills/docs/gate-review-sub-loop-contract.md");
  const paragraph = owner.split(`<!-- rule: ${RULE} -->`)[1].split("\n")[1];
  for (const needle of ["ADR 0273", "github-actions"]) {
    assert.ok(paragraph.includes(needle), `owner paragraph names ${needle}`);
  }
});

test("GATE-REVIEW-COMMENT-TRUST has a cross-harness row", async () => {
  assert.match(await readRepo("skills/docs/cross-harness-regression-contract.md"), new RegExp(RULE));
});

test("ADR 0290 cites ADR 0238, 0240 and 0273, and the owner paragraph names the trust config and the ADR", async () => {
  const dir = "docs/decisions/";
  const { readdir } = await import("node:fs/promises");
  const file = (await readdir(new URL(`../../${dir}`, import.meta.url))).find((name) => name.startsWith("0290-"));
  const adr = await readRepo(dir + file);
  for (const n of ["0238", "0240", "0273"]) assert.match(adr, new RegExp(n));
  const owner = await readRepo("skills/docs/gate-review-sub-loop-contract.md");
  const paragraph = owner.split(`<!-- rule: ${RULE} -->`)[1].split("\n")[1];
  for (const needle of ["ADR 0290", "trust.reviewers", "trust.githubActionsBot", "default branch"]) {
    assert.ok(paragraph.includes(needle), `owner paragraph names ${needle}`);
  }
  assert.equal(paragraph.includes("no configuration surface"), false);
});

// Entry scripts (non-underscore under scripts/) that read comment, review or thread text through the trust
// predicate or the review-thread fetchers, directly or through a `_`-prefixed helper, load the trust config.
test("every entry script that reads trust-filtered text loads the trust config", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const root = new URL("../../scripts/", import.meta.url).pathname;
  const files = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== "vendor" && entry.name !== "node_modules") await walk(full); } else if (entry.name.endsWith(".mjs")) files.push(full);
    }
  };
  await walk(root);
  const sources = new Map(await Promise.all(files.map(async (f) => [f, await readFile(f, "utf8")])));
  const readsDirect = (src) => /\b(isTrustedCommentAuthor|isTrustedGraphqlComment|isTrustedRestComment|parseReviewThreads|fetchAllReviewThreads(?:WithSkips)?)\b/.test(src.replace(/^export \{[\s\S]*?\} from .*$/gm, ""));
  const isHelper = (f) => path.basename(f).startsWith("_");
  const reads = (f, seen = new Set()) => {
    if (seen.has(f)) return false;
    seen.add(f);
    const src = sources.get(f);
    if (readsDirect(src)) return true;
    for (const [, spec] of src.matchAll(/from "(\.{1,2}\/[^"]*_[^"/]*\.mjs)"/g)) {
      const target = path.resolve(path.dirname(f), spec);
      if (path.basename(target) !== "_core-helpers.mjs" && sources.has(target) && isHelper(target) && reads(target, seen)) return true;
    }
    return false;
  };
  const entries = files.filter((f) => !isHelper(f) && !f.endsWith("list-review-threads.mjs") && reads(f));
  assert.ok(entries.length > 0);
  const missing = entries.filter((f) => !/\bloadCommentTrustConfig(?:OrExit)?\(/.test(sources.get(f))).map((f) => path.relative(root, f));
  assert.deepEqual(missing, []);
});
