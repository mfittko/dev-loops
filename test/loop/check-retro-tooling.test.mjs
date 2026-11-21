import assert from "node:assert/strict";
import { test } from "bun:test";

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import { commandContainsInlineInterpreter } from "@dev-loops/core/loop/bash-command-classify";
import { decideBashGate } from "../../packages/core/src/claude/hook-decisions.mjs";
import { analyzeCommand, analyzeTranscript, run } from "../../scripts/loop/check-retro-tooling.mjs";
import { INLINE_INTERPRETER_FORMS } from "../fixtures/inline-interpreter-forms.mjs";

test("retro node verdict matches the shared classifier (#2943)", () => {
  for (const [cmd, bad] of [["node --input-type=module - <<EOF", true], ["node -p 1", true], ["node --require x.js - <<EOF", true], ["node scripts/x.mjs", false]]) {
    assert.equal(analyzeTranscript(cmd).violations.length > 0, bad, cmd);
    assert.equal(commandContainsInlineInterpreter(cmd), bad, cmd);
  }
  const src = readFileSync(fileURLToPath(new URL("../../scripts/loop/check-retro-tooling.mjs", import.meta.url)), "utf8");
  assert.match(src, /from "@dev-loops\/core\/loop\/bash-command-classify"/);
  // The Bash-gate consumer moved to the shared module (issue 3032); the invariant is that the
  // hook's Bash-gate decisions still come from the one shared classifier, never a second copy.
  const gateDecisions = readFileSync(fileURLToPath(new URL("../../packages/core/src/loop/bash-gate-decisions.mjs", import.meta.url)), "utf8");
  assert.match(gateDecisions, /commandContainsInlineInterpreter,[\s\S]*?from "\.\/bash-command-classify\.mjs"/);
  const hook = readFileSync(fileURLToPath(new URL("../../packages/core/src/claude/hook-decisions.mjs", import.meta.url)), "utf8");
  assert.match(hook, /from "\.\.\/loop\/bash-gate-decisions\.mjs"/);
});

test("clean transcript: dev-loops tooling + node scripts only — no violations", () => {
  const transcript = [
    "node scripts/github/foo.mjs --pr 982",
    "node scripts/loop/check-retro-tooling.mjs --transcript x.txt",
    "dev-loops loop info",
    "gate capture-threads --pr 982",
    "queue list",
    "git status",
  ].join("\n");
  const { violations, internalToolingOnly } = analyzeTranscript(transcript);
  assert.deepEqual(violations, []);
  assert.equal(internalToolingOnly, true);
});

test("agent-level raw gh api is a violation", () => {
  const { violations, internalToolingOnly } = analyzeTranscript("gh api repos/o/r/pulls/1/comments");
  assert.equal(internalToolingOnly, false);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /^gh:/);
});

test("a bash -c payload is audited per segment", () => {
  assert.ok(analyzeTranscript("bash -c 'true; gh pr list'").violations.length > 0);
  assert.ok(analyzeTranscript("bash -c 'true; python3 script.py'").violations.length > 0);
});

test("python and python3 are violations", () => {
  const { violations } = analyzeTranscript("python3 -c 'import json'\npython script.py");
  assert.equal(violations.length, 2);
  assert.match(violations[0], /^inline-interpreter:/);
  assert.match(violations[1], /^python:/);
});

test("node -e and node --eval are violations; node scripts/x.mjs is not", () => {
  const transcript = [
    "node -e 'console.log(1)'",
    "node --eval 'console.log(2)'",
    "node scripts/github/reply-resolve-review-threads.mjs --pr 1",
  ].join("\n");
  const { violations } = analyzeTranscript(transcript);
  assert.equal(violations.length, 2);
  assert.ok(violations.every((v) => v.startsWith("inline-interpreter:")));
});

test("--eval after the script path is a script arg, not inline eval — clean", () => {
  const transcript = [
    "node scripts/github/foo.mjs --eval 'console.log(1)'",
    "node scripts/loop/check-retro-tooling.mjs --transcript x --eval",
  ].join("\n");
  const { violations, internalToolingOnly } = analyzeTranscript(transcript);
  assert.equal(violations.length, 0);
  assert.equal(internalToolingOnly, true);
});

test("script-internal gh (node scripts/github/foo.mjs) does NOT trip the verifier", () => {
  const { violations, internalToolingOnly } = analyzeTranscript("node scripts/github/foo.mjs --gh api");
  assert.deepEqual(violations, []);
  assert.equal(internalToolingOnly, true);
});

test("gh after && / | / ; separator is caught", () => {
  const { violations } = analyzeTranscript("git fetch && gh pr view 1");
  assert.equal(violations.length, 1);
  assert.match(violations[0], /gh pr view/);
});

test("gh pr ready is still an allowed write-op (no wrapper-forbidden raw form)", () => {
  const { violations, allowedWriteOps, internalToolingOnly } = analyzeTranscript("gh pr ready 982");
  assert.deepEqual(violations, []);
  assert.equal(allowedWriteOps.length, 1);
  assert.equal(internalToolingOnly, true);
});

test("raw `gh pr merge` is a flagged violation now that merge-pr.mjs wraps it (issue #1939)", () => {
  const { violations, allowedWriteOps, internalToolingOnly } = analyzeTranscript("gh pr merge 982 --squash");
  assert.equal(violations.length, 1);
  assert.match(violations[0], /gh pr merge/);
  assert.deepEqual(allowedWriteOps, []);
  assert.equal(internalToolingOnly, false);
});

test("raw `gh issue create` is a violation now that create-issue.mjs wraps it", () => {
  const { violations, allowedWriteOps, internalToolingOnly } = analyzeTranscript("gh issue create --title x");
  assert.equal(violations.length, 1);
  assert.match(violations[0], /gh issue create/);
  assert.deepEqual(allowedWriteOps, []);
  assert.equal(internalToolingOnly, false);
});

test("representative mixed transcript classifies correctly", () => {
  const transcript = [
    "node scripts/loop/resolve-dev-loop-startup.mjs --input -",
    "gate capture-threads --pr 982",
    "gh api graphql -f query='...'",
    "python3 -c \"import json,sys; print(json.load(sys.stdin))\"",
    "node -e \"require('fs')\"",
    "gh pr merge 982 --squash",
    "git commit -m wip",
  ].join("\n");
  const { violations, allowedWriteOps, internalToolingOnly } = analyzeTranscript(transcript);
  assert.equal(internalToolingOnly, false);
  assert.equal(violations.length, 4); // gh api, python3, node -e, gh pr merge
  assert.equal(allowedWriteOps.length, 0); // gh pr merge is no longer allowlisted
});

test("env-prefixed, wrapper-prefixed, and path-prefixed raw calls are violations", () => {
  const cases = [
    ["GH_TOKEN=x gh api repos/o/r", "gh"],
    ["sudo gh api foo", "gh"],
    ["xargs gh api foo", "gh"],
    ["timeout 300 gh api repos/o/r", "gh"],
    ["timeout -k 5 60 gh pr view 1", "gh"],
    ["timeout --signal=KILL 1.5s gh api foo", "gh"],
    ["TIMEOUT 60 gh api foo", "gh"],
    ["timeout .5 gh api foo", "gh"],
    ["timeout 1e3 gh api foo", "gh"],
    ["NODE_OPTIONS=x node -e 'x'", "inline-interpreter"],
    ["./node_modules/.bin/gh pr view 1", "gh"],
    ["/usr/bin/python3 -c 'x'", "inline-interpreter"],
    ["/usr/bin/python3 script.py", "python3"],
  ];
  for (const [line, tool] of cases) {
    const { violations, internalToolingOnly } = analyzeTranscript(line);
    assert.equal(internalToolingOnly, false, `expected violation for: ${line}`);
    assert.equal(violations.length, 1, `expected one violation for: ${line}`);
    assert.ok(violations[0].startsWith(`${tool}:`), `expected ${tool} for: ${line} (got ${violations[0]})`);
  }
});

test("quoted env value with spaces does not under-report the real command", () => {
  // The space inside the quotes must not be mistaken for the env/command
  // separator; the real `gh api` head must still be classified as a violation.
  const cases = [
    'FOO="a b" gh api repos/o/r',
    "FOO='a b' gh api repos/o/r",
    'A=1 B="x y" gh api repos/o/r',
  ];
  for (const line of cases) {
    const { violations, internalToolingOnly } = analyzeTranscript(line);
    assert.equal(internalToolingOnly, false, `expected violation for: ${line}`);
    assert.equal(violations.length, 1, `expected one violation for: ${line}`);
    assert.ok(violations[0].startsWith("gh:"), `expected gh for: ${line} (got ${violations[0]})`);
  }
});

test("env prefix before an allowed node script stays clean", () => {
  const { violations, internalToolingOnly } = analyzeTranscript("env NODE_ENV=x node scripts/foo.mjs --pr 1");
  assert.deepEqual(violations, []);
  assert.equal(internalToolingOnly, true);
});

test("comments and blank lines are ignored", () => {
  const { violations } = analyzeTranscript("# this mentions gh api but is a comment\n\n   \n");
  assert.deepEqual(violations, []);
});

const SCRIPT = fileURLToPath(new URL("../../scripts/loop/check-retro-tooling.mjs", import.meta.url));

function runCli(args, stdinText) {
  return new Promise((resolve, reject) => {
    const child = spawn(Bun.which("node") ?? "node", [SCRIPT, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    // Chunked async writes with gaps let the child drain the pipe before EOF, which
    // is when a non-blocking stdin read fails, so the pipe runs dry before EOF as the old code hit.
    child.stdin.on("error", () => {});
    const text = stdinText ?? "";
    let closed = false;
    child.on("close", () => { closed = true; });
    (async () => {
      for (let i = 0; i < text.length && !closed; i += 16384) {
        if (!child.stdin.write(text.slice(i, i + 16384))) await new Promise((r) => child.stdin.once("drain", r).once("close", r));
        await new Promise((r) => setTimeout(r, 5));
      }
      child.stdin.end();
    })();
  });
}

function tmpFile(content) {
  const file = join(mkdtempSync(join(tmpdir(), "retro-tooling-")), "transcript.txt");
  writeFileSync(file, content);
  return file;
}

test("piped stdin over 64KB matches --transcript output", async () => {
  const transcript = Array.from({ length: 6000 }, (_, i) => `gh api repos/o/r/pulls/${i}/comments`).join("\n");
  assert.ok(transcript.length >= 200 * 1024);
  const viaFile = await runCli(["--json", "--transcript", tmpFile(transcript)]);
  const viaPipe = await runCli(["--json"], transcript);
  assert.equal(viaFile.status, 1);
  assert.equal(viaPipe.status, 1);
  assert.equal(viaPipe.stdout, viaFile.stdout);
  assert.equal(JSON.parse(viaPipe.stdout).rawCallViolations.length, 6000);
});

test("stdin read error rejects naming stdin and the cause, with no output", async () => {
  const stdin = new PassThrough();
  const out = [];
  const sink = { write: (s) => out.push(s) };
  const pending = run(["--json"], { stdout: sink, stderr: sink, stdin });
  stdin.destroy(new Error("boom"));
  await assert.rejects(pending, /stdin.*boom/);
  assert.deepEqual(out, []);
});

test("empty stdin exits 2 with 'empty transcript' and no clean result", async () => {
  const r = await runCli(["--json"], "  \n");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /empty transcript/);
  assert.doesNotMatch(r.stdout, /"ok":true/);
});

test("empty --transcript file exits 2 with 'empty transcript' and no clean result", async () => {
  const r = await runCli(["--json", "--transcript", tmpFile("\n \n")]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /empty transcript/);
  assert.doesNotMatch(r.stdout, /"ok":true/);
});

test("comment-only transcript is analyzed normally", async () => {
  const r = await runCli(["--json"], "# only a comment\n");
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).internalToolingOnly, true);
});

test("the retro report names every denied and every ceiling fixture row as inline-interpreter, and no other row (#2442)", () => {
  for (const { command, deny, ceiling } of INLINE_INTERPRETER_FORMS) {
    const reported = analyzeCommand(command).violations.filter((v) => v.startsWith("inline-interpreter: "));
    assert.deepEqual(reported, deny || ceiling ? [`inline-interpreter: ${command}`] : [], command);
  }
  const src = readFileSync(fileURLToPath(new URL("../../scripts/loop/check-retro-tooling.mjs", import.meta.url)), "utf8");
  assert.match(src, /inlineInterpreterVerdict, isPayloadWord, stripLeadingWrappers, tokenizeShellCommand \} from "@dev-loops\/core\/loop\/bash-command-classify"/);
  assert.doesNotMatch(src, /function stripLeadingWrappers|WRAPPER_BINARIES/);
});

test("a ceiling row gets a PreToolUse allow with no added output (#2442 decision 4)", () => {
  const ctx = { repoSlug: "mfittko/dev-loops", inManagedContext: true, managedRepoSlug: "mfittko/dev-loops" };
  let allowed = 0;
  for (const { command } of INLINE_INTERPRETER_FORMS.filter((row) => row.ceiling)) {
    const decision = decideBashGate({ command, ...ctx });
    // another rule (a wait loop, a raw gh write) may still deny the row; the inline-interpreter rule never does
    assert.doesNotMatch(decision.reason ?? "", /OPS-NO-INLINE-INTERPRETER/, command);
    if (decision.decision === "allow") {
      assert.deepEqual(decision, { decision: "allow" }, command);
      allowed += 1;
    }
  }
  assert.ok(allowed > 0);
});

test("the retro label names a python script call, and the inline form as inline-interpreter (#2943)", () => {
  assert.match(analyzeTranscript('node -e "x" /opt/python3/bin').violations[0], /^inline-interpreter:/);
  assert.match(analyzeTranscript("X=$(python3 -c x)").violations[0], /^inline-interpreter:/);
  assert.match(analyzeTranscript("python3 script.py").violations[0], /^python3:/);
  assert.match(analyzeTranscript("X=/opt/python/bin python3 script.py").violations[0], /^python3\b/);
});

test("retro classification of an unterminated quote and an escaped backtick before a separator (#2442)", () => {
  // input that does not parse is a gate deny (ADR 0276), so the retro reports it
  assert.deepEqual(analyzeTranscript("don't merge yet").violations, ["inline-interpreter: don't merge yet"]);
  assert.match(analyzeTranscript("echo \\` ; python3 x.py").violations[0], /^python3\b/);
});

test("retro joins a multi-line command: heredoc body lines and apostrophe-split message lines are not reported (#2442)", () => {
  assert.deepEqual(analyzeTranscript("cat > tmp/f.md <<'EOF'\nnode -e 'x'\npython3 -c y\nEOF\ngit status").violations, []);
  assert.deepEqual(analyzeTranscript("git commit -m \"fix: don't run\nnode -e x\nit's denied\"\ngit status").violations, []);
  assert.deepEqual(analyzeTranscript("git commit -m 'fix: the hook\ndenies node -e x\n'").violations, []);
  // a joined command is still classified as a whole
  assert.deepEqual(analyzeTranscript("cat > src/a.mjs <<'EOF'\nx\nEOF").violations, ["inline-interpreter: cat > src/a.mjs <<'EOF'\nx\nEOF"]);
  // a line that never closes stays one entry
  assert.deepEqual(analyzeTranscript("don't merge yet\ngit status").violations, ["inline-interpreter: don't merge yet"]);
});

test("retro splitter traverses command substitution (#2442)", () => {
  assert.match(analyzeTranscript('echo "$(true; gh pr list)"').violations[0], /^gh:/);
  assert.match(analyzeTranscript('echo "$(true; python3 script.py)"').violations[0], /^python3:/);
});

test("an unclosed line joins at most 200 lines and is reported (join cap)", () => {
  // the closing quote sits beyond the cap: inside the cap the three parts would join into one entry
  const { violations } = analyzeTranscript(['echo "a', ...Array.from({ length: 248 }, () => "ls"), '"'].join("\n"));
  assert.equal(violations[0], 'inline-interpreter: echo "a');
  assert.ok(violations.includes('inline-interpreter: "'));
  assert.ok(violations.every((v) => v.split("\n").length <= 200));
});

test("--transcript accepts several Claude Code session transcripts and extracts their Bash commands", async () => {
  const dir = mkdtempSync(join(tmpdir(), "retro-sessions-"));
  const session = (command) => `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "gh pr list" }, { type: "tool_use", name: "Bash", input: { command } }] } })}\n${JSON.stringify({ type: "user", message: { content: "gh api x" } })}\n`;
  const [a, b] = [join(dir, "a.jsonl"), join(dir, "b.jsonl")];
  writeFileSync(a, session("dev-loops loop info"));
  writeFileSync(b, `  ${session("gh api repos/o/r")}`); // indented JSONL line still parses as JSON
  const out = new PassThrough();
  let text = "";
  out.on("data", (chunk) => { text += chunk; });
  const code = await run(["--transcript", a, "--transcript", b, "--json"], { stdout: out, stderr: new PassThrough() });
  assert.equal(code, 1);
  assert.deepEqual(JSON.parse(text).rawCallViolations, ["gh: gh api repos/o/r"]);
});

const sessionLine = (...commands) => `${JSON.stringify({ type: "assistant", message: { content: commands.map((command) => ({ type: "tool_use", name: "Bash", input: { command } })) } })}\n`;

test("a session transcript piped on stdin extracts its Bash commands and reports the gh violation", async () => {
  const r = await runCli(["--json"], sessionLine("gh api repos/o/r"));
  assert.equal(r.status, 1);
  assert.deepEqual(JSON.parse(r.stdout).rawCallViolations, ["gh: gh api repos/o/r"]);
});

test("a heredoc body is dropped only for a data host; a quote-blind or arithmetic << hides nothing", async () => {
  const gh = "gh: gh api repos/o/r";
  for (const command of ["bash <<'EOF'\ngh api repos/o/r\nEOF", "sh <<EOF\ngh api repos/o/r\nEOF", 'echo "a << b"\ngh api repos/o/r', "echo 'a <<b'\ngh api repos/o/r", "x=$((1<<n))\ngh api repos/o/r", "cat <<EOF | bash\ngh api repos/o/r\nEOF", "cat > /tmp/x.sh <<'EOF'\ngh api repos/o/r\nEOF\nbash /tmp/x.sh", "cat <<'EOF' > x.sh && bash x.sh\ngh api repos/o/r\nEOF", "cat <<'EOF' > run.sh\ngh api repos/o/r\nEOF\nbash run.sh", "cat <<EOF\n$(gh api repos/o/r)\nEOF", "cat <<EOF\n# $(gh api repos/o/r)\nEOF", "cat <<EOF\nx # $(gh api repos/o/r)\nEOF", 'git commit -m "$(cat <<EOF\n# $(gh api repos/o/r)\nEOF\n)"', "git commit -F - <<''\n\ngh api repos/o/r\n"]) {
    const r = await runCli(["--json"], sessionLine(command));
    assert.equal(JSON.parse(r.stdout).internalToolingOnly, false, JSON.stringify(command));
    assert.ok(JSON.parse(r.stdout).rawCallViolations.some((v) => v === gh || v.startsWith("unproven heredoc:")), JSON.stringify(command));
  }
  const clean = await runCli(["--json"], sessionLine("cat <<'EOF'\ngh api repos/o/r\nEOF"));
  assert.deepEqual(JSON.parse(clean.stdout).rawCallViolations, []);
  // a `tee` heredoc writes a file: an OPS-NO-INLINE-INTERPRETER ceiling case, reported as inline-interpreter, never as a raw gh call
  const tee = await runCli(["--json"], sessionLine("tee out <<EOF\ngh text\nEOF"));
  assert.ok(JSON.parse(tee.stdout).rawCallViolations.every((v) => v.startsWith("inline-interpreter: tee out")));
});

test("a heredoc that is not provably data fails closed: mid-line #, nested heredoc, escaped substitution after #", async () => {
  for (const command of ["cat <<EOF\nx # $(gh api repos/o/r)\nEOF", 'git commit -m "$(cat <<EOF\n# $(gh api repos/o/r)\nEOF\n)"', "cat <<EOF\n# \\$(x) $(gh api repos/o/r)\nEOF", "cat <<EOF\n# `gh api repos/o/r`\nEOF", "dev-loops-run x <<EOF\nplain\nEOF"]) {
    const r = await runCli(["--json"], sessionLine(command));
    assert.equal(r.status, 1, JSON.stringify(command));
    assert.match(JSON.parse(r.stdout).rawCallViolations[0], /^unproven heredoc: /, JSON.stringify(command));
  }
});

test("fails closed: an unclosed heredoc, and a # after $( or a backtick outside any heredoc", async () => {
  for (const command of ["cat <<EOF\n# $(gh api repos/o/r)", 'echo "$(date)\n# $(gh api repos/o/r)"', "echo \"`date`\n# `gh api repos/o/r`\""]) {
    const r = await runCli(["--json"], sessionLine(command));
    assert.equal(r.status, 1, JSON.stringify(command));
    assert.match(JSON.parse(r.stdout).rawCallViolations[0], /^unproven heredoc: /, JSON.stringify(command));
  }
  const clean = await runCli(["--json"], sessionLine("git commit -m \"$(cat <<'EOF'\n# heading\nbody\nEOF\n)\""));
  assert.deepEqual(JSON.parse(clean.stdout).rawCallViolations, []);
});

test("a later line starting with # fails closed; a data heredoc # line and a leading comment stay clean", async () => {
  for (const command of ['echo "a\n# x"; gh api repos/o/r', "echo 'a\n#' && gh api repos/o/r", "ls\n  # note\nls"]) {
    const r = await runCli(["--json"], sessionLine(command));
    assert.equal(r.status, 1, JSON.stringify(command));
    assert.match(JSON.parse(r.stdout).rawCallViolations[0], /^unproven heredoc: /, JSON.stringify(command));
  }
  for (const command of ["# lead comment", "ls -la", "cat <<'EOF'\n# heading\ngh api repos/o/r\nEOF", "git commit -m \"$(cat <<'EOF'\nsubject\n\n# not a command\nEOF\n)\""]) {
    const r = await runCli(["--json"], sessionLine(command));
    assert.deepEqual(JSON.parse(r.stdout).rawCallViolations, [], JSON.stringify(command));
  }
});

test("a git commit -m substitution holding one cat heredoc is data; any other substitution keeps its body", async () => {
  const body = "fix\ngh api is no longer used";
  const clean = await runCli(["--json"], sessionLine(`git commit -m "$(cat <<'EOF'\n${body}\nEOF\n)"`));
  assert.deepEqual(JSON.parse(clean.stdout).rawCallViolations, []);
  for (const command of [`git commit -m "$(cat > f <<'EOF'\ngh api repos/o/r\nEOF\n)"`, `git commit -m "$(cat <<EOF\n$(gh api repos/o/r)\nEOF\n)"`]) {
    const r = await runCli(["--json"], sessionLine(command));
    assert.notDeepEqual(JSON.parse(r.stdout).rawCallViolations, [], JSON.stringify(command));
  }
});

test("a session with no Bash commands is clean, not an empty transcript", async () => {
  const file = tmpFile(`${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } })}\n`);
  const r = await runCli(["--json", "--transcript", file]);
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).internalToolingOnly, true);
});

test("a multi-line session command is one unit: heredoc bodies drop and continuations join", async () => {
  const heredoc = "git commit -F - <<'EOF'\nfix\ngh api is no longer used\nEOF";
  const r = await runCli(["--json"], sessionLine(heredoc, "dev-loops loop info \\\n  --json"));
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(JSON.parse(r.stdout).rawCallViolations, []);
  const real = await runCli(["--json"], sessionLine("git commit -F - <<EOF\nx\nEOF\ngh api repos/o/r"));
  assert.deepEqual(JSON.parse(real.stdout).rawCallViolations, ["gh: gh api repos/o/r"]);
});

test("a comment line ending in a backslash does not join the next command line", async () => {
  const r = await runCli(["--json"], sessionLine("# note \\\ngh api repos/o/r"));
  assert.equal(r.status, 1);
  assert.deepEqual(JSON.parse(r.stdout).rawCallViolations, ["gh: gh api repos/o/r"]);
});

test("a trailing comment ending in a backslash does not join the next command line", async () => {
  for (const command of ["echo hi # note \\\ngh api repos/o/r", "echo a \\\n# x \\\ngh api repos/o/r"]) {
    const r = await runCli(["--json"], sessionLine(command));
    assert.equal(r.status, 1, command);
    assert.deepEqual(JSON.parse(r.stdout).rawCallViolations, ["gh: gh api repos/o/r"], command);
  }
});

test("a word ending in an escaped backslash does not join the next command line", async () => {
  const r = await runCli(["--json"], sessionLine("echo C:\\\\\\\\\ngh api repos/o/r"));
  assert.equal(r.status, 1);
  assert.deepEqual(JSON.parse(r.stdout).rawCallViolations, ["gh: gh api repos/o/r"]);
});
