import assert from "node:assert/strict";
import { describe, test } from "bun:test";

import {
  backtickedIdentifiers,
  definesSymbol,
  findEscalations,
  recurrenceFiles,
  surfaceKeysOf,
} from "../src/loop/gate-recurrence.mjs";

const TEXT_FILE = "scripts/github/_gate-finding-text.mjs";
const SOURCES = new Map([
  [TEXT_FILE, "export function isSameDefect(a, b) {}\nexport function mergeSameDefectFindings() {}\nconst THRESHOLD = 3;\n"],
  ["skills/docs/rules.md", "<!-- rule: SOME-RULE-ID -->\n`SOME-RULE-ID`: text\n"],
]);
const DIGEST = "sha256:" + "a".repeat(64);

const firstKey = (finding, sources) => surfaceKeysOf(finding, sources)[0] ?? null;
const actItem = (summary, file = TEXT_FILE) => ({ file, summary, judgeDisposition: "act" });
const round = (head, findings, specDigest = DIGEST) => ({ headSha: head, findings, specAuthority: { specDigest } });

describe("surface key", () => {
  test("a backticked name the file declares keys", () => {
    assert.deepEqual(firstKey(actItem("the overlap in `isSameDefect` is tuned to one fixture"), SOURCES), { file: TEXT_FILE, symbol: "isSameDefect" });
    assert.deepEqual(firstKey(actItem("`THRESHOLD` is too low"), SOURCES), { file: TEXT_FILE, symbol: "THRESHOLD" });
  });

  test("a backticked token the file does not define does not key", () => {
    assert.equal(firstKey(actItem("returns `null` for an empty list"), SOURCES), null);
  });

  test("a trailing () on a backticked name is stripped", () => {
    assert.deepEqual(backtickedIdentifiers("`isSameDefect()` and `THRESHOLD`"), ["isSameDefect", "THRESHOLD"]);
    assert.deepEqual(firstKey(actItem("`isSameDefect()` is tuned to one fixture"), SOURCES), { file: TEXT_FILE, symbol: "isSameDefect" });
  });

  test("the file keys in one posix form", () => {
    assert.deepEqual(firstKey(actItem("`isSameDefect` misfires", `./${TEXT_FILE}`), SOURCES), { file: TEXT_FILE, symbol: "isSameDefect" });
    assert.deepEqual(firstKey(actItem("`isSameDefect` misfires", TEXT_FILE.replaceAll("/", "\\")), SOURCES), { file: TEXT_FILE, symbol: "isSameDefect" });
    assert.deepEqual(recurrenceFiles([actItem("x", `./${TEXT_FILE}`)], []), [TEXT_FILE]);
  });

  test("a call-only mention is not a definition", () => {
    const sources = new Map([[TEXT_FILE, "isSameDefect(a, b);\n"]]);
    assert.equal(firstKey(actItem("`isSameDefect` misfires"), sources), null);
  });

  test("a markdown rule marker keys", () => {
    assert.deepEqual(firstKey(actItem("`SOME-RULE-ID` lags the code", "skills/docs/rules.md"), SOURCES), { file: "skills/docs/rules.md", symbol: "SOME-RULE-ID" });
  });

  test("a markdown file with only a heading or inline code mention does not key", () => {
    const sources = new Map([["a.md", "## SOME-RULE-ID\n`SOME-RULE-ID`\n"]]);
    assert.equal(firstKey(actItem("`SOME-RULE-ID` lags", "a.md"), sources), null);
  });

  test("a finding without a file or without a summary symbol gets no key", () => {
    assert.equal(firstKey({ summary: "`isSameDefect` is wrong" }, SOURCES), null);
    assert.equal(firstKey(actItem("no identifier here"), SOURCES), null);
  });

  test("files[0] resolves when file is absent", () => {
    assert.deepEqual(firstKey({ files: [TEXT_FILE], summary: "`isSameDefect`" }, SOURCES), { file: TEXT_FILE, symbol: "isSameDefect" });
  });

  test("helpers", () => {
    assert.deepEqual(backtickedIdentifiers("`a` and `a` and `b-c` and `1x`"), ["a", "b-c"]);
    assert.equal(definesSymbol("x.mjs", "let value = 1", "value"), true);
    assert.equal(definesSymbol("x.mjs", "const valueX = 1", "value"), false);
    assert.equal(definesSymbol("x.mjs", "// function ghost() {}", "ghost"), false);
    assert.equal(definesSymbol("x.mjs", 'const example = "function ghost() {}";', "ghost"), false);
    assert.equal(definesSymbol("x.mjs", "/* class ghost {} */\nfunction real() {}", "real"), true);
  });
});

describe("findEscalations", () => {
  const current = [actItem("`isSameDefect` needs a real fix")];
  const args = (priorLogs, over = {}) => ({ actFindings: current, priorLogs, specDigest: DIGEST, headSha: "h4", sources: SOURCES, ...over });

  test("a second-round repeat stays in the act list", () => {
    assert.deepEqual(findEscalations(args([round("h1", [actItem("`isSameDefect` x")])])), []);
  });

  test("a third-round repeat escalates with the round heads", () => {
    const out = findEscalations(args([round("h1", [actItem("`isSameDefect` x")]), round("h3", [actItem("`isSameDefect` y")])]));
    assert.equal(out.length, 1);
    assert.deepEqual(out[0], { index: 0, surfaceKey: { file: TEXT_FILE, symbol: "isSameDefect" }, rounds: 3, heads: ["h1", "h3", "h4"] });
  });

  test("a round counts once however many findings share the key", () => {
    const twice = round("h1", [actItem("`isSameDefect` x"), actItem("`isSameDefect` y")]);
    assert.deepEqual(findEscalations(args([twice])), []);
  });

  test("only act items count", () => {
    const rejected = { ...actItem("`isSameDefect` x"), judgeDisposition: "reject" };
    assert.deepEqual(findEscalations(args([round("h1", [rejected]), round("h2", [rejected])])), []);
  });

  test("a different symbol on the same file does not count", () => {
    const other = round("h1", [actItem("`mergeSameDefectFindings` x")]);
    assert.deepEqual(findEscalations(args([other, round("h2", [actItem("`THRESHOLD` y")])])), []);
  });

  test("a changed specDigest resets the count to the current round", () => {
    const recorded = "sha256:" + "b".repeat(64);
    const priors = [round("h1", [actItem("`isSameDefect` x")], recorded), round("h3", [actItem("`isSameDefect` y")], recorded)];
    assert.equal(findEscalations(args(priors, { specDigest: recorded })).length, 1, "same digest counts");
    assert.deepEqual(findEscalations(args(priors)), [], "a design decision changed the digest, so the count restarts");
  });

  test("ledgers written before the new fields never count and never throw", () => {
    const legacy = [{ headSha: "h1", findings: [actItem("`isSameDefect` x")] }, { headSha: "h2" }, null];
    assert.deepEqual(findEscalations(args(legacy)), []);
  });

  test("recurrenceFiles lists current and prior act files once", () => {
    const files = recurrenceFiles(current, [round("h1", [actItem("`a`", "x.mjs"), { ...actItem("`b`", "y.mjs"), judgeDisposition: "reject" }])]);
    assert.deepEqual(files.sort(), [TEXT_FILE, "x.mjs"].sort());
  });
});

describe("PR 2586 replay", () => {
  // Ledger shapes of draft_gate r1, r3 and r4: an act item on isSameDefect each time.
  // Other gates, other PRs and the r2 round (no isSameDefect act item) never reach the counter.
  test("escalates the isSameDefect act item at r4", () => {
    const r1 = round("c4306cf3", [actItem("`isSameDefect` accepts unrelated findings"), actItem("`mergeSameDefectFindings` merges too much")]);
    const r2 = round("aaaaaaaa", [{ ...actItem("a doc nit"), file: "README.md" }]);
    const r3 = round("7e5af716", [actItem("`isSameDefect` overlap rule is tuned to one fixture")]);
    const out = findEscalations({
      actFindings: [actItem("`isSameDefect` still fits one fixture only")],
      priorLogs: [r1, r2, r3], specDigest: DIGEST, headSha: "19a8ba84", sources: SOURCES,
    });
    assert.equal(out.length, 1);
    assert.deepEqual(out[0].surfaceKey, { file: TEXT_FILE, symbol: "isSameDefect" });
    assert.deepEqual(out[0].heads, ["c4306cf3", "7e5af716", "19a8ba84"]);
  });

  test("keying does not depend on which defined symbol a summary mentions first", () => {
    const r1 = round("h1", [actItem("`isSameDefect` misfires")]);
    const r3 = round("h3", [actItem("`mergeSameDefectFindings` calls `isSameDefect` with a loose threshold")]);
    const out = findEscalations({
      actFindings: [actItem("`isSameDefect` still fits one fixture")],
      priorLogs: [r1, r3], specDigest: DIGEST, headSha: "h4", sources: SOURCES,
    });
    assert.equal(out.length, 1);
    assert.deepEqual(out[0].surfaceKey, { file: TEXT_FILE, symbol: "isSameDefect" });
    assert.equal(out[0].rounds, 3);
  });
});
