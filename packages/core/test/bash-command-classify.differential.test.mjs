import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  ALLOWED_INLINE_INTERPRETER_FORMS,
  DENIED_INLINE_INTERPRETER_FORMS,
} from "../../../test/fixtures/inline-interpreter-forms.mjs";
import * as head from "../src/loop/bash-command-classify.mjs";
import * as main from "../../../test/fixtures/bash-command-classify.origin-main.mjs";

/**
 * Differential fail-open guard (#2442). `bash-command-classify.origin-main.mjs` is a frozen copy of the
 * classifier as it stood on origin/main before the quote-aware rewrite. Every command main denies must
 * still be denied on the head, except the intended false-positive removals: quoted literals and
 * cat/tee heredoc bodies that merely name an interpreter. Those are listed in `INTENDED_REMOVALS`.
 */

const INLINE_FORMS = [
  "node -e 'x'", "node --eval x", "node -p 1", "bun -e x", "python3 -c x", "python -c x",
  "perl -e 1", "perl -pi -e s/a/b/ f", "ruby -e x", "sed -i s/a/b/ f", "sed -i.bak s/a/b/ f",
  "awk -i inplace x f", "python3 - <<'E'", "node - <<EOF", "cat > src/a.mjs <<'EOF'",
  "cat > tmp/r.mjs <<'EOF' && node tmp/r.mjs",
];
const WAIT_FORMS = [
  "while ! gh pr view 5; do sleep 5; done",
  "until gh pr checks 5; do sleep 5; done",
  "while [ ! -f tmp/done ]; do sleep 2; done",
  "nohup sleep 5 &",
  "dev-loops loop wait-for-review --pr 5 &",
  "node scripts/loop/probe-copilot-review.mjs --pr 5 &",
  'while [ "$(gh pr view 5)" != MERGED ]; do sleep 5; done',
];
const SEPARATORS = ["", "echo a; ", "echo a && ", "echo a || ", "echo a | ", "echo a & ", "echo a\n", "true\n\n"];
const SUFFIXES = ["", " && echo done", " ; echo done", "\necho done", " # c"];

/** Wrappers that put a form inside quoted data (the form is inert). */
const QUOTED_WRAPPERS = [
  (f) => `node scripts/loop/x.mjs --notes "${f.replace(/"/g, "'")}"`,
  (f) => `node scripts/loop/x.mjs --notes '${f.replace(/'/g, '"')}'`,
  (f) => `git commit -m "${f.replace(/"/g, "'")}"`,
  (f) => `echo '${f.replace(/'/g, '"')}'`,
];
/** Shapes that must stay denied even though the form is quoted or sits near quotes. */
const LIVE_WRAPPERS = [
  (f) => `# don't\n${f}`,
  (f) => `echo it\\'s; ${f}`,
  (f) => `git commit -F - <<'MSG'\ndon't\nMSG\n${f}`,
  (f) => `cat <<'EOF' | sh\ndon't\nEOF\n${f}`,
  (f) => `echo "a"; ${f}; echo "b"`,
  (f) => `echo 'a'; ${f}; echo 'b'`,
  (f) => `echo 'it'"'"'s'; ${f}`,
  (f) => `# can't\n${f}\n# don't`,
  (f) => `echo "a \\" b"; ${f}`,
];
const HEREDOC_BODY_WRAPPERS = [
  (f) => `cat > tmp/x.md <<'EOF'\n${f}\nEOF`,
  (f) => `tee tmp/x.md <<'EOF'\n${f}\nEOF`,
  (f) => `git commit -m "$(cat <<'EOF'\n${f}\nEOF\n)"`,
];

/** Intended false-positive removals: command strings main denied and the head allows on purpose. */
const INTENDED_REMOVALS = new Set(ALLOWED_INLINE_INTERPRETER_FORMS);

function buildCorpus() {
  const corpus = new Set([...DENIED_INLINE_INTERPRETER_FORMS, ...ALLOWED_INLINE_INTERPRETER_FORMS]);
  const forms = [...INLINE_FORMS, ...WAIT_FORMS];
  for (const f of forms) {
    for (const sep of SEPARATORS) for (const suf of SUFFIXES) corpus.add(`${sep}${f}${suf}`);
    for (const wrap of LIVE_WRAPPERS) corpus.add(wrap(f));
    for (const wrap of QUOTED_WRAPPERS) {
      const cmd = wrap(f);
      corpus.add(cmd);
      INTENDED_REMOVALS.add(cmd);
    }
    for (const wrap of HEREDOC_BODY_WRAPPERS) {
      const cmd = wrap(f);
      corpus.add(cmd);
      INTENDED_REMOVALS.add(cmd);
    }
  }
  // flag x marker cross product
  const heads = ["node", "bun", "python3", "perl", "ruby", "sed", "awk"];
  const flags = ["-e", "-p", "-c", "-i", "-pi", "-ne", "-i.bak", "--eval", "--in-place", "-r", "-M", "-I", "-W", "-C", "-X", "-", "-E", "-iinplace"];
  const markers = ["", "x", "'x'", '"x"', "<<EOF", "<<'EOF'", "- <<EOF", "tool.mjs"];
  for (const h of heads) for (const fl of flags) for (const m of markers) {
    corpus.add(`${h} ${fl} ${m}`.trim());
    corpus.add(`${h} ${fl} lib ${fl === "-r" || fl === "-I" || fl === "-M" ? "-e" : "-c"} ${m}`.trim());
    corpus.add(`echo a; ${h} ${fl} ${m}; echo b`);
  }
  return [...corpus];
}

/** @returns {Array<[string, (c: string) => boolean, (c: string) => boolean]>} */
const PREDICATES = [
  ["commandContainsInlineInterpreter", main.commandContainsInlineInterpreter, head.commandContainsInlineInterpreter],
  ["commandContainsDetachedWaitTool", main.commandContainsDetachedWaitTool, head.commandContainsDetachedWaitTool],
  ["commandIsSleepPollLoop", main.commandIsSleepPollLoop, head.commandIsSleepPollLoop],
  ["commandIsFileMarkerPollLoop", main.commandIsFileMarkerPollLoop, head.commandIsFileMarkerPollLoop],
];

test("differential: the head denies everything origin/main denies, except the intended removals", () => {
  const corpus = buildCorpus();
  assert.ok(corpus.length > 1000);
  const regressions = [];
  for (const [name, mainFn, headFn] of PREDICATES) {
    for (const cmd of corpus) {
      if (mainFn(cmd) && !headFn(cmd) && !INTENDED_REMOVALS.has(cmd)) regressions.push(`${name}: ${JSON.stringify(cmd)}`);
    }
  }
  assert.deepEqual(regressions, []);
});

test("differential: live shapes (comment/escaped/heredoc apostrophes) are denied by the head", () => {
  for (const f of INLINE_FORMS.filter((x) => !x.startsWith("cat >"))) {
    for (const wrap of LIVE_WRAPPERS) {
      const cmd = wrap(f);
      assert.equal(head.commandContainsInlineInterpreter(cmd), true, JSON.stringify(cmd));
    }
  }
});

test("differential: the issue's named false positives stay allowed", () => {
  for (const cmd of [
    'node scripts/loop/x.mjs --notes "11 were python3 or node -e; python3 -c denied"',
    "node scripts/loop/x.mjs --notes 'perl -0pi -e & ruby -e'",
    'grep -n "sed -i" README.md',
    "git commit -m \"$(cat <<'EOF'\nuse node -e and sed -i here\nEOF\n)\"",
    "cat > tmp/x.md <<'EOF'\nnode -e 'x'\nEOF",
    "tee tmp/x.md <<'EOF'\nsed -i s/a/b/ f\nEOF",
  ]) assert.equal(head.commandContainsInlineInterpreter(cmd), false, JSON.stringify(cmd));
});
