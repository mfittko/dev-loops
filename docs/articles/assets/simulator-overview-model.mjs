// Native Overview teaching model; its lifecycle record is not the Detailed schema.
export function createModel() {
  // ---------- starting conditions ----------
  const F = [
    {k:"config", lbl:".devloops config", type:"sel", opts:["loads","unknown key (stale CLI)"]},
    {k:"retro", lbl:"previous merge has its retro checkpoint", type:"bool", d:true},
    {k:"matrix", lbl:"issue has an AC / DoD matrix", type:"bool", d:true},
    {k:"prepr", lbl:"pre-PR review", type:"sel", opts:["clean","finds issues"]},
    {k:"lens", lbl:"review lenses", type:"sel", opts:["all report","one never reports"]},
    {k:"validation", lbl:"full validation", type:"sel", opts:["passes","fails once","incomplete (unknown)"]},
    {k:"findings", lbl:"draft gate findings", type:"sel", opts:["none","nits only","act, 1 round","act, 2 rounds","act, 4 rounds"]},
    {k:"acchange", lbl:"operator changes the AC after the draft gate", type:"bool", d:false},
    {k:"tripwire", lbl:"ADR tripwire at ready", type:"sel", opts:["no trigger","doc edit, waiver","new ADR"]},
    {k:"copilot", lbl:"Copilot review", type:"sel", opts:["no comments","comments"]},
    {k:"headmove", lbl:"someone pushes right before the merge", type:"bool", d:false},
    {k:"auth", lbl:"merge authorization", type:"sel", opts:["standing authorization","human approval required"]},
  ];
  const SCEN = [
    {id:"happy", name:"Clean run", issue:"#101 Name unknown keys in config load errors", about:"A refined issue that passes every gate on the first try.", shows:"The straight path: startup, implement, pre-PR review, draft PR, one draft gate round, ready, one pre-approval round, guarded merge, retro.", w:{}},
    {id:"fix", name:"Findings, two fix rounds", issue:"#102 Preflight --jq before mutations", about:"The draft gate finds real defects twice.", shows:"Each fix creates a new head. The old verdict goes stale and the round runs again on the new head until the judge returns an empty act list.", w:{findings:"act, 2 rounds"}},
    {id:"nits", name:"Nits only", issue:"#103 Tidy gate review prose", about:"The reviewers only report nits.", shows:"The judge defers or rejects them with a reason. Nothing reaches the fixer, so the head does not move and no new round starts.", w:{findings:"nits only"}},
    {id:"lens", name:"A lens never reports", issue:"#104 Same-head reuse for validation-only changes", about:"Three of four review lenses return. The fourth never writes its result.", shows:"Fan-in counts the results before anything else. Silence is not a pass: the join blocks and the missing lens is dispatched again.", w:{lens:"one never reports"}},
    {id:"unknown", name:"Validation unknown", issue:"#105 Map DoD suites to the targeted profile", about:"Full validation ends incomplete. It neither passed nor failed.", shows:"Unknown takes its own arrow. The guard does not count it as a pass; validation runs again before the judge sees the round.", w:{validation:"incomplete (unknown)"}},
    {id:"budget", name:"Fix window spent", issue:"#106 Judge-decided gate track", about:"Every round finds new defects.", shows:"After three fix rounds the window is spent. The loop stops and parks the PR for the operator instead of trying forever.", w:{findings:"act, 4 rounds"}},
    {id:"spec", name:"AC changes mid-run", issue:"#107 Strip carried angles from grouped dispatch", about:"After a clean draft gate, the operator authorizes a change to the acceptance criteria.", shows:"The code is unchanged, but the spec is now v2. Every clearance from v1 is stale and the work is reviewed again against v2.", w:{acchange:true}},
    {id:"stale", name:"Stale CLI", issue:"#108 Any issue", about:"An older published CLI meets a .devloops key it does not know.", shows:"The config fails to load. Startup fails closed with needs_reconcile instead of running the gates on silent defaults.", w:{config:"unknown key (stale CLI)"}},
    {id:"retro", name:"Retro missing", issue:"#109 The next unit in the queue", about:"The previous merge has no retro checkpoint yet.", shows:"The outer loop refuses to start new work until the retro is recorded.", w:{retro:false}},
    {id:"adr", name:"New ADR", issue:"#110 Launcher resolves CLI forms", about:"The PR adds a new architecture decision record.", shows:"The ADR tripwire fires at the ready boundary. Only the operator may waive it, so the PR parks.", w:{tripwire:"new ADR"}},
    {id:"race", name:"Push before merge", issue:"#111 Fail closed on config errors", about:"Everything is clean, then a new commit lands just before the merge.", shows:"The merge wrapper compares the head it checked with the head it merges. They differ, so it refuses and the new head is gated again.", w:{headmove:true}},
    {id:"human", name:"Human merge only", issue:"#112 Release v1.0.6", about:"The repo requires a person to approve every merge.", shows:"The gates are clean, but evidence is not authority. The PR waits for the operator.", w:{auth:"human approval required"}},
    {id:"fresh", name:"New idea", issue:"#113 A quick idea from the operator", about:"A new issue with no acceptance criteria yet, and a first draft with problems.", shows:"The grill turns the idea into an AC / DoD matrix first. The pre-PR review sends the draft back before anything is pushed.", w:{matrix:false, prepr:"finds issues"}},
  ];
  const W = 128, H = 46;
  const P = { startup:[300,50], reconcile:[560,50], grill:[40,140], implement:[300,140], prepr:[300,230], pr:[300,320], review:[300,410], join:[300,500], judge:[300,590], fix:[40,500], ready:[560,410], park:[560,500], merge:[560,590], retro:[560,680] };
  const SUB = { startup:"resolve state", reconcile:"needs_reconcile", grill:"AC / DoD matrix", implement:"developer · worktree", prepr:"before first push", pr:"push · draft PR", review:"lenses + validation", join:"fan-in · guards", judge:"act / defer / reject", fix:"fixer · new head", ready:"tripwire · Copilot", park:"operator decides", merge:"merge-pr.mjs", retro:"checkpoint" };
  const NAME = { prepr:"pre-PR review", pr:"draft PR", review:"gate round", join:"fan-in", fix:"fixer", ready:"ready" };
  const EXIT = new Set(["reconcile","park"]);
  const GATE = new Set(["join"]);
  const CT = { startup:[["coordinator","lead"],["script","code"]], reconcile:[["script","code"]], grill:[["refiner","llm"],["operator","human"]], implement:[["developer","llm"]], prepr:[["reviewer","llm"]], pr:[["coordinator","lead"],["script","code"]], review:[["gate-coordinator","lead"],["reviewer","llm"]], join:[["gate-coordinator","lead"],["script","code"]], judge:[["judge","llm"]], fix:[["fixer","llm"]], ready:[["coordinator","lead"],["script","code"]], park:[["operator","human"]], merge:[["orchestrator","lead"],["script","code"]], retro:[["retro agent","llm"]] };
  const E = [
    {id:"s-start", d:"M364 31 L364 50"},
    {id:"st-rec", cond:1, d:"M428 73 L560 73", l:["fails closed",494,65,"middle"]},
    {id:"st-grill", cond:1, d:"M300 80 C 230 92, 104 104, 104 140", l:["no matrix",150,100]},
    {id:"st-impl", cond:1, d:"M364 96 L364 140", l:["ready to build",372,124]},
    {id:"grill-impl", d:"M168 163 L300 163"},
    {id:"impl-prepr", d:"M364 186 L364 230"},
    {id:"prepr-impl", cond:1, loop:1, d:"M428 246 C 480 238, 480 176, 432 168", l:["findings",484,210]},
    {id:"prepr-pr", cond:1, d:"M364 276 L364 320", l:["clean",372,304]},
    {id:"pr-review", d:"M364 366 L364 410"},
    {id:"review-join", d:"M364 456 L364 500"},
    {id:"join-review", cond:1, loop:1, d:"M428 512 C 482 504, 482 452, 432 446", l:["re-run",488,482]},
    {id:"join-judge", cond:1, d:"M364 546 L364 590", l:["complete",372,574]},
    {id:"join-fix", cond:1, d:"M300 523 L168 523", l:["tests fail",234,515,"middle"]},
    {id:"judge-fix", cond:1, loop:1, d:"M300 610 C 220 610, 104 594, 104 546", l:["act",178,616]},
    {id:"fix-review", loop:1, d:"M104 500 C 104 448, 200 440, 300 440", l:["new head",132,458]},
    {id:"judge-ready", cond:1, d:"M420 590 C 470 540, 500 470, 560 450", l:["draft clean",470,532]},
    {id:"judge-park", cond:1, d:"M428 605 C 480 600, 520 560, 560 538", l:["window spent",498,600,"middle"]},
    {id:"judge-merge", cond:1, d:"M428 618 L560 618", l:["pre-approval clean",494,636,"middle"]},
    {id:"ready-review", cond:1, d:"M560 423 L432 423", l:["pre-approval",496,415,"middle"]},
    {id:"ready-park", cond:1, d:"M624 456 L624 500", l:["new ADR",632,482]},
    {id:"merge-park", cond:1, d:"M600 590 L600 550", l:["approval",544,574]},
    {id:"merge-review", cond:1, loop:1, d:"M688 613 C 744 600, 744 380, 600 380 C 470 380, 440 392, 420 410", l:["head moved",690,372]},
    {id:"merge-retro", cond:1, d:"M624 636 L624 680", l:["merged",632,662]},
    {id:"retro-end", d:"M560 703 C 470 703, 410 742, 376 756"},
    {id:"park-end", d:"M688 523 C 726 540, 726 744, 378 762"},
    {id:"rec-end", d:"M688 73 C 752 73, 752 768, 378 768"},
  ];
  const HEADS = "ABCDEFGHIJ";
  function freshState(){ return { config:"—", retro:"—", spec:"v1", matrix:"—", head:"—", pr:"none", gate:"—", round:0, lenses:"—", validation:"—", act_list:"—", fix_rounds:0, verdict_head:"—", tripwire:"—", authorization:"—", status:"—" }; }
  const NEEDED = {"none":0,"nits only":0,"act, 1 round":1,"act, 2 rounds":2,"act, 4 rounds":4};
  const WINDOW = 3;

  const L = {
    closed:{tag:"Fail closed", txt:"A config that does not load cannot decide a gate. Startup stops instead of running every gate on silent defaults.", slide:"Slide 13: advancement requires evidence"},
    order:{tag:"One state, one next action", txt:"The outer loop reads the record and refuses to start new work while the previous unit is unfinished. The retro checkpoint is part of finishing.", slide:"Slides 20 and 22: routing rules and the outer loop"},
    grill:{tag:"Make the goal testable", txt:"Questions until the goal, scope and evidence are clear. Agents may propose answers; a person decides intent and tradeoffs.", slide:"Slide 7: the grilling sub-loop"},
    card:{tag:"A job card for the worker", txt:"The developer gets the target, the required reads, one bounded next action and the stop rules. It works in its own worktree.", slide:"Slide 21: give the worker a job card"},
    prepr:{tag:"Review before the first push", txt:"Findings at this point cost a local edit. After the push they cost a full gate round.", slide:"Slide 14: try again needs a reason"},
    record:{tag:"The PR is the shared record", txt:"From here on, the head SHA, CI, verdicts and threads live on the pull request, where any session can read them.", slide:"Slide 18: apply it to AI development"},
    fan:{tag:"Fan out over one version", txt:"Every lens reviews the same head, and validation runs on that head. Results that name another head do not count.", slide:"Slides 16 and 23: parallel work and the review round"},
    join:{tag:"The join has its own guard", txt:"Fan-in first checks that every required lens reported, then that validation has a result. Missing or unknown blocks the round.", slide:"Slide 17: two passes and a missing check"},
    unknown:{tag:"Unknown takes another arrow", txt:"Incomplete validation is not a pass and not a fail. The round runs validation again before anyone judges the findings.", slide:"Slide 11: unknown takes another arrow"},
    judge:{tag:"Only actionable work goes to the fixer", txt:"The judge weighs each finding against the issue's AC, DoD and non-goals. Act goes to the fixer; defer and reject are resolved with a reason.", slide:"Slide 23: a review round has an output contract"},
    fresh:{tag:"Each revision needs current evidence", txt:"The fix is a new head. Every verdict for the old head is now stale, so the round runs again on the new head.", slide:"Slide 27: each revision needs current evidence"},
    budget:{tag:"An exhausted budget pauses the work", txt:"The fix window is spent. The loop records the state and stops; the operator extends the budget, changes the scope or stops.", slide:"Slide 37: an exhausted budget pauses the work"},
    spec:{tag:"Changed criteria require fresh clearance", txt:"The spec digest changed. The code did not, but every approval derived from v1 is stale. The existing work is reviewed against v2.", slide:"Slide 12: changed criteria require fresh clearance"},
    trip:{tag:"Authority stays with the operator", txt:"A doc edit that the AC requires may pass with a waiver, and only the operator writes it. A new ADR parks the PR.", slide:"Slide 29: publishing requires separate authorization"},
    race:{tag:"The merge checks the actual version", txt:"merge-pr.mjs pins the merge to the head it checked. A newer head makes it refuse, so the unchecked version cannot slip in.", slide:"Slide 30: the merge checks the actual version"},
    auth:{tag:"Evidence is not authority", txt:"Clean gates show what was checked. Whether the merge may happen is a separate decision.", slide:"Slide 29: publishing requires separate authorization"},
    retro:{tag:"Close the outer loop", txt:"The retro reads the run's transcripts and records a checkpoint. Its findings become comments or issues. The next unit may start now.", slide:"Slide 22: a loop can contain another loop"},
    end:{tag:"Run complete", txt:"The record now holds everything the next startup needs.", slide:""},
  };
  function relevant(world, k){
    if (k === "config") return true;
    if (world.config !== "loads") return false;
    if (k === "retro") return true;
    if (!world.retro) return false;
    if (k === "headmove" || k === "auth" || k === "copilot") return world.tripwire !== "new ADR" && world.findings !== "act, 4 rounds";
    if (k === "tripwire" || k === "acchange") return world.findings !== "act, 4 rounds";
    return true;
  }
  function defaults(world){ F.forEach(f => world[f.k] = f.type==="bool" ? f.d : f.opts[0]); }
  function fresh(){ return { n:0, st:freshState(), prev:null, out:{}, by:{}, read:[], pending:["startup"], active:[], ran:[], taken:[], trace:[], done:false, title:"Ready", note:"Nothing has run yet. Press Next step.", lens:null, reply:null, h:-1, f:{} }; }
  function take(S, id){ if (!S.taken.includes(id)) S.taken.push(id); }
  function mark(S, k){ if (!S.ran.includes(k)) S.ran.push(k); }
  function out(S, n, t, tone){ S.out[n] = {t, tone}; }
  function wrote(S, n, keys){ keys.forEach(k => S.by[k] = n); }
  function newHead(S){ S.h++; return HEADS[S.h] || "Z"; }
  function advance(S, world, previous){
    const s = S.st, f = S.f, node = S.pending[0]; S.active = [node]; S.reply = null; mark(S, node);
    if (node === "startup"){
      take(S, "s-start");
      s.config = world.config === "loads" ? "loaded" : "load error: unknown key";
      s.retro = world.retro ? "recorded" : "missing";
      s.matrix = world.matrix ? "present" : "missing";
      wrote(S, "startup", ["config","retro","matrix"]); S.read = ["config","retro","matrix"];
      S.title = "loop startup"; S.note = "Startup reads the issue, the board, GitHub and the local artifacts, then derives one next action.";
      if (world.config !== "loads"){ take(S, "st-rec"); S.pending = ["reconcile"]; S.reason = "the .devloops config did not load"; out(S, "startup","config error","no"); S.lens = L.closed; S.trace.push("startup: config load error (unknown key) → needs_reconcile"); }
      else if (!world.retro){ take(S, "st-rec"); S.pending = ["reconcile"]; S.reason = "the previous merge has no retro checkpoint"; out(S, "startup","no retro","no"); S.lens = L.order; S.trace.push("startup: previous merge has no retro checkpoint → needs_reconcile"); }
      else if (!world.matrix){ take(S, "st-grill"); S.pending = ["grill"]; out(S, "startup","→ grill","info"); S.lens = L.order; S.trace.push("startup: no AC / DoD matrix → grill first"); }
      else { take(S, "st-impl"); S.pending = ["implement"]; out(S, "startup","→ implement","info"); S.lens = L.order; S.trace.push("startup: refined issue, retro recorded → implement"); }
    }
    else if (node === "reconcile"){
      s.status = "needs_reconcile"; wrote(S, "reconcile", ["status"]); take(S, "rec-end");
      S.title = "needs_reconcile"; S.note = "No code runs and nothing is pushed. The operator fixes the cause and starts again.";
      S.reply = {cls:"fixed", lbl:"Startup result", txt:"Stopped at needs_reconcile: " + S.reason + ". Nothing was dispatched."};
      out(S, "reconcile","stopped","no"); S.lens = S.reason.includes("config") ? L.closed : L.order; S.pending = ["END"];
      S.trace.push("reconcile: stop and report the reason");
    }
    else if (node === "grill"){
      take(S, "grill-impl"); s.matrix = "present"; wrote(S, "grill", ["matrix"]); out(S, "grill","matrix recorded","yes");
      S.title = "grill"; S.note = "The grill writes the acceptance criteria, completion evidence and non-goals into the issue body. Next Up refuses an issue without them.";
      S.lens = L.grill; S.pending = ["implement"]; S.trace.push("grill: AC / DoD matrix and non-goals recorded");
    }
    else if (node === "implement"){
      take(S, "impl-prepr"); s.head = newHead(S) + " (local)"; wrote(S, "implement", ["head"]); out(S, "implement","head " + HEADS[S.h],"info");
      S.title = "implement"; S.note = f.prepr ? "The developer addresses the pre-PR findings. Still nothing is pushed." : "The developer writes the change and its tests in a worktree under tmp/worktrees/. Targeted checks run locally.";
      S.lens = L.card; S.pending = ["prepr"]; S.trace.push(`implement: commit ${HEADS[S.h]} in the worktree`);
    }
    else if (node === "prepr"){
      if (world.prepr === "finds issues" && !f.prepr){ f.prepr = 1; take(S, "prepr-impl"); out(S, "prepr","2 findings","no"); S.pending = ["implement"]; S.trace.push("pre-PR review: 2 findings → back to the developer"); }
      else { take(S, "prepr-pr"); out(S, "prepr","clean","yes"); S.pending = ["pr"]; S.trace.push("pre-PR review: clean"); }
      S.title = "pre-PR review"; S.note = "A fresh reviewer reads the diff before the first push. This step is a must."; S.lens = L.prepr;
    }
    else if (node === "pr"){
      take(S, "pr-review"); s.head = HEADS[S.h]; s.pr = "#42 draft"; s.gate = "draft_gate"; s.round = 1; wrote(S, "pr", ["head","pr","gate","round"]); out(S, "pr","#42 draft","info");
      S.title = "push · draft PR"; S.note = "The branch is pushed and the PR is created as a draft. Its body carries the AC, DoD and non-goals."; S.lens = L.record; S.pending = ["review"];
      S.trace.push(`pr: push ${s.head}, create draft PR #42`);
    }
    else if (node === "review"){
      take(S, "review-join");
      s.lenses = world.lens === "one never reports" && !f.redispatch ? "3 of 4" : "4 of 4";
      const v = world.validation;
      s.validation = (v === "fails once" && !f.valfixed ? "fail" : v === "incomplete (unknown)" && !f.valretry ? "unknown" : "pass") + " @" + s.head;
      wrote(S, "review", ["lenses","validation"]); out(S, "review", `${s.lenses} · ${s.validation.split(" ")[0]}`, s.lenses === "4 of 4" && s.validation.startsWith("pass") ? "yes" : "no");
      S.title = `${s.gate} · round ${s.round}`; S.note = "The gate coordinator dispatches the review lenses for this head and runs full validation once.";
      S.lens = L.fan; S.pending = ["join"]; S.trace.push(`review: ${s.gate} round ${s.round} on ${s.head}: ${s.lenses} lenses, validation ${s.validation}`);
    }
    else if (node === "join"){
      S.read = ["lenses","validation","head"];
      S.title = "fan-in"; S.note = "A script, not a model, checks coverage and validation before the judge runs.";
      if (s.lenses !== "4 of 4"){ f.redispatch = 1; take(S, "join-review"); out(S, "join","lens missing → re-dispatch","no"); S.lens = L.join; S.pending = ["review"]; S.trace.push("fan-in: 3 of 4 lenses → blocked, re-dispatch the missing lens"); }
      else if (s.validation.startsWith("unknown")){ f.valretry = 1; take(S, "join-review"); out(S, "join","unknown → re-run","no"); S.lens = L.unknown; S.pending = ["review"]; S.trace.push("fan-in: validation unknown → not a pass, run it again"); }
      else if (s.validation.startsWith("fail")){ take(S, "join-fix"); s.act_list = "1 failing test"; wrote(S, "join", ["act_list"]); out(S, "join","tests fail","no"); S.lens = L.join; S.pending = ["fix"]; S.trace.push("fan-in: validation failed → the failing test goes to the fixer"); }
      else { take(S, "join-judge"); out(S, "join","complete","yes"); S.lens = L.join; S.pending = ["judge"]; S.trace.push("fan-in: every lens reported, validation passed"); }
    }
    else if (node === "judge"){
      S.read = ["gate","fix_rounds","spec"];
      S.title = "judge"; S.note = "The judge reads the consolidated findings against the issue's AC, DoD and non-goals.";
      const draft = s.gate === "draft_gate";
      const needs = draft ? s.fix_rounds < NEEDED[world.findings] : world.copilot === "comments" && !f.copilot;
      if (needs && s.fix_rounds >= WINDOW){ take(S, "judge-park"); s.act_list = "3 act · window spent"; out(S, "judge","window spent","no"); S.reason = `the fix window of ${WINDOW} rounds is spent`; S.lens = L.budget; S.pending = ["park"]; S.trace.push(`judge: still 3 act findings after ${WINDOW} fix rounds → park`); }
      else if (needs){ take(S, "judge-fix"); s.act_list = draft ? "2 act · 1 defer" : "2 act (Copilot)"; out(S, "judge", draft ? "2 act" : "2 act (Copilot)", "no"); S.lens = L.judge; S.pending = ["fix"]; S.trace.push(`judge: ${s.act_list} → fixer`); }
      else {
        s.act_list = world.findings === "nits only" && draft ? "0 act · 2 defer · 1 reject" : "0 act"; s.verdict_head = s.head + " · spec " + s.spec;
        wrote(S, "judge", ["verdict_head"]); out(S, "judge","clean","yes"); S.lens = L.judge;
        if (draft){ take(S, "judge-ready"); S.pending = ["ready"]; S.trace.push(`judge: ${s.act_list} → draft gate clean on ${s.head}`); }
        else { take(S, "judge-merge"); s.status = "final_approval_ready"; wrote(S, "judge", ["status"]); S.pending = ["merge"]; S.trace.push(`judge: 0 act → pre-approval clean, final_approval_ready on ${s.head}`); }
      }
      wrote(S, "judge", ["act_list"]);
    }
    else if (node === "fix"){
      take(S, "fix-review"); s.fix_rounds++; const hd = newHead(S); s.head = hd; s.round++;
      if (s.act_list.startsWith("1 failing")) f.valfixed = 1;
      if (s.gate === "pre_approval_gate") f.copilot = 1;
      s.verdict_head = s.verdict_head === "—" ? "—" : s.verdict_head.split(" ")[0] + " (stale)";
      wrote(S, "fix", ["head","fix_rounds","round","verdict_head"]); out(S, "fix","push " + hd,"info");
      S.title = "fixer"; S.note = "The fixer works only the act list, runs the delta pre-push review, pushes and replies on each thread.";
      S.lens = L.fresh; S.pending = ["review"]; S.trace.push(`fixer: round ${s.fix_rounds}, push ${hd} → re-gate`);
    }
    else if (node === "ready"){
      S.read = ["spec","verdict_head"];
      S.title = "ready boundary";
      if (world.acchange && s.spec === "v1"){
        s.spec = "v2"; s.verdict_head = s.head + " (stale: spec v1)"; s.round++; take(S, "ready-review"); wrote(S, "ready", ["spec","verdict_head","round"]);
        out(S, "ready","spec v2 → re-gate","no"); S.lens = L.spec; S.pending = ["review"];
        S.note = "The operator approved an AC change in the issue. The same head is reviewed again against v2."; S.trace.push("ready: spec changed to v2 → every v1 clearance is stale, re-gate the same head");
      }
      else if (world.tripwire === "new ADR"){
        s.tripwire = "new ADR"; take(S, "ready-park"); wrote(S, "ready", ["tripwire"]); out(S, "ready","tripwire","no");
        S.reason = "the ADR tripwire fired on a new ADR"; S.lens = L.trip; S.pending = ["park"];
        S.note = "The tripwire runs before the PR leaves draft."; S.trace.push("ready: ADR tripwire fired (new ADR) → park");
      }
      else {
        s.tripwire = world.tripwire === "doc edit, waiver" ? "waived by operator" : "clear";
        s.pr = "#42 ready"; s.gate = "pre_approval_gate"; s.round = 1; take(S, "ready-review");
        wrote(S, "ready", ["tripwire","pr","gate","round"]); out(S, "ready","ready · Copilot","info");
        S.lens = world.tripwire === "doc edit, waiver" ? L.trip : L.record; S.pending = ["review"];
        S.note = "The PR leaves draft and Copilot is asked for a review. The pre-approval gate starts on the same head.";
        S.trace.push(`ready: tripwire ${s.tripwire}; mark ready, request Copilot → pre_approval_gate`);
      }
    }
    else if (node === "merge"){
      S.read = ["head","verdict_head","authorization"];
      S.title = "guarded merge";
      if (world.headmove && !f.moved){
        f.moved = 1; const hd = newHead(S); s.head = hd; s.round++; s.status = "head moved"; take(S, "merge-review");
        wrote(S, "merge", ["head","round","status"]); out(S, "merge","head mismatch","no"); S.lens = L.race; S.pending = ["review"];
        S.note = `The verdict names ${s.verdict_head.split(" ")[0]}, but the PR head is now ${hd}. The wrapper refuses.`; S.trace.push(`merge: verdict head ≠ PR head ${hd} → refuse, re-gate`);
      }
      else if (world.auth === "human approval required"){
        s.authorization = "waiting for the operator"; take(S, "merge-park"); wrote(S, "merge", ["authorization"]); out(S, "merge","needs approval","no");
        S.reason = "the merge needs a human approval"; S.lens = L.auth; S.pending = ["park"];
        S.note = "Preconditions pass. The repo policy still requires a person to approve."; S.trace.push("merge: preconditions pass, human approval required → park");
      }
      else {
        s.authorization = "standing"; s.status = "merged"; take(S, "merge-retro"); wrote(S, "merge", ["authorization","status"]); out(S, "merge","merged","yes");
        S.lens = L.race; S.pending = ["retro"];
        S.note = `The wrapper checks the verdict head against the PR head and merges pinned to ${s.head}.`; S.trace.push(`merge: head ${s.head} matches, standing authorization → merged`);
        S.reply = {cls:"answer", lbl:"On the PR", txt:`Merged at ${s.head}, pinned to the head the gates checked.`};
      }
    }
    else if (node === "park"){
      s.status = "parked"; wrote(S, "park", ["status"]); take(S, "park-end"); out(S, "park","parked","no");
      S.title = "park for the operator"; S.note = "The loop stops at a safe point. The worktree is clean and the record says why.";
      S.reply = {cls:"fixed", lbl:"Hand-back to the operator", txt:"Parked: " + S.reason + ". The operator decides the next step."};
      S.lens = S.reason.includes("window") ? L.budget : S.reason.includes("ADR") ? L.trip : L.auth; S.pending = ["END"]; S.trace.push("park: hand back with the reason");
    }
    else if (node === "retro"){
      take(S, "retro-end"); s.retro = "recorded for #42"; wrote(S, "retro", ["retro"]); out(S, "retro","recorded","yes");
      S.title = "retro"; S.note = "A fresh agent reads the run's transcripts and the gate artifacts, then records the checkpoint.";
      S.lens = L.retro; S.pending = ["END"]; S.trace.push("retro: findings logged, checkpoint recorded");
      S.reply = previous.reply;
    }
    else if (node === "END"){
      S.done = true; S.trace.push("END");
      S.title = "END"; S.note = "Back steps through it again; Reset or another scenario starts over."; S.lens = L.end;
      S.reply = previous.reply;
    }
  }
  return { F, SCEN, W, H, P, SUB, NAME, EXIT, GATE, CT, E, defaults, fresh, freshState, advance, relevant };
}
