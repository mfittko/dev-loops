import assert from "node:assert/strict";
import { test } from "bun:test";

import * as head from "../src/loop/bash-command-classify.mjs";
import * as main from "../../../test/fixtures/bash-command-classify.origin-main.mjs";
import { readFileSync } from "node:fs";
import { INLINE_DENY_ROWS } from "../../../test/fixtures/bash-command-classify.inline-deny-rows.mjs";
import { INLINE_INTERPRETER_FORMS } from "../../../test/fixtures/inline-interpreter-forms.mjs";

/**
 * Differential fail-open guard (#2442, decision 2).
 * `test/fixtures/bash-command-classify.origin-main.mjs` is a frozen copy of the classifier at origin/main
 * `99bb8b3ce`, the slice 1 branch point. Over the corpus plus every row of the shared fixture table:
 * a row the frozen copy's `commandContainsInlineInterpreter` denies and the head allows must be a fixture row
 * marked `ceiling: true`; the other five predicates keep every decision.
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
  'while [ "`gh pr view 5`" != MERGED ]; do sleep 5; done',
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

/** Quote-pairing hazard shapes the old regex mispaired: corpus rows for every predicate. */
const HAZARD_LOOP = "while true; do gh pr view 5; sleep 5; done";
const HAZARD_SHAPES = [
  (f) => `# it's\necho '${f}'`,
  (f) => `echo "a \\" ; ${f}"`,
  (f) => `echo $'a\\' ; ${f} '`,
  (f) => `cat <<'EOF'\nit's\nEOF\necho '${f}'`,
  (f) => `echo it\\'s; echo '${f}'`,
  () => "while :; do `true '`; 'sleep' 5; gh pr view 5; done",
  () => "echo \\` ; while :; do `true '`; 'sleep' 5; gh pr view 5; done",
  () => "# `\nwhile :; do `true '`; 'sleep' 5; gh pr view 5; done",
  () => "echo '`' \"'\" ; while :; do `true '`; 'sleep' 5; gh pr view 5; done",
  () => 'while [ ! -f tmp/d ]; do echo "a \\"; sleep 2"; done',
  () => "gh api repos/mfittko/dev-loops/pulls/5 -f body=x it\\'s -X GET 'y'",
  () => "gh pr edit 5 --title it\\'s --repo other/x 'y' --body z",
  (f) => `echo "$(echo "'")" ; echo '${f}'`,
  () => `gh pr edit 5 --title "$(echo "'")" --add-label 'x --body y'`,
  (f) => 'echo "`echo "\'"`" ; echo \'' + f + "'",
  (f) => "echo `echo \"'\" '`; echo '" + f + "'",
];
const hazardRowsOf = (shape) => [shape(HAZARD_LOOP), ...[...LIVE_WRAPPERS, ...QUOTED_WRAPPERS].map((wrap) => wrap(shape(HAZARD_LOOP)))];
const HAZARD_ROWS = [...new Set(HAZARD_SHAPES.flatMap((shape) => hazardRowsOf(shape)))];
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
  ...INLINE_DENY_ROWS,
  "cp /bin/sh tmp/cat; echo 'node scripts/loop/probe-copilot-review.mjs --pr 5 &' | tmp/cat",
  "echo 'node scripts/loop/probe-copilot-review.mjs --pr 5 &' | PATH=tmp cat",
  "echo 'while [ \"`gh pr view 5`\" != MERGED ]; do sleep 5; done'; eval \"$_\"",
  "printf '%s' 'while [ \"`gh pr view 5`\" != MERGED ]; do sleep 5; done'; eval \"$_\"",
  "echo 'while [ \"`gh pr view 5`\" != MERGED ]; do sleep 5; done'; bash -c \"$_\"",
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
  "pwsh -Command 'true; node -e y'",
  "git rebase -ix 'true; node -e y' HEAD~1",
  "git rebase -x'true; node -e y' HEAD~1",
  "git difftool -x 'true; node -e y'",
  "sudo watch 'true; node -e y'",
  "tmp/git commit -m \"$(cat <<'EOF'\nnode -e 'x'\nEOF\n)\"",
  // an executed single-quoted poll loop (a later segment or a non-shell interpreter runs it)
  "echo 'while [ \"$(gh pr view 5)\" != MERGED ]; do sleep 5; done' > l.sh; bash l.sh",
  "perl -e 'system q(while [ \"$(gh pr view 5)\" != MERGED ]; do sleep 5; done)'",
  "sed -n 's/`gh pr view 5`/while sleep 5/e' f",
  "sed -i 's/`gh pr view 5`/while sleep 5/' f",
  "sed -n -e 's/`gh pr view 5`/while sleep 5/e' f",
  "sed -n --expression='s/`gh pr view 5`/while sleep 5/e' f",
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
  'echo "$(gh pr view 5',
  "cat > tmp/x <<'EOF'\nnode -e y",
  "cat > tmp/x <<EOF\n`while true; do gh pr view 5; sleep 5; done`\nEOF",
  "tee tmp/x <<-EOF\n$(while true; do gh pr view 5; sleep 5; done)\nEOF",
  // write-then-run guard and inert-host rows (draft_gate round 3029): runner payloads, globs, aliases, host redirects, git/env hosts
  "cat > tmp/l.sh <<'EOF'\nwhile true; do gh pr view 5; sleep 5; done\nEOF\nbash -c 'bash tmp/l.sh'",
  "cat &> tmp/l.sh <<'EOF'\nwhile true; do gh pr view 5; sleep 5; done\nEOF\nbash tmp/l.sh",
  // draft_gate round 4: process substitution mid-word, path-prefixed or env-overridden cat, a file-writing inner cat, gh hosts, unlisted executor arguments
  "tee ${NOPE}>(bash) <<'EOF'\nnode -e 'x'\nEOF",
  "cat <<'EOF' >$NOPE>(sh)\nnode -e 'x'\nEOF",
  "tee />(sh) <<'EOF'\nwhile true; do gh pr view 5; sleep 5; done\nEOF",
  "git commit -m \"$(cat > .git/hooks/pre-commit <<'EOF'\nwhile true; do gh pr view 5; sleep 5; done\nEOF\n)\"",
  "exec>l.sh\ncat <<'EOF'\nnode -e 'x'\nEOF\nbash l.sh",
  ">l.sh exec\ncat <<'EOF'\nnode -e 'x'\nEOF\nbash l.sh",
  "command exec >l.sh\ncat <<'EOF'\nnode -e 'x'\nEOF\nbash l.sh",
  "builtin exec >l.sh\ncat <<'EOF'\nnode -e 'x'\nEOF\nbash l.sh",
  // hidden exec redirect: a payload word, here-string, variable head or quoted keyword; the multi-segment command keeps every heredoc body visible
  "eval 'exec >l.sh'\ncat <<'EOF'\nwhile true; do gh pr view 5; sleep 5; done\nEOF\nbash l.sh",
  // quoted backgrounded probe run through a file, source, process substitution, a pipe or a non-shell interpreter (round 3029 r5)
  ...["echo 'P' > l.sh; bash l.sh", "echo 'P' > l.sh; . l.sh", "echo 'P' > l.sh; source l.sh", "source <(echo 'P')", ". <(echo 'P')", "echo 'P' | source /dev/stdin", "echo 'P' | tee l.sh; bash l.sh", "echo 'P' | cat | source /dev/stdin", "echo 'P' | cat | tee l.sh; bash l.sh", "echo 'P' | grep . | dd of=l.sh; bash l.sh", "echo 'P' | sort -o l.sh; bash l.sh", "echo 'P' | uniq - l.sh; bash l.sh","make -f <(printf '%s' 'a:; P')",
    "perl -e 'system q(P)'", 'awk \'BEGIN{system("P")}\'', 'ruby -e \'system "P"\'', 'osascript -e \'do shell script "P"\'', "env -S 'P'",
  ].map((row) => row.replace(/P/g, "node scripts/loop/probe-copilot-review.mjs --pr 5 &")),
  // bash 5.3 funsub in an unquoted heredoc body
  "cat <<EOF\n${| node -e 'x'; }\nEOF",
  "cat <<EOF\n${ while true; do gh pr view 5; sleep 5; done; }\nEOF",
  "for i in 1; do>&2\ncat <<'EOF'\nnode -e 'x'\nEOF\ndone>l.sh\nbash l.sh",
  "if true; then>&2\ncat <<'EOF'\nnode -e 'x'\nEOF\nfi>l.sh\nbash l.sh",
  "for i in 1; do&>/dev/null\ncat <<'EOF'\nnode -e 'x'\nEOF\ndone>l.sh\nbash l.sh",
  // grouping fail-open (draft_gate round 3029 r2): a group closer pipes or redirects a cat heredoc written on its own line
  ...["node -e 'x'", "while true; do gh pr view 5; sleep 5; done", "node scripts/loop/probe-copilot-review.mjs --pr 5 &"].flatMap((body) => [
    `{\ncat <<'EOF'\n${body}\nEOF\n} | sh`,
    `(\ncat <<'EOF'\n${body}\nEOF\n) | bash`,
    `for i in 1; do\ncat <<'EOF'\n${body}\nEOF\ndone | bash`,
    `if true; then\ncat <<'EOF'\n${body}\nEOF\nfi | sh`,
    `{\ncat <<'EOF'\n${body}\nEOF\n} 2>&1 | sh`,
    `{\ncat <<'EOF'\n${body}\nEOF\n} > l.sh; bash l.sh`,
    `f() {\ncat <<'EOF'\n${body}\nEOF\n}\nf | sh`,
    `{\necho "$(cat <<'EOF'\n${body}\nEOF\n)"\n} | sh`,
    // prefix-keyword subshells closed by an attached `)` (residue of the group-opener list)
    `! (\ncat <<'EOF'\n${body}\nEOF\ntrue) | sh`,
    `function f (\ncat <<'EOF'\n${body}\nEOF\ntrue)\nf | sh`,
  ]),
];

/** Hook-verdict row from test/loop/check-retro-tooling.test.mjs: `EOF)` inside `$(...)` closes the heredoc and the substitution; it is a complete command, not an incomplete one. */
const EOF_PAREN_ROW = "gh pr comment 1 --body \"$(cat <<'EOF'\nuse `node -e 1` here\nEOF)\"";
/** Arithmetic shifts inside `$((...))`: the tokenizer reads them as arithmetic text, not a heredoc operator. */
const ARITH_SHIFT_ROWS = ["echo $((1<<2))", "echo $(( 1 << 2 ))", "x=$((a<<b)); echo $x"];
/** A chained command or a non-cat/tee heredoc host keeps a quoted-delimiter body visible: a backticked mention in it is now denied. */
const CHAINED_HEREDOC_ROWS = ["git add -A && git commit -m \"$(cat <<'EOF'\nfix: refuse `node -e`\nEOF\n)\"", "node scripts/github/comment-issue.mjs 5 --body-file - <<'EOF'\nfix: refuse `node -e`\nEOF"];
const rowKey = (name, cmd) => `${name}: ${JSON.stringify(cmd)}`;
/** The only rows whose inline-interpreter decision may flip from deny to allow (decision 2). */
const CEILING_ROWS = new Set(INLINE_INTERPRETER_FORMS.filter((row) => row.ceiling).map((row) => row.command));

function buildCorpus() {
  const corpus = new Set([...RESIDUE_SHAPES, ...SALVAGED_DENY_ROWS, ...HAZARD_ROWS, ...QUOTED_HASH_ROWS, EOF_PAREN_ROW, ...ARITH_SHIFT_ROWS, ...CHAINED_HEREDOC_ROWS, ...INLINE_INTERPRETER_FORMS.map((row) => row.command)]);
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
  ["commandContainsDetachedWaitTool", main.commandContainsDetachedWaitTool, head.commandContainsDetachedWaitTool],
  ["commandIsSleepPollLoop", main.commandIsSleepPollLoop, head.commandIsSleepPollLoop],
  ["commandIsFileMarkerPollLoop", main.commandIsFileMarkerPollLoop, head.commandIsFileMarkerPollLoop],
  ["commandContainsRawPrBodyEdit", slug(main.commandContainsRawPrBodyEdit), slug(head.commandContainsRawPrBodyEdit)],
  ["commandContainsRawPrBodyApiWrite", slug(main.commandContainsRawPrBodyApiWrite), slug(head.commandContainsRawPrBodyApiWrite)],
];

test("differential: the oracle header names its origin/main commit", () => {
  const oracle = readFileSync(new URL("../../../test/fixtures/bash-command-classify.origin-main.mjs", import.meta.url), "utf8");
  assert.match(oracle.split("\n").slice(0, 4).join("\n"), /origin\/main commit 99bb8b3ce[\s\S]*git show 99bb8b3ce:packages\/core\/src\/loop\/bash-command-classify\.mjs/);
});

test("differential: every row origin/main's inline-interpreter gate denies and the head allows is a fixture ceiling row", () => {
  const corpus = buildCorpus();
  assert.ok(corpus.length > 1000);
  const unlisted = corpus.filter((cmd) => main.commandContainsInlineInterpreter(cmd) && !head.commandContainsInlineInterpreter(cmd) && !CEILING_ROWS.has(cmd));
  if (unlisted.length > 0) console.log(`unlisted flips (JSON, head verdict):\n${unlisted.map((cmd) => `${JSON.stringify(cmd)} // ${head.inlineInterpreterVerdict(cmd)}`).join("\n")}`);
  assert.deepEqual(unlisted.map((cmd) => rowKey("commandContainsInlineInterpreter", cmd)), []);
});

test("differential: the gh PR-body, wait and poll predicates keep every origin/main decision", () => {
  const flips = [];
  for (const cmd of buildCorpus()) for (const [name, mainFn, headFn] of PREDICATES) if (mainFn(cmd) !== headFn(cmd)) flips.push(rowKey(name, cmd));
  assert.deepEqual(flips, []);
});

test("differential: the four PR #2741 residue shapes stay denied by origin/main and are ceiling cases at the head", () => {
  for (const cmd of RESIDUE_SHAPES) {
    assert.equal(main.commandContainsInlineInterpreter(cmd), true, `main ${JSON.stringify(cmd)}`);
    assert.equal(head.inlineInterpreterVerdict(cmd), "ceiling", `head ${JSON.stringify(cmd)}`);
  }
});
