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
  (f) => `echo "$(echo "'")"; ${f}`,
];
const HEREDOC_BODY_WRAPPERS = [
  (f) => `cat > tmp/x.md <<'EOF'\n${f}\nEOF`,
  (f) => `tee tmp/x.md <<'EOF'\n${f}\nEOF`,
  (f) => `git commit -m "$(cat <<'EOF'\n${f}\nEOF\n)"`,
];

/** Quote-pairing hazards the old regex mispaired; the head must not allow any of them where the frozen copy denies. */
const HAZARD_LOOP = "while true; do gh pr view 5; sleep 5; done";
const LOOP_PREDICATES = ["commandContainsDetachedWaitTool", "commandIsSleepPollLoop"];
/** Each shape lists the only predicates whose frozen-allow/head-deny flip it may exempt. */
const HAZARD_SHAPES = [
  [(f) => `# it's\necho '${f}'`, LOOP_PREDICATES, "apostrophe in a # comment: the regex paired it across lines and blanked the loop; the stripper now blanks nothing"],
  [(f) => `echo "a \\" ; ${f}"`, LOOP_PREDICATES, "escaped quote: the regex mispaired the quotes; the stripper now blanks nothing"],
  [(f) => `echo $'a\\' ; ${f} '`, LOOP_PREDICATES, "escaped quote in an ANSI-C string: the regex mispaired the quotes; the stripper now blanks nothing"],
  [(f) => `cat <<'EOF'\nit's\nEOF\necho '${f}'`, LOOP_PREDICATES, "quote in a heredoc body: the regex paired it with later quotes; the stripper now blanks nothing"],
  [(f) => `echo it\\'s; echo '${f}'`, LOOP_PREDICATES, "escaped apostrophe: the regex mispaired the quotes; the stripper now blanks nothing"],
  [() => "while :; do `true '`; 'sleep' 5; gh pr view 5; done", LOOP_PREDICATES, "apostrophe inside a backtick span: the regex mispaired the quotes; the stripper now blanks nothing"],
  [() => "echo \\` ; while :; do `true '`; 'sleep' 5; gh pr view 5; done", LOOP_PREDICATES, "escaped backtick before a backtick span holding an apostrophe: the regex mispaired the quotes; the stripper now blanks nothing"],
  // wrapped in a double-quoted --notes/-m, the lone backtick opens an unterminated substitution, so the inline-interpreter scan also fails closed
  [() => "# `\nwhile :; do `true '`; 'sleep' 5; gh pr view 5; done", [...LOOP_PREDICATES, "commandContainsInlineInterpreter"], "backtick in a # comment followed by a backtick span holding an apostrophe: the stripper now blanks nothing"],
  [() => "echo '`' \"'\" ; while :; do `true '`; 'sleep' 5; gh pr view 5; done", [...LOOP_PREDICATES, "commandContainsInlineInterpreter"], "quoted backtick and apostrophe before a backtick span holding an apostrophe: the stripper now blanks nothing"],
  [() => 'while [ ! -f tmp/d ]; do echo "a \\"; sleep 2"; done', ["commandContainsDetachedWaitTool", "commandIsFileMarkerPollLoop"], "escaped quote inside a double-quoted word: the regex mispaired the quotes; the stripper now blanks nothing"],
  [() => "gh api repos/mfittko/dev-loops/pulls/5 -f body=x it\\'s -X GET 'y'", [], "escaped apostrophe: the stripper blanks nothing (no predicate flips)"],
  [() => "gh pr edit 5 --title it\\'s --repo other/x 'y' --body z", ["commandContainsRawPrBodyEdit"], "escaped apostrophe: the stripper blanks nothing, so the flag-looking text stays visible"],
  // wrapped in a quoted --notes/-m, the inner quote re-pairs and leaves an unterminated substitution, so the inline-interpreter scan also fails closed
  [(f) => `echo "$(echo "'")" ; echo '${f}'`, [...LOOP_PREDICATES, "commandContainsInlineInterpreter"], "double-quoted $(...) holding a nested apostrophe: the regex paired the inner apostrophe with a later one; the stripper now blanks nothing"],
  [() => `gh pr edit 5 --title "$(echo "'")" --add-label 'x --body y'`, ["commandContainsInlineInterpreter"], "double-quoted $(...) holding a nested apostrophe inside a quoted wrapper leaves an unterminated substitution: the inline-interpreter scan fails closed (the PR-body edit is denied by both copies)"],
  [(f) => 'echo "`echo "\'"`" ; echo \'' + f + "'", LOOP_PREDICATES, "double-quoted backtick span holding a nested apostrophe: the stripper now blanks nothing"],
  [(f) => "echo `echo \"'\" '`; echo '" + f + "'", LOOP_PREDICATES, "top-level backtick span holding interleaved even-count quotes: the regex paired a span quote with a later one; the stripper now blanks nothing"],
];
const hazardRowsOf = (shape) => [shape(HAZARD_LOOP), ...[...LIVE_WRAPPERS, ...QUOTED_WRAPPERS].map((wrap) => wrap(shape(HAZARD_LOOP)))];
const HAZARD_ROWS = [...new Set(HAZARD_SHAPES.flatMap(([shape]) => hazardRowsOf(shape)))];
/** A `#N` inside quoted data is not a comment: the head must match the frozen copy on these rows. */
const QUOTED_HASH_ROWS = [
  'gh pr edit 5 --repo other/x --body "Closes #12"',
  'git commit -m "docs: never poll (#12): while true; do gh pr view; sleep 5; done"',
  "gh pr comment 1 --body 'see #3 and \"x\"'",
  "cat <<'EOF'\r\nx\r\nEOF\r\n",
];
/** The four shapes the closed PR #2741 head allowed and origin/main denies. */
const RESIDUE_SHAPES = [
  `bash <<< "a b"'; node -e y'`,
  `bash -c "a b"'; node -e y'`,
  `bash <<< x\\ y'; node -e y'`,
  `bash -c -e 'x; node -e y'`,
];
/** Deny rows from the closed branch (draft_gate rounds 5 to 7, delta reviews): every deny row of commits 1c48f4f46..5c68e78be. */
const SALVAGED_DENY_ROWS = [
  // shared fixture table rows (test/fixtures/inline-interpreter-forms.mjs)
  "bash <<< 'x; node -e y'",
  "sh <<< 'x; node -e y'",
  "bash<<<'x; node -e y'",
  "bash <<<$'x; node -e y'",
  "bash <<< x'; node -e y'",
  "bash <<< \"a\"'b; node -e y'",
  "bash -c $'x; node -e y'",
  "eval $'x; node -e y'",
  "bash -c x'; node -e y'",
  "bash -c 'x; node -e y'",
  "node --require \"./setup.js\" -e 'console.log(1)'",
  "python3 -W \"ignore\" -c 'x'",
  "node --require=\"./setup.js\" -e 'x'",
  "perl -I \"lib\" -pi -e 's/a/b/' f",
  "ruby -C \"/tmp\" -e 'x'",
  "bash -c \"cat > packages/a.mjs <<'EOF'\"",
  "echo it\\'s; node -e 'x'",
  "python3 -Ic 'x'",
  // unit rows (packages/core/test/bash-command-classify.test.mjs)
  "cat > tmp/n <<'EOF'\ndon't\nEOF\ngit commit -m \"a\nb\" && cat > packages/a.mjs <<EOF\nx\nEOF",
  "# don't\necho \"a\nb\" ; cat > packages/a.mjs <<EOF\nx\nEOF",
  "# don't\necho \"a\nb\" ; tee src/a.mjs <<'EOF'\nx\nEOF",
  "echo x # don't\necho \"a\nb\" ; cat > packages/a.mjs <<EOF\nx\nEOF",
  "git commit -F - <<EOF\ndon't\nEOF\necho \"a\nb\" ; cat > packages/a.mjs <<EOF\nx\nEOF",
  "cat <<'EOF' | sh\ndon't\nEOF\necho \"a\nb\" ; cat > packages/a.mjs <<EOF\nx\nEOF",
  "cat > tmp/n <<EOF\ndon't $(date)\nEOF\necho \"a\nb\" ; cat > packages/a.mjs <<EOF\nx\nEOF",
  "git commit -F - <<EOF\nsay \"hi\nEOF\necho \"a\nb\" ; cat > packages/a.mjs <<EOF\nx\nEOF",
  "echo \\\\'a\nb' ; cat > packages/a.mjs <<EOF\nx\nEOF",
  "printf '%s\\n' 'a\\' 'b\nc' ; cat > packages/a.mjs <<EOF\nx\nEOF",
  "bash <<'EOF'\nnode scripts/loop/probe-copilot-review.mjs --pr 5 &\nEOF",
  // a quote pair after an unclosed `$(` opener: the old regex still paired it, so the head must not read it as allowed
  `gh api repos/mfittko/dev-loops/pulls/5 -f body=x -f "title=$(echo ' -X GET ' ; true)"`,
  `gh pr edit 5 --body x --title "$(echo ' --repo other/x ' ; true)"`,
  `gh pr edit 5 --body x --title "a ' --repo other/x ' b ; c"`,
  `gh api repos/mfittko/dev-loops/pulls/5 -f body=x -f "a ' -X GET ' b ; c"`,
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
  "cat > tmp/x <<EOF\n`while true; do gh pr view 5; sleep 5; done`\nEOF",
  "tee tmp/x <<-EOF\n$(while true; do gh pr view 5; sleep 5; done)\nEOF",
];

/** Hook-verdict row from test/loop/check-retro-tooling.test.mjs: `EOF)` is not a delimiter line, so origin/main allowed it and the head denies it. */
const EOF_PAREN_ROW = "gh pr comment 1 --body \"$(cat <<'EOF'\nuse `node -e 1` here\nEOF)\"";
/** Arithmetic shifts inside `$((...))`: the tokenizer reads the unquoted `<<` as a heredoc operator (arithmetic is out of tokenizer scope, ng:0). */
const ARITH_SHIFT_ROWS = ["echo $((1<<2))", "echo $(( 1 << 2 ))", "x=$((a<<b)); echo $x"];
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
  const R_EOFPAREN = "heredoc closed by `EOF)` instead of a delimiter line: the tokenizer never sees the delimiter, so the input is incomplete and the hook denies a command origin/main allowed";
  const R_NESTED ='quoted "$(...)" inside a $(...) heredoc body: the regex blanked the inner quotes; the tokenizer keeps the whole substitution';
  flip("commandContainsRawPrBodyEdit", "trailing # comment with an apostrophe is a quote-pairing hazard: the stripper blanks nothing, so the flag-looking text in the quoted title stays visible", "gh pr edit 5 --title 'a --body b' # it's");
  flip("commandContainsInlineInterpreter", R_UNCLOSED, 'echo "$(gh pr view 5');
  flip("commandContainsInlineInterpreter", R_EOFPAREN, EOF_PAREN_ROW);
  for (const row of ARITH_SHIFT_ROWS) flip("commandContainsInlineInterpreter", "arithmetic << inside $((...)) is read as a heredoc operator: the delimiter is the next word, the heredoc stays pending, so the input is incomplete and fails closed (arithmetic is out of tokenizer scope)", row);
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
  const corpus = new Set([...RESIDUE_SHAPES, ...SALVAGED_DENY_ROWS, ...HAZARD_ROWS, ...QUOTED_HASH_ROWS, EOF_PAREN_ROW, ...ARITH_SHIFT_ROWS]);
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

// One SLICE1_FAIL_CLOSED_FLIPS entry per (predicate, row) a hazard shape actually flips, carrying the shape's reason.
const GENERATED_FLIPS = new Set();
for (const [shape, targets, reason] of HAZARD_SHAPES) {
  for (const row of hazardRowsOf(shape)) {
    for (const [name, mainFn, headFn] of PREDICATES) {
      if (targets.includes(name) && !mainFn(row) && headFn(row)) {
        SLICE1_FAIL_CLOSED_FLIPS.set(rowKey(name, row), reason);
        GENERATED_FLIPS.add(rowKey(name, row));
      }
    }
  }
}

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

test("differential: a frozen-allow/head-deny row is listed in SLICE1_FAIL_CLOSED_FLIPS (hazard shapes generate their entries), and every entry is a real flip", () => {
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
  for (const [shape, targets] of HAZARD_SHAPES) {
    for (const name of targets) assert.ok(hazardRowsOf(shape).some((cmd) => GENERATED_FLIPS.has(rowKey(name, cmd))), `hazard shape targets ${name} but flips no row: ${JSON.stringify(shape(HAZARD_LOOP))}`);
  }
  assert.deepEqual([...SLICE1_FAIL_CLOSED_FLIPS.keys()].filter((k) => !seen.has(k)), []);
  for (const reason of SLICE1_FAIL_CLOSED_FLIPS.values()) assert.ok(reason.length > 0);
});

test("differential: quoted #N and CRLF heredoc rows keep the frozen decision on every predicate", () => {
  for (const cmd of QUOTED_HASH_ROWS) {
    for (const [name, mainFn, headFn] of PREDICATES) assert.equal(headFn(cmd), mainFn(cmd), rowKey(name, cmd));
  }
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
