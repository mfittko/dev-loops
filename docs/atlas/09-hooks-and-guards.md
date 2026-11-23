---
title: Hooks, guards and permissions
status: snapshot
snapshot_date: 2026-11-23
source_commit: f6619004d3edc2caccc98edd96914a5706c5d59b
---
<a id="09-hooks-and-guards"></a>

## Hooks, guards and permissions

dev-loops enforces its workflow contracts at the tool-call boundary, before a command or write runs. Under Claude Code, eight hook scripts in `.claude/hooks` read the hook payload on stdin, gather facts (git state, repo identity, gate evidence), and call pure deciders. A deny is a `permissionDecision: "deny"` JSON object on stdout with exit 0 (`_hook-io.mjs`); the SubagentStop block uses exit 2 and a JSON reason on stderr. Most Bash rules live in one harness-neutral module, `packages/core/src/loop/bash-gate-decisions.mjs`, vendored into `.claude/hooks/_bash-gate-decisions.mjs` by `scripts/claude/generate-claude-assets.mjs`. Pi has a separate `tool_call` gate in `extension/readonly-role-gate.ts`. That gate restricts only the read-only roles. Per the cross-harness contract, the Claude seam is the only consumer of the shared deny set today. A code search finds no `decideBashGateDeny` caller outside the Claude seam, so Pi use of the shared set is spec-only. Permissions add one more layer. The project `.claude/settings.json` allows two Bash prefixes: `Bash(node scripts/github/edit-issue.mjs:*)` and `Bash(dev-loops-run:*)`. Any other repo script matches a project allow rule only when it runs through the `dev-loops-run` launcher.

<a id="d113"></a>

### Hook wiring by event and matcher

Type: `flowchart`

Shows which harness event and tool matcher fires each hook script, and which pure decider each script calls. Both registrations point at the same scripts: the project registration uses `${CLAUDE_PROJECT_DIR}` and the plugin registration uses `${CLAUDE_PLUGIN_ROOT}`. The insight: each PreToolUse and SubagentStop script only gathers facts at the edge, and every allow or deny comes from a decider in `_hook-decisions.mjs`, `_bash-gate-decisions.mjs` or `_ask-merge-approval.mjs`. The two PostToolUse scripts never block. The Bash one calls the `syncMainCheckout` helper in `_main-checkout-ff.mjs`. The AskUserQuestion one records a yes answer to the merge approval question. Derived from `.claude/settings.json`, `.claude/hooks/hooks.json`, `.claude/hooks/pre-tool-use-approval-guard.mjs`, `.claude/hooks/pre-tool-use-ask-answers-guard.mjs`, `.claude/hooks/post-tool-use-ask-approval.mjs`, `.claude/hooks/pre-tool-use-bash-gate.mjs`, `.claude/hooks/pre-tool-use-write-guard.mjs`, `.claude/hooks/pre-tool-use-agent-guard.mjs`, `.claude/hooks/post-tool-use-merge.mjs` and `.claude/hooks/subagent-stop-uncommitted-guard.mjs`.

```mermaid
flowchart LR
  subgraph EV["Claude Code events"]
    PR["PreToolUse: Bash, Read, Edit, Write, NotebookEdit, Grep, Glob, mcp"]
    PQ["PreToolUse: AskUserQuestion"]
    PB["PreToolUse: Bash"]
    PW["PreToolUse: Edit or Write"]
    PA["PreToolUse: Agent or Task"]
    PK["PostToolUse: AskUserQuestion"]
    PO["PostToolUse: Bash"]
    SS["SubagentStop: *"]
  end
  subgraph HK["hook scripts"]
    RG["pre-tool-use-approval-guard"]
    QG["pre-tool-use-ask-answers-guard"]
    BG["pre-tool-use-bash-gate"]
    WG["pre-tool-use-write-guard"]
    AG["pre-tool-use-agent-guard"]
    PK2["post-tool-use-ask-approval"]
    PM["post-tool-use-merge"]
    SG["subagent-stop-uncommitted-guard"]
  end
  subgraph DC["pure deciders"]
    D9["approvalNameHit / isApprovalPath"]
    D10["hasApprovalQuestion"]
    D1["decideBashGate"]
    D2["decideBashGateDeny"]
    D3["decideFixerWriteGuard / decideJudgeWriteGuard"]
    D4["decideWorktreeCheckoutGuard"]
    D5["decideWriteGuard / decideCoordinatorWriteGuard"]
    D6["decideAgentDispatch"]
    D7["decideSubagentStopGuard"]
  end
  subgraph HP["non-blocking helpers"]
    D11["extractYesApproval, signed record and approve line"]
    D8["syncMainCheckout ff-only"]
  end
  PR --> RG --> D9
  PQ --> QG --> D10
  PK --> PK2 --> D11
  PB --> BG --> D1 --> D2
  PW --> WG --> D3
  WG --> D4
  WG --> D5
  PA --> AG --> D6
  PO --> PM --> D8
  SS --> SG --> D7
```

<a id="d114"></a>

### Bash gate pre-check and decision

Type: `flowchart`

Shows the control flow of `pre-tool-use-bash-gate.mjs`. The hook has no pre-check list: every command reaches `decideBashGate`. The repo-identity lookup (`git rev-parse` and the origin slug) runs first for every command, because the gh-api predicates need the managed slug. In a managed checkout the whole-command token rule (`segmentWriteKind`) classifies the command once as a comment write, a body write or neither. A `gh pr ready` or `gh pr merge` with a PR number gets the gate evidence probe, then `decideBashGate`. That seam decider runs the unresolve owner check, the judge boundary and the fixer pull boundary before it delegates to `decideBashGateDeny`. A decider deny exits first. For a comment write, a generic raw-write deny gets the OPERATOR-OWNED-LINE comment reason instead. The token rule verdict applies last. It denies a raw comment or body write even behind a wrapper such as `timeout` or `sudo`. The insight: the managed-repo test is a `.devloops` config file at the repo root (bare, `.yaml`, `.yml` or `.json`), so the same guards apply in any consumer repo. Derived from `.claude/hooks/pre-tool-use-bash-gate.mjs` and `.claude/hooks/_bash-command-classify.mjs`.

```mermaid
flowchart TD
  IN["stdin payload: command, agent_type, cwd"] --> FX{"fixer and exact pull line?"}
  FX -- yes --> BIND["record fixer grant binding"]
  FX -- no --> ID
  BIND --> ID["git toplevel + origin slug"]
  ID --> MG{".devloops config at root?"}
  MG -- "yes: managed slug set" --> WK["segmentWriteKind: comment, body or null"]
  MG -- "no: managed slug null, no probe" --> DEC
  WK --> MERGE{"gh pr merge?"}
  MERGE -- yes --> HMO["resolve-human-merge-only.mjs"]
  MERGE -- no --> PROBE
  HMO --> PROBE{"ready or merge PR number and slug known?"}
  PROBE -- yes --> GATE["run gate script via dev-loops-run"]
  PROBE -- no --> DEC
  GATE --> DEC["decideBashGate(facts)"]
  DEC --> SEAM{"unresolve, judge or fixer-pull deny?"}
  SEAM -- yes --> DENY(["emitDeny(reason, or comment reason for a comment write)"])
  SEAM -- no --> SH{"decideBashGateDeny returns a deny?"}
  SH -- yes --> DENY
  SH -- no --> TOK
  TOK{"write kind?"}
  TOK -- comment --> DENYC(["deny: OPERATOR-OWNED-LINE"])
  TOK -- body --> DENY2(["deny: ADR-TRIPWIRE-STANDING-WAIVER"])
  TOK -- null --> ALLOW(["exit 0: allow"])
```

<a id="d115"></a>

### Shared deny rule evaluation order

Type: `flowchart`

Shows the fixed order in which `decideBashGate` and then `decideBashGateDeny` check their rules. The first match wins. The three seam checks (unresolve owner, judge boundary, fixer pull boundary) run in `_hook-decisions.mjs` before the shared set, which runs the unresolve check again as its own first rule. `BASH_GATE_RULES` holds 13 registered rule IDs (count from `sed -n '/BASH_GATE_RULES = Object.freeze/,/]);/p' .claude/hooks/_bash-gate-decisions.mjs | grep -c '^  "'`). Five denies carry `ruleId: null` (count from `grep -cE '^ +ruleId: null,$' .claude/hooks/_bash-gate-decisions.mjs`): the missing-facts refusal, the unresolve owner allowlist, the subagent merge-pr deny, the `timeout` wrapper deny and the subagent external-write deny. The insight: an omitted or mistyped fact is refused before any rule runs, so a default cannot switch a deny off. The wait-tool deny also runs before the lifecycle verbs, so `gh pr create ... && probe &` cannot reach an allow path first. Derived from `.claude/hooks/_bash-gate-decisions.mjs` (generated from `packages/core/src/loop/bash-gate-decisions.mjs`).

```mermaid
flowchart TD
  S0["seam: unresolve owner"] --> S1["seam: judge boundary"]
  S1 --> S2["seam: fixer pull boundary"]
  S2 --> F
  F["facts valid?"] -- no --> X0["deny: missing facts"]
  F -- yes --> R0["unresolve owner allowlist"]
  R0 --> RM["subagent merge-pr deny"]
  RM --> R1["COORDINATOR-VERIFY-BOUNDARY"]
  R1 --> R2["OPS-NO-INLINE-INTERPRETER"]
  R2 --> R3["COPILOT-FOLLOWUP-WAIT-TOOLS"]
  R3 --> R4["timeout-wrapped sanctioned tool"]
  R4 --> RD["OPERATOR-DECISION-RECORDER"]
  RD --> R5["SUBISSUE-NO-ADHOC-BYPASS"]
  R5 --> R6["COPILOT-FOLLOWUP-REPLY-RESOLVE-HELPER"]
  R6 --> R7["COPILOT-FOLLOWUP-REQUEST-HELPER-ONLY"]
  R7 --> R8["ADR-TRIPWIRE-STANDING-WAIVER"]
  R8 --> R9["WORKTREE-NO-STASH"]
  R9 --> R10["subagent raw external write"]
  R10 --> R11["STOP-HUMAN-MERGE-001"]
  R11 --> V{"gh pr create, ready or merge?"}
  V -- no --> OK(["null: allow"])
  V -- yes --> R12["OPS-DRAFT-FIRST-PR"]
  R12 --> R13["RAW-GH-PR-MERGE-BYPASS"]
  R13 --> R14["GATE-COMMENT-DRAFT-REQUIREMENTS"]
  R14 --> OK
  classDef inline stroke-dasharray: 5 5
  class X0,R0,RM,R4,R10,S0,S1,S2 inline
```

<a id="d116"></a>

### Sequence of a denied inline-interpreter call

Type: `sequenceDiagram`

Shows one denied Bash call end to end, from the agent's tool call to the deny reason it reads back. The command is a synthetic `node -e` one-liner in a managed checkout. The insight: the command never runs. The agent receives the rule ID and the sanctioned alternative (`--jq`, `--silent` or the editor tools) as the tool error, so it can retry correctly. Derived from `.claude/hooks/pre-tool-use-bash-gate.mjs`, `.claude/hooks/_hook-io.mjs`, `.claude/hooks/_hook-decisions.mjs`, `.claude/hooks/_bash-gate-decisions.mjs` and `commandContainsInlineInterpreter` in `.claude/hooks/_bash-command-classify.mjs`.

```mermaid
sequenceDiagram
  autonumber
  participant A as Agent
  participant CC as Claude Code
  participant H as bash-gate hook
  participant C as classifier
  participant G as git
  participant S as decideBashGate
  participant D as decideBashGateDeny
  A->>CC: Bash node -e "..."
  CC->>H: stdin JSON payload
  H->>G: rev-parse --show-toplevel
  G-->>H: repo root
  H->>H: .devloops exists, managed
  H->>H: segmentWriteKind null
  H->>S: facts with agentType and slugs
  S->>S: unresolve, judge, fixer checks pass
  S->>D: facts with role and readyGate
  D->>D: facts valid, unresolve, merge-pr and verify pass
  D->>C: commandContainsInlineInterpreter
  C-->>D: true
  D-->>S: ruleId OPS-NO-INLINE-INTERPRETER
  S-->>H: decision deny with reason
  H-->>CC: permissionDecision deny, exit 0
  CC-->>A: tool error with deny reason
  Note over A,CC: The command never executes
```

<a id="d117"></a>

### Raw body write token rule

Type: `flowchart`

Shows the decision inside `segmentWriteKind`, the whole-command rule behind the raw comment write guard (`OPERATOR-OWNED-LINE`) and the raw PR and issue body write guard (`ADR-TRIPWIRE-STANDING-WAIVER`). A comment clause wins over a body clause. An ANSI-C `$'...'` word in a comment-shaped command fails closed, because the decoded flag is not judged. It runs only in a managed checkout and denies for every actor, the operator and the main agent included. The command is normalized into one token set: quotes and backslashes are removed, substitutions and backticks are decoded, comma brace groups are expanded (at most 64 words), and `${VAR:-x}` defaults count as tokens. Tokens are lower-cased. The insight: the rule reads tokens in any segment and any order, so a wrapper such as `timeout` or `sudo` cannot hide the write. The accepted false positive is a command that holds these tokens as data, such as a title that says gh. A brace expansion over the cap, or nested shell strings past depth 3, fail closed. Derived from `segmentWriteKind` in `.claude/hooks/pre-tool-use-bash-gate.mjs`.

```mermaid
flowchart TD
  C["command in managed checkout"] --> N["normalize, decode, expand braces"]
  N --> CAP{"brace expansion over 64 words or nesting past depth 3?"}
  CAP -- yes --> D(["deny: ADR-TRIPWIRE-STANDING-WAIVER"])
  CAP -- no --> GH{"token gh, by basename?"}
  GH -- no --> A(["not a comment or body write"])
  GH -- yes --> CM{"comment, review or close/reopen write, or graphql comment mutation?"}
  CM -- yes --> DC(["deny: OPERATOR-OWNED-LINE"])
  CM -- no --> AN{"ANSI-C word in a comment-shaped command, not a body write?"}
  AN -- yes --> DC
  AN -- no --> PR{"pr and edit or create and a body flag?"}
  PR -- yes --> D
  PR -- no --> API{"api token?"}
  API -- no --> A
  API -- yes --> IN{"--input, or a field flag with body?"}
  IN -- yes --> D
  IN -- no --> GQ{"graphql with updatePullRequest, updateIssue or body?"}
  GQ -- yes --> D
  GQ -- no --> A
```

<a id="d118"></a>

### gh pr ready with a gate evidence probe

Type: `sequenceDiagram`

Shows the one Bash rule whose verdict depends on GitHub state. For `gh pr ready <n>`, the hook runs `scripts/loop/pre-pr-ready-gate.mjs` through the `.claude/bin/dev-loops-run` launcher. Only a clean draft\_gate verdict lets the call through. The insight: a launcher startup failure, or exit 3 (trust config refused), becomes `gateError`. That error is surfaced in the deny reason, so a missing toolchain cannot pass as "no evidence" and the call still fails closed. A raw `gh pr merge` is denied even when its evidence passes. Derived from `.claude/hooks/pre-tool-use-bash-gate.mjs`, `.claude/hooks/_bash-gate-decisions.mjs` and `.claude/bin/dev-loops-run`.

```mermaid
sequenceDiagram
  participant A as Agent
  participant H as bash-gate hook
  participant L as dev-loops-run
  participant P as pre-pr-ready-gate
  participant D as decider
  A->>H: gh pr ready 42
  H->>L: pre-pr-ready-gate --repo slug --pr 42
  L->>P: spawn in resolved toolchain
  alt clean draft_gate verdict
    P-->>H: exit 0
    H->>D: readyGate passed true
    D-->>H: null
    H-->>A: allow
  else no clean verdict
    P-->>H: nonzero exit, no startup error
    H->>D: readyGate passed false
    D-->>H: GATE-COMMENT-DRAFT-REQUIREMENTS
    H-->>A: deny, no clean draft_gate
  else startup failure or exit 3
    P-->>H: stderr diagnostic
    H->>D: readyGate error text
    D-->>H: deny with error
    H-->>A: deny, evidence check failed
  end
```

<a id="d119"></a>

### Write and Edit guard layers

Type: `flowchart`

Shows the five Write/Edit boundaries in `pre-tool-use-write-guard.mjs`, in run order. The first deny exits. The fixer and judge boundaries key on `agent_type`. The checkout guard catches a main-checkout edit while a worktree cycle is active. A call with no `file_path` is allowed after the role checks. The last two boundaries are opt-in through environment flags. They treat any path inside a working tree that `git check-ignore` does not ignore (and any `.git` path) as a repo mutation. The insight: `.claude/settings.json` sets only `DEVLOOPS_COORDINATOR_READONLY=1`. The main-agent read-only write boundary (`DEVLOOPS_MAIN_AGENT_READONLY=1`) therefore fails open in this repo unless the operator sets the flag. Derived from `.claude/hooks/pre-tool-use-write-guard.mjs`, `.claude/hooks/_hook-decisions.mjs`, `.claude/hooks/_fixer-grants.mjs` and `.claude/settings.json`.

```mermaid
flowchart TD
  S["Write or Edit file_path"] --> FX{"agent is fixer?"}
  FX -- yes --> FG{"outputRef, or path granted on branch?"}
  FG -- no --> D1(["deny: fixer mutation boundary"])
  FG -- yes --> NP
  FX -- no --> JD{"agent is judge?"}
  JD -- yes --> JG{"verdict file under tmp/gate-judge, no symlink?"}
  JG -- no --> D2(["deny: judge write boundary"])
  JG -- yes --> NP
  JD -- no --> NP{"file_path present?"}
  NP -- no --> OK
  NP -- yes --> WT{"cwd in linked worktree and target is a tracked main-checkout file?"}
  WT -- "yes, no DEVLOOPS_ALLOW_MAIN" --> D3(["deny: WORKTREE-WRONG-CHECKOUT-GUARD"])
  WT -- no --> MA{"MAIN_AGENT_READONLY=1 and non-ignored repo path?"}
  MA -- "yes, no run id, not dev-loop, not worker in linked worktree" --> D4(["deny: main-agent read-only"])
  MA -- no --> CO{"COORDINATOR_READONLY=1 and caller is a coordinator?"}
  CO -- yes --> D5(["deny: coordinator write boundary"])
  CO -- no --> OK(["allow"])
```

<a id="d120"></a>

### Agent dispatch guard

Type: `flowchart`

Shows how `decideAgentDispatch` checks an Agent or Task call by caller role, target role and prompt. The insight: the dev-loop coordinator cannot dispatch a gate `review` or `judge` unit directly. It must dispatch one `gate-coordinator`. The gate coordinator may dispatch only `review` and `judge`, and only with the emitted pointer prompt relayed byte for byte. The one exemption is a standalone `review` gate judge, whose ref resolves through the execution index. Derived from `.claude/hooks/pre-tool-use-agent-guard.mjs` and `decideAgentDispatch` in `.claude/hooks/_hook-decisions.mjs`.

```mermaid
flowchart TD
  IN["caller, target, prompt"] --> NS{"namespaced target that the launcher overrode?"}
  NS -- yes --> X1(["deny: AGENT_OVERRIDE_NAMESPACED_DISPATCH"])
  NS -- no --> DL{"caller dev-loop and target review or judge?"}
  DL -- "judge, not standalone review pointer" --> X2(["deny: GATE_COORDINATOR_REQUIRED"])
  DL -- "review with gate work-order token" --> X2
  DL -- otherwise --> GC{"caller is gate-coordinator?"}
  GC -- no --> OK(["allow"])
  GC -- yes --> CH{"target review or judge?"}
  CH -- no --> X3(["deny: GATE_COORDINATOR_DISPATCH_SCOPE"])
  CH -- yes --> PT{"prompt is the exact dispatch pointer?"}
  PT -- yes --> OK
  PT -- no --> X4(["deny: GATE_DISPATCH_NOT_VERBATIM"])
```

<a id="d121"></a>

### SubagentStop uncommitted-work guard

Type: `stateDiagram-v2`

Shows the outcomes of `decideSubagentStopGuard` when a subagent stops. The insight: only a subagent whose cwd is under a dev-loop worktree and whose `git status --porcelain` output is not empty is blocked. The block uses exit 2 and lists at most 50 dirty paths. Read-only roles (`judge`, `review`, `gate-coordinator`) get an advisory allow instead, because the dirty edit belongs to the orchestrator. A `git status` failure or timeout (5 s) allows the stop. Derived from `.claude/hooks/subagent-stop-uncommitted-guard.mjs` and `.claude/hooks/_hook-decisions.mjs`.

```mermaid
stateDiagram-v2
  [*] --> CheckCwd
  CheckCwd --> Allow: cwd not under worktree
  CheckCwd --> CheckAuth: under worktree
  CheckAuth --> Allow: COMMIT_AUTH_PENDING=1
  CheckAuth --> Porcelain: no pending auth
  Porcelain --> Allow: clean, or git failed
  Porcelain --> RoleCheck: dirty paths
  RoleCheck --> Advisory: read-only role
  RoleCheck --> Block: editing role
  Advisory --> [*]: exit 0, advisory on stderr
  Allow --> [*]: exit 0
  Block --> [*]: exit 2, LOCAL-COMMIT-BEFORE-EXIT
```

<a id="d122"></a>

### Pi tool\_call gate

Type: `flowchart`

Shows the Pi `tool_call` handler, which the extension also registers as a required child extension so foreground children load it. The role comes from the `<active_agent name="..."/>` tag in the system prompt. An ambiguous tag, a tag for an unknown dev-loops role, or an untagged native async child resolves to `""`, and `""` fails closed. The insight: Pi restricts Bash only for `judge` and `review`. It does not run the shared `decideBashGateDeny` set, so rules such as OPS-NO-INLINE-INTERPRETER have no Pi enforcement today. Running the shared set on Pi is spec-only. Derived from `extension/index.ts`, `extension/readonly-role-gate.ts` and `skills/docs/cross-harness-regression-contract.md`.

```mermaid
flowchart TD
  E["tool_call event"] --> SUB{"toolName subagent?"}
  SUB -- yes --> RN{"agent set rendered for Pi?"}
  RN -- no --> B0(["block: agent_set_not_rendered"])
  RN -- yes --> ROLE
  SUB -- no --> ROLE["resolvePiRole from active_agent tag"]
  ROLE --> M{"role null or tool not bash?"}
  M -- yes --> P(["pass"])
  M -- no --> R{"role judge, review or unresolved?"}
  R -- no --> P
  R -- yes --> PL{"exact pull-work-order line?"}
  PL -- yes --> P
  PL -- no --> JC{"judge and check-judge-decision line?"}
  JC -- yes --> P
  JC -- no --> RS{"review and shell-inert read or search?"}
  RS -- yes --> P
  RS -- no --> B1(["block: read-only role boundary"])
  SPEC["shared decideBashGateDeny on Pi"]:::spec -.-> ROLE
  classDef spec stroke-dasharray: 4 4
```

<a id="d123"></a>

### dev-loops-run launcher resolution

Type: `flowchart`

Shows how `.claude/bin/dev-loops-run` picks the toolchain root and rejects unsafe script paths. The launcher matters for permissions: `Bash(dev-loops-run:*)` is one of only 2 project allow rules (count from `jq '.permissions | map_values(length)' .claude/settings.json`). The bash gate denies a `timeout N` wrapper in front of it because the wrapper hides that head from the allow rule. The insight: a live source checkout always wins over the installed package, and an absolute path or `..` segment exits 2 before any spawn. Derived from `.claude/bin/dev-loops-run`, `.claude/settings.json` and `.claude/hooks/_bash-gate-decisions.mjs`.

```mermaid
flowchart TD
  A["dev-loops-run args"] --> RR{"--repo-root given?"}
  RR -- "yes, not a dir" --> E2(["exit 2"])
  RR -- "yes, dir" --> CWD["cwd = realpath of dir"]
  RR -- no --> CWD2["cwd = process cwd"]
  CWD --> SA
  CWD2 --> SA{"script argument given?"}
  SA -- no --> E2a(["exit 2: missing script"])
  SA -- yes --> W1{"checkout found walking up from cwd?"}
  W1 -- yes --> ROOT["root = source checkout"]
  W1 -- no --> W2{"checkout found from binary realpath?"}
  W2 -- yes --> ROOT
  W2 -- no --> W3{"plugin node_modules/dev-loops exists?"}
  W3 -- yes --> ROOT2["root = installed package"]
  W3 -- no --> E3(["exit 3: cannot resolve"])
  ROOT --> ESC{"absolute path, .. segment, or outside root?"}
  ROOT2 --> ESC
  ESC -- yes --> E2b(["exit 2: rejected path"])
  ESC -- no --> RUN(["spawn node script with cwd"])
```

<a id="d124"></a>

### Guard inventory by harness

Type: `mindmap`

Groups every guard named in this section by harness and hook event. The insight: Claude Code has eight hook entry points (six can deny or block; the two PostToolUse hooks never block), but Pi has one `tool_call` gate covering two roles plus the agent-set preflight. Cross-harness parity covers the judge and review restrictions, and stops there. Derived from `.claude/settings.json`, `.claude/hooks/*.mjs`, `extension/index.ts` and `extension/readonly-role-gate.ts`.

```mermaid
mindmap
  root((guards))
    Claude Code
      PreToolUse Bash, file, search and mcp tools
        approval record path guard
      PreToolUse AskUserQuestion
        pre-filled answers guard
      PreToolUse Bash
        shared deny set
        judge command boundary
        fixer pull-line boundary
        comment-write token rule
        body-write token rule
      PreToolUse Write or Edit
        fixer grant
        judge verdict paths
        wrong-checkout guard
        main-agent read-only
        coordinator write boundary
      PreToolUse Agent or Task
        gate-coordinator dispatch
      PostToolUse AskUserQuestion
        merge approval record
      PostToolUse Bash
        main checkout ff-only
      SubagentStop
        uncommitted-work block
    Pi
      tool_call
        judge and review bash
        agent set rendered
      shared deny set spec-only
```

<a id="d125"></a>

### Vendored decider modules

Type: `classDiagram`

Shows how the hook bundle is built. The pure deciders are written in `packages/core` and copied into `.claude/hooks` by `scripts/claude/generate-claude-assets.mjs`, which only rewrites the relative import paths, because the hook bundle cannot import the core package. The insight: the Claude seam keeps only the judge and fixer role checks. Everything harness-neutral lives in `bash-gate-decisions.mjs`, where a second adapter can call it. Derived from the GENERATED headers of `.claude/hooks/_hook-decisions.mjs` and `.claude/hooks/_bash-gate-decisions.mjs`, and from `docs/decisions/0245-one-shared-bash-gate-deny-decision.md`.

```mermaid
classDiagram
  class BashGateDecisions["loop/bash-gate-decisions.mjs"] {
    +BASH_GATE_RULES
    +decideBashGateDeny(facts)
    +decideUnresolveOwnerDeny()
    +isCoordinatorRole(role)
    +normalizeAgentType(t)
  }
  class HookDecisions["claude/hook-decisions.mjs"] {
    +decideBashGate()
    +decideWriteGuard()
    +decideCoordinatorWriteGuard()
    +decideFixerWriteGuard()
    +decideJudgeWriteGuard()
    +decideWorktreeCheckoutGuard()
    +decideSubagentStopGuard()
    +decideAgentDispatch()
  }
  class Classify["_bash-command-classify.mjs"] {
    +tokenizeShellCommand()
    +commandContainsInlineInterpreter()
    +commandContainsRawPrBodyEdit()
  }
  class HookIO["_hook-io.mjs"] {
    +readHookInput()
    +emitDeny(reason)
    +emitAllow()
  }
  class BashGateHook["pre-tool-use-bash-gate.mjs"]
  class PiGate["extension/readonly-role-gate.ts"] {
    +resolvePiRole()
    +decidePiToolCall()
  }
  HookDecisions ..> BashGateDecisions : delegates
  BashGateDecisions ..> Classify : predicates
  BashGateHook ..> HookDecisions : decides
  BashGateHook ..> HookIO : emits
  PiGate ..> BashGateDecisions : spec-only
```

<a id="d126"></a>

### Hook module sizes

Type: `xychart-beta`

Shows the line count of each file in `.claude/hooks`, from `wc -l .claude/hooks/*.mjs` (6303 lines in total). The insight: the shell classifier is the largest file at 2013 lines. Hook policy is mostly shell parsing (tokenizing, heredocs, substitutions, brace expansion). The eight entry scripts are thin by comparison. Derived from `.claude/hooks/*.mjs`.

```mermaid
xychart-beta
  title "Lines per hook file (wc -l)"
  x-axis ["answers-guard", "agent-guard", "hook-io", "round-retire", "post-ask", "approval-guard", "wo-digest", "stop-guard", "post-merge", "fixer-grants", "write-guard", "main-ff", "bash-gate", "ask-approval", "worktree", "run-context", "gate-decide", "hook-decide", "classify"]
  y-axis "lines" 0 --> 2100
  bar [23, 25, 38, 41, 41, 70, 77, 93, 152, 238, 254, 284, 324, 337, 358, 578, 640, 717, 2013]
```

<a id="d127"></a>

### Deny sites by decision source

Type: `pie`

Shows where deny decisions are produced, counted per rule (a rule such as GATE-COMMENT-DRAFT-REQUIREMENTS has several return sites). There are 13 registered Bash rules (`BASH_GATE_RULES`) and 5 `ruleId: null` Bash denies (`grep -cE '^ +ruleId: null,$' .claude/hooks/_bash-gate-decisions.mjs`). `grep -c 'decision: "deny"' .claude/hooks/_hook-decisions.mjs` reports 13 deny returns in the Claude seam deciders. Two of them only relay a shared-set deny (the unresolve relay and the `decideBashGateDeny` wrapper in `decideBashGate`), so the seam owns 11: judge Bash, fixer pull, main-agent write, coordinator write, judge write, worktree checkout, fixer write and four dispatch denies. The SubagentStop `block` and the two ask-approval guard denies are not counted. The insight: the Bash gate owns the largest share of the policy, and most of it is shared and harness-neutral. Derived from `.claude/hooks/_bash-gate-decisions.mjs` and `.claude/hooks/_hook-decisions.mjs`.

```mermaid
pie showData
  title Deny rules by source
  "Registered Bash rules" : 13
  "Inline Bash denies" : 5
  "Claude seam-owned denies" : 11
```

<a id="d128"></a>

### When each guard entry script landed

Type: `timeline`

Shows the date each guard entry file was first added at its current path, from `git log --diff-filter=A --format=%ad --date=short -- <file>`. With `--follow`, the first three files trace back one day earlier, to 2026-06-23, under an earlier path. The insight: the Bash and write gates arrived together, and role-specific guards followed. The shared deny module was split out of the Claude seam in early November, and the three ask-approval hooks landed last. Derived from git history of `.claude/hooks/*.mjs` and `extension/readonly-role-gate.ts`.

```mermaid
timeline
  title Guard entry files first added
  2026-06-24 : bash gate : write guard : post-merge hook
  2026-08-11 : subagent stop guard
  2026-09-28 : fixer grants
  2026-09-29 : agent dispatch guard
  2026-09-30 : Pi read-only role gate
  2026-11-03 : shared bash-gate deny module
  2026-11-22 : approval record guard : ask answers guard : ask approval hook
```

