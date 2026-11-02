import assert from "node:assert/strict";
import { test } from "bun:test";

import * as head from "../src/loop/bash-command-classify.mjs";
import * as main from "../../../test/fixtures/bash-command-classify.origin-main.mjs";

/**
 * Differential fail-open guard (#2442, slice 1).
 * `test/fixtures/bash-command-classify.origin-main.mjs` is a frozen copy of the classifier at origin/main
 * `47fd3a4fd`. Slice 1 moves `stripQuotedLiterals` onto `tokenizeShellCommand` and changes no decision
 * toward allow. For every corpus row and every predicate: a row the frozen copy denies is denied by the
 * head, and a row the frozen copy allows but the head denies must be listed in `SLICE1_FAIL_CLOSED_FLIPS`.
 * The intended-removals set is empty in slice 1 (slice 2 owns the false-positive fixes).
 */

const MANAGED_SLUG = "mfittko/dev-loops";

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
const PR_BODY_FORMS = [
  "gh pr edit 5 --body x",
  'gh pr edit 5 --body "x y"',
  "gh pr edit 5 --body-file tmp/b.md",
  "gh pr edit 5 -F tmp/b.md",
  'gh pr edit 5 --repo mfittko/dev-loops --body "x"',
  "gh pr edit 5 --repo 'mfittko/dev-loops' --body-file f",
  'gh pr edit 5 --repo "other/repo" --body "x"',
  "gh -R mfittko/dev-loops pr edit 5 --body x",
  "gh pr edit 5 --title 'a --body b'",
  "gh pr edit 5 --add-label 'x'",
  "bash -c 'gh pr edit 5 --body x'",
  'eval "gh pr edit 5 --body x"',
  "gh api repos/mfittko/dev-loops/pulls/5 -X PATCH --input body.json",
  "gh api repos/mfittko/dev-loops/pulls/5 -X PATCH --input 'tmp/body.json'",
  "gh api repos/mfittko/dev-loops/pulls/5 -f body=x",
  'gh api repos/mfittko/dev-loops/pulls/5 -f "body=x y"',
  "gh api repos/mfittko/dev-loops/issues/5 --method PATCH -F 'body=@f'",
  "gh api repos/mfittko/dev-loops/pulls/5 --method GET --input f",
  "gh api repos/mfittko/dev-loops/pulls/5/comments -f body=x",
  "gh api graphql -f query='mutation { updatePullRequest(input: {}) { clientMutationId } }'",
  "bash -c 'gh api repos/mfittko/dev-loops/pulls/5 --input f'",
];
const SEPARATORS = ["", "echo a; ", "echo a && ", "echo a || ", "echo a | ", "echo a & ", "echo a\n", "true\n\n"];
const SUFFIXES = ["", " && echo done", " ; echo done", "\necho done", " # c"];

/** Wrappers that put a form inside quoted data. */
const QUOTED_WRAPPERS = [
  (f) => `node scripts/loop/x.mjs --notes "${f.replace(/"/g, "'")}"`,
  (f) => `node scripts/loop/x.mjs --notes '${f.replace(/'/g, '"')}'`,
  (f) => `git commit -m "${f.replace(/"/g, "'")}"`,
  (f) => `echo '${f.replace(/'/g, '"')}'`,
];
/** Shapes that stay live even though the form sits near quotes, comments or heredocs. */
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
  (f) => `${f} # it's`,
  (f) => `echo $'a\\'b'; ${f}`,
  (f) => `echo "$(echo "x")"; ${f}`,
];
const HEREDOC_BODY_WRAPPERS = [
  (f) => `cat > tmp/x.md <<'EOF'\n${f}\nEOF`,
  (f) => `tee tmp/x.md <<'EOF'\n${f}\nEOF`,
  (f) => `git commit -m "$(cat <<'EOF'\n${f}\nEOF\n)"`,
];

/** The four shapes the closed PR #2741 head allowed and origin/main denies. */
const RESIDUE_SHAPES = [
  `bash <<< "a b"'; node -e y'`,
  `bash -c "a b"'; node -e y'`,
  `bash <<< x\\ y'; node -e y'`,
  `bash -c -e 'x; node -e y'`,
];
/** Deny rows from the closed branch (draft_gate rounds 5 to 7, delta reviews) that hold on origin/main. */
const SALVAGED_DENY_ROWS = [
  "# don't\nnode -e 'console.log(1)'",
  "git commit -F - <<'MSG'\ndon't\nMSG\nnode -e 'x'",
  "# can't\nnode -e 'x'\n# don't",
  "node -e 'x",
  "echo x # don't\necho 'a\nb' ; cat > packages/a.mjs <<EOF\nx\nEOF",
  "echo x # don't\necho \\\" ; cat > packages/a.mjs <<EOF\nx\nEOF",
  "echo x # don't\necho \\' ; cat > packages/a.mjs <<EOF\nx\nEOF",
  "echo 'a\\' 'b\\nc' ; cat > packages/a.mjs <<EOF\nx\nEOF",
  "echo 'a\\'\\' ; cat > packages/a.mjs <<EOF\nx\nEOF",
  "# don't\nnode scripts/loop/probe-copilot-review.mjs --pr 5 &\n# it's",
  "# don't\nwhile [ \"$(gh pr view 5)\" != MERGED ]; do sleep 5; done # it's",
  "bash <<< 'node scripts/loop/probe-copilot-review.mjs --pr 5 &'",
  "bash<<<'node scripts/loop/probe-copilot-review.mjs --pr 5 &'",
  "bash <<<$'node scripts/loop/probe-copilot-review.mjs --pr 5 &'",
  "cat > tmp/x <<EOF\n$(while true; do gh pr view 5; sleep 5; done)\nEOF",
  "sed -n 's/`gh pr view 5`/while sleep 5/p' f",
  'echo "$(gh pr view 5',
  "cat > tmp/x <<'EOF'\nnode -e y",
];

const rowKey = (name, cmd) => `${name}: ${JSON.stringify(cmd)}`;
/**
 * Rows the frozen copy allows and the head denies on purpose (fail-closed, slice 1). Key: `<predicate>: <JSON command>`.
 * Each entry carries a one-line reason.
 */
const SLICE1_FAIL_CLOSED_FLIPS = new Map();
{
  const flip = (name, reason, cmd) => SLICE1_FAIL_CLOSED_FLIPS.set(rowKey(name, cmd), reason);
  const POLL = 'while [ "$(gh pr view 5)" != MERGED ]; do sleep 5; done';
  const R_HEREDOC = "heredoc body never reaches a delimiter line (the trailing line is not EOF): incomplete, so the rest stays executable text";
  const R_UNCLOSED = "unterminated $( substitution: incomplete, so commandContainsInlineInterpreter fails closed";
  const R_COMMENT = "apostrophe in a # comment: the regex paired it across lines and blanked the loop; the tokenizer skips the comment";
  const R_ESCAPE = 'escaped \\" inside a double-quoted word: the regex paired the quotes wrongly and blanked the loop; the tokenizer keeps the loop visible';
  const R_NESTED = 'quoted "$(...)" inside a $(...) heredoc body: the regex blanked the inner quotes; the tokenizer keeps the whole substitution';
  flip("commandContainsInlineInterpreter", R_UNCLOSED, 'echo "$(gh pr view 5');
  for (const sep of SEPARATORS) {
    for (const f of ["cat > src/a.mjs <<'EOF'", "cat > tmp/r.mjs <<'EOF' && node tmp/r.mjs"]) flip("commandContainsInlineInterpreter", R_HEREDOC, `${sep}${f}\necho done`);
  }
  for (const f of ["cat > src/a.mjs <<'EOF'", "cat > tmp/r.mjs <<'EOF' && node tmp/r.mjs"]) flip("commandContainsInlineInterpreter", R_HEREDOC, `# can't\n${f}\n# don't`);
  const wrapComment = (f) => `# can't\n${f}\n# don't`;
  for (const f of ["while ! gh pr view 5; do sleep 5; done", "until gh pr checks 5; do sleep 5; done", "while [ ! -f tmp/done ]; do sleep 2; done"]) flip("commandContainsDetachedWaitTool", R_COMMENT, wrapComment(f));
  for (const f of ["while ! gh pr view 5; do sleep 5; done", "until gh pr checks 5; do sleep 5; done"]) flip("commandIsSleepPollLoop", R_COMMENT, wrapComment(f));
  flip("commandIsFileMarkerPollLoop", R_COMMENT, wrapComment("while [ ! -f tmp/done ]; do sleep 2; done"));
  for (const name of ["commandContainsDetachedWaitTool", "commandIsSleepPollLoop"]) {
    flip(name, R_ESCAPE, `echo "a \\" b"; ${POLL}`);
    flip(name, R_NESTED, `git commit -m "$(cat <<'EOF'\n${POLL}\nEOF\n)"`);
  }
}
/** Slice 1 removes nothing. */
const INTENDED_REMOVALS = new Set();

function buildCorpus() {
  const corpus = new Set([...RESIDUE_SHAPES, ...SALVAGED_DENY_ROWS]);
  const forms = [...INLINE_FORMS, ...WAIT_FORMS, ...PR_BODY_FORMS];
  for (const f of forms) {
    for (const sep of SEPARATORS) for (const suf of SUFFIXES) corpus.add(`${sep}${f}${suf}`);
    for (const wrap of [...LIVE_WRAPPERS, ...QUOTED_WRAPPERS, ...HEREDOC_BODY_WRAPPERS]) corpus.add(wrap(f));
  }
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

const slug = (fn) => (command) => fn(command, MANAGED_SLUG);
/** @type {Array<[string, (c: string) => boolean, (c: string) => boolean]>} */
const PREDICATES = [
  ["commandContainsInlineInterpreter", main.commandContainsInlineInterpreter, head.commandContainsInlineInterpreter],
  ["commandContainsDetachedWaitTool", main.commandContainsDetachedWaitTool, head.commandContainsDetachedWaitTool],
  ["commandIsSleepPollLoop", main.commandIsSleepPollLoop, head.commandIsSleepPollLoop],
  ["commandIsFileMarkerPollLoop", main.commandIsFileMarkerPollLoop, head.commandIsFileMarkerPollLoop],
  ["commandContainsRawPrBodyEdit", slug(main.commandContainsRawPrBodyEdit), slug(head.commandContainsRawPrBodyEdit)],
  ["commandContainsRawPrBodyApiWrite", slug(main.commandContainsRawPrBodyApiWrite), slug(head.commandContainsRawPrBodyApiWrite)],
];

test("differential: no row origin/main denies is allowed by the head (empty intended removals)", () => {
  assert.equal(INTENDED_REMOVALS.size, 0);
  const corpus = buildCorpus();
  assert.ok(corpus.length > 1000);
  const regressions = [];
  for (const [name, mainFn, headFn] of PREDICATES) {
    for (const cmd of corpus) if (mainFn(cmd) && !headFn(cmd)) regressions.push(rowKey(name, cmd));
  }
  assert.deepEqual(regressions, []);
});

test("differential: a frozen-allow/head-deny row is listed in SLICE1_FAIL_CLOSED_FLIPS, and every listed flip is real", () => {
  const corpus = buildCorpus();
  const seen = new Set();
  const unlisted = [];
  for (const [name, mainFn, headFn] of PREDICATES) {
    for (const cmd of corpus) {
      if (!mainFn(cmd) && headFn(cmd)) {
        const key = rowKey(name, cmd);
        seen.add(key);
        if (!SLICE1_FAIL_CLOSED_FLIPS.has(key)) unlisted.push(key);
      }
    }
  }
  assert.deepEqual(unlisted, []);
  assert.deepEqual([...SLICE1_FAIL_CLOSED_FLIPS.keys()].filter((k) => !seen.has(k)), []);
  for (const reason of SLICE1_FAIL_CLOSED_FLIPS.values()) assert.ok(reason.length > 0);
});

test("differential: both the frozen copy and the head deny the four PR #2741 residue shapes", () => {
  for (const cmd of RESIDUE_SHAPES) {
    assert.equal(main.commandContainsInlineInterpreter(cmd), true, `main ${JSON.stringify(cmd)}`);
    assert.equal(head.commandContainsInlineInterpreter(cmd), true, `head ${JSON.stringify(cmd)}`);
  }
});

test("differential: the salvaged deny rows are denied by the head", () => {
  const live = SALVAGED_DENY_ROWS.filter((cmd) => PREDICATES.some(([, mainFn]) => mainFn(cmd)));
  assert.ok(live.length >= 10);
  for (const cmd of live) assert.ok(PREDICATES.some(([, , headFn]) => headFn(cmd)), JSON.stringify(cmd));
});

test("differential: the PR-body predicates keep their decisions on quoted --body, quoted --repo and --input rows", () => {
  const edit = [
    ['gh pr edit 5 --body "x y"', true],
    ["gh pr edit 5 --repo 'mfittko/dev-loops' --body-file f", true],
    ['gh pr edit 5 --repo "other/repo" --body "x"', true], // a quoted --repo value is blanked, so the foreign-repo pass-through does not apply (fail closed)
    ["gh pr edit 5 --repo other/repo --body x", false],
    ["gh pr edit 5 --title 'a --body b'", false],
  ];
  for (const [cmd, want] of edit) {
    assert.equal(main.commandContainsRawPrBodyEdit(cmd, MANAGED_SLUG), want, `main ${cmd}`);
    assert.equal(head.commandContainsRawPrBodyEdit(cmd, MANAGED_SLUG), want, `head ${cmd}`);
  }
  const api = [
    ["gh api repos/mfittko/dev-loops/pulls/5 -X PATCH --input body.json", true],
    ["gh api repos/mfittko/dev-loops/pulls/5 -X PATCH --input 'tmp/body.json'", true],
    ["gh api repos/mfittko/dev-loops/pulls/5 --method GET -f body=x", false],
  ];
  for (const [cmd, want] of api) {
    assert.equal(main.commandContainsRawPrBodyApiWrite(cmd, MANAGED_SLUG), want, `main ${cmd}`);
    assert.equal(head.commandContainsRawPrBodyApiWrite(cmd, MANAGED_SLUG), want, `head ${cmd}`);
  }
});
