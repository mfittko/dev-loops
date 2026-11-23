---
title: Security and trust boundaries
status: snapshot
snapshot_date: 2026-11-19
---
<a id="12-security-trust"></a>

## Security and trust boundaries

dev-loops runs agents that execute commands on the operator's machine, and those agents read text from public GitHub surfaces. The code draws three boundaries around that risk. The first is comment trust: one predicate in `packages/core/src/github/comment-trust.mjs` decides at ingestion whether comment text may reach an agent, and the `.devloops` `trust` block extends it only from the default branch (ADR 0238, 0273, 0290). The second is the write side: agents and the operator share one GitHub credential, so a registry of operator-owned lines makes every sanctioned comment writer refuse the lines that only a human may post. The third is secret scanning: a secretlint adapter warns at pre-commit and blocks fail-closed at merge. Claude Code PreToolUse hooks add a fourth, harness-level layer that bounds what each agent role may run, write or dispatch.

<a id="d157"></a>

### Trust boundaries from GitHub text to agent action

Type: `flowchart`

The diagram shows where untrusted text enters, where it is filtered, and which guards stand between an agent and a durable write. Insight: trust is decided once at ingestion, and the write-side guards hold independently of it, because a reader cannot tell an agent line from an operator line. Derived from `packages/core/src/github/comment-trust.mjs`, `packages/core/src/github/review-threads.mjs`, `scripts/github/_comment-trust-config.mjs`, `packages/core/src/github/comment-id-guard.mjs`, `packages/core/src/security/secret-scan.mjs`, `scripts/github/merge-pr.mjs` and `.claude/hooks/hooks.json`.

```mermaid
flowchart LR
  subgraph PUB["Untrusted zone: public GitHub"]
    TH["Review threads"]
    RV["Review bodies"]
    IC["PR and issue comments"]
    PRH["PR head .devloops"]
  end
  subgraph CFG["Default-branch config"]
    DB["origin/default .devloops trust"]
  end
  subgraph ING["Ingestion boundary"]
    LOAD["loadCommentTrustConfig"]
    PRED{"isTrustedCommentAuthor"}
    DROP["Text dropped, logins kept"]
    NOTE["Untrusted skip note"]
  end
  subgraph AG["Agent zone"]
    WO["Work order: text is data"]
    FX["Fixer, gate, judge"]
  end
  subgraph WR["Write boundary"]
    HOOK["Claude PreToolUse hooks"]
    GUARD["guardCommentBodyNoIssuePrIds"]
    SCAN["secret_scan precondition"]
    MERGE["merge-pr"]
  end
  PRH -. "never read" .-> LOAD
  DB --> LOAD --> PRED
  TH --> PRED
  RV --> PRED
  IC --> PRED
  PRED -- trusted --> WO --> FX
  PRED -- untrusted --> DROP --> NOTE
  FX --> HOOK
  FX --> GUARD
  FX --> SCAN --> MERGE
```

<a id="d158"></a>

### Comment author trust predicate

Type: `flowchart`

The diagram traces `isTrustedCommentAuthor` branch by branch in source order. Insight: an exact sanctioned login wins only with a Bot type, every other Bot is untrusted unless configured, and a human is trusted only by the `OWNER`, `MEMBER` or `COLLABORATOR` association. A GraphQL comment the reading identity authored (`viewerDidAuthor`) is trusted before this predicate runs. "Bot" means a Bot type or a `[bot]` login suffix; a `trust.reviewers` entry with a `[bot]` suffix also requires the Bot type. Derived from `packages/core/src/github/comment-trust.mjs` and `docs/decisions/0238-comment-text-from-non-maintainers-never-reaches-an-agent.md`.

```mermaid
flowchart TD
  A["Comment author"] --> V{"viewerDidAuthor?"}
  V -- yes --> T["Trusted"]
  V -- no --> L{"Login empty?"}
  L -- yes --> U["Untrusted"]
  L -- no --> C{"allowCopilot and exact Copilot login and Bot?"}
  C -- yes --> T
  C -- no --> G{"githubActionsBot on and exact github-actions and Bot?"}
  G -- yes --> T
  G -- no --> R{"Login in trust.reviewers?"}
  R -- yes --> T
  R -- no --> S{"Exact sanctioned login or any Bot?"}
  S -- yes --> U
  S -- no --> AS{"Association OWNER, MEMBER or COLLABORATOR?"}
  AS -- yes --> T
  AS -- no --> U
```

<a id="d159"></a>

### Trust config load from the default branch

Type: `sequenceDiagram`

The diagram shows one entry script loading the `trust` block before its first trust read. Insight: the load never fetches and never reads the worktree or PR head, so a PR cannot grant itself trust, and every failure except "no file or no key" refuses with exit 3 instead of falling back to defaults that would undo a `githubActionsBot: false` opt-out. The count of 36 loading entry scripts comes from `grep -rl "loadCommentTrustConfigOrExit" scripts --include='*.mjs' | grep -v test | wc -l` (37 files, minus the loader itself). Derived from `scripts/github/_comment-trust-config.mjs`, `scripts/loop/standing-authorization.mjs`, `packages/core/src/config/config.mjs` and `docs/decisions/0290-comment-trust-config-in-devloops.md`.

```mermaid
sequenceDiagram
  participant E as Entry script
  participant L as _comment-trust-config
  participant G as git local refs
  participant Z as TrustConfig schema
  participant P as comment-trust module
  E->>L: loadCommentTrustConfigOrExit
  alt help run
    L-->>E: skip load
  else normal run
    L->>G: readDefaultBranchConfig (no fetch)
    alt origin/HEAD unset
      G-->>L: default_branch_unresolved
      L-->>E: stderr JSON, exit 3
    else local ref absent
      G-->>L: missing
      L-->>E: stderr JSON, exit 3
    else file unreadable
      G-->>L: malformed
      L-->>E: stderr JSON, exit 3
    else no .devloops or no trust key
      L->>P: setCommentTrustConfig defaults
    else trust block present
      L->>Z: safeParse strict object
      alt invalid
        Z-->>L: issues
        L-->>E: stderr JSON state invalid, exit 3
      else valid
        L->>P: setCommentTrustConfig
      end
    end
  end
```

<a id="d160"></a>

### Review thread trust lifecycle

Type: `stateDiagram-v2`

The diagram shows the states a review thread takes after `parseReviewThreads` classifies it. Insight: an all-untrusted thread is neither an act item nor a merge blocker, but a truncated thread stays a blocker with no text, and a maintainer resolve clears a skip, so there is no lockout. Derived from `packages/core/src/github/review-threads.mjs`, `scripts/github/_untrusted-skip-note.mjs` and `docs/decisions/0238-comment-text-from-non-maintainers-never-reaches-an-agent.md`.

```mermaid
stateDiagram-v2
  [*] --> Fetched
  Fetched --> Listed: any trusted comment
  Fetched --> Incomplete: first page untrusted, next page exists
  Fetched --> Skipped: all comments untrusted
  Listed --> Blocking: unresolved
  Incomplete --> Blocking: counted, no text
  Skipped --> Noted: skip note once per head
  Noted --> Listed: maintainer reply in first 100
  Noted --> Resolved: maintainer resolves
  Blocking --> Resolved: fixed and resolved
  Incomplete --> Resolved: maintainer resolves
  Resolved --> [*]
```

<a id="d161"></a>

### Security rules as requirements

Type: `requirementDiagram`

The diagram lists the rules the code enforces and the module that satisfies or verifies each one. Insight: every rule fails closed, and the merge gate is the single hard stop for secrets while pre-commit only warns. The approval rule binds escalated merges; a drain merge also accepts a recorded standing authorization. The repository-permission check (write, maintain or admin) that ADR 0238 defers is spec-only and is not shown as satisfied. Derived from `packages/core/src/github/comment-trust.mjs`, `scripts/github/_comment-trust-config.mjs`, `packages/core/src/github/operator-owned-lines.mjs`, `packages/core/src/security/secret-scan.mjs`, `packages/core/src/loop/merge-approval.mjs` and `scripts/github/merge-pr.mjs`.

```mermaid
requirementDiagram
  requirement comment_trust {
    id: GATE_REVIEW_COMMENT_TRUST
    text: "Untrusted comment text never reaches an agent"
    risk: high
    verifymethod: test
  }
  requirement default_branch_trust {
    id: ADR_0290
    text: "Trust config read only from origin default branch"
    risk: high
    verifymethod: test
  }
  requirement operator_line {
    id: OPERATOR_OWNED_LINE
    text: "No agent writes an operator-owned line"
    risk: high
    verifymethod: test
  }
  requirement human_merge {
    id: FRESH_HUMAN_APPROVAL
    text: "Escalated merge needs a head- or patch-id-pinned human approval"
    risk: high
    verifymethod: test
  }
  requirement secret_scan {
    id: SECRET_SCAN
    text: "Added lines carry no credential at merge"
    risk: high
    verifymethod: test
  }
  requirement repo_permission {
    id: SPEC_ONLY_PERMISSION
    text: "spec-only: repo permission check deferred"
    risk: medium
    verifymethod: inspection
  }
  element comment_trust_mjs {
    type: module
  }
  element trust_config_loader {
    type: module
  }
  element operator_owned_lines_mjs {
    type: module
  }
  element merge_approval_mjs {
    type: module
  }
  element secret_scan_mjs {
    type: module
  }
  element merge_pr_mjs {
    type: script
  }
  comment_trust_mjs - satisfies -> comment_trust
  trust_config_loader - satisfies -> default_branch_trust
  operator_owned_lines_mjs - satisfies -> operator_line
  merge_approval_mjs - satisfies -> human_merge
  secret_scan_mjs - satisfies -> secret_scan
  merge_pr_mjs - verifies -> secret_scan
  merge_pr_mjs - verifies -> human_merge
  comment_trust - refines -> repo_permission
```

<a id="d162"></a>

### Trust data model

Type: `erDiagram`

The diagram shows the entities the predicate reads and the config that extends it. Insight: trust attaches to each comment, a thread is skipped as untrusted only when its fetched comments hold no trusted one and no further page exists (otherwise it is `trustIncomplete`), and `trust.reviewers` only adds trust on comment surfaces while merge approval still excludes every Bot and counts only maintainer associations. Derived from `packages/core/src/config/config.mjs` (`TrustConfig`), `packages/core/src/github/review-threads.mjs`, `packages/core/src/loop/merge-approval.mjs` and `scripts/github/detect-checkpoint-evidence.mjs` (association-only approval facts).

```mermaid
erDiagram
  DEVLOOPS_FILE ||--o| TRUST_BLOCK : "has optional"
  TRUST_BLOCK ||--o{ REVIEWER_ENTRY : lists
  REVIEW_THREAD ||--|{ COMMENT : contains
  COMMENT }o--|| AUTHOR : "written by"
  REVIEWER_ENTRY }o--o| AUTHOR : "matches login"
  TRUST_BLOCK {
    boolean githubActionsBot "default true"
  }
  REVIEWER_ENTRY {
    string login "optional bot suffix"
  }
  AUTHOR {
    string login
    string type "User or Bot"
    string association "OWNER MEMBER ..."
  }
  COMMENT {
    boolean trusted "decided at ingestion"
    string body "empty when untrusted"
    boolean viewerDidAuthor
  }
  REVIEW_THREAD {
    boolean untrusted
    boolean trustIncomplete
    boolean isResolved
  }
```

<a id="d163"></a>

### Security modules and their exports

Type: `classDiagram`

The diagram shows the security modules as classes with their public functions and the call edges between them. Insight: the comment writers reach the operator-owned registry only through `guardCommentBodyNoIssuePrIds`, and the secret scanner is a thin adapter with no detector of its own. The count of 4 registry entries comes from `grep -c 'id: "' packages/core/src/github/operator-owned-lines.mjs`. Derived from `packages/core/src/github/comment-trust.mjs`, `packages/core/src/github/operator-owned-lines.mjs`, `packages/core/src/github/comment-id-guard.mjs`, `packages/core/src/security/secret-scan.mjs` and `scripts/security/scan-staged-diff.mjs`.

```mermaid
classDiagram
  class CommentTrust {
    +setCommentTrustConfig(config)
    +isTrustedCommentAuthor(author, options)
    +isTrustedGraphqlComment(comment)
    +isTrustedRestComment(comment)
    +isTrustedAssociation(association)
    +isSanctionedCopilotReviewerLogin(login)
  }
  class TrustConfigLoader {
    +loadCommentTrustConfig()
    +loadCommentTrustConfigOrExit()
    TRUST_CONFIG_REFUSED_EXIT = 3
  }
  class OperatorOwnedLines {
    +OPERATOR_OWNED_LINES 4 entries
    +findOperatorOwnedLineRefusal(body)
    +wrapOperatorOwnedPhrases(text)
  }
  class CommentIdGuard {
    +guardCommentBodyNoIssuePrIds(body)
  }
  class SecretScan {
    +scanDiffText(diff)
    +parseDiffLines(diff)
    +allowlistReason(text)
  }
  class ScanStagedDiff {
    +runCli()
  }
  class MergePr {
    resolveSecretScanRefusal()
  }
  TrustConfigLoader --> CommentTrust : sets config
  CommentIdGuard --> OperatorOwnedLines : refuses
  ScanStagedDiff --> SecretScan
  MergePr --> SecretScan
```

<a id="d164"></a>

### Operator-owned line write guard

Type: `flowchart`

The diagram shows how a sanctioned comment writer handles each of the 4 registry entries. Insight: non-gate writers refuse, gate writers wrap the phrase in a code span so it asserts nothing, and only the Copilot body-disposition `operator` marker is cleared by `--standing-authorization`; `approve merge` and `approve release` have no override. Derived from `packages/core/src/github/operator-owned-lines.mjs`, `packages/core/src/github/comment-id-guard.mjs` and `docs/decisions/0258-operator-owned-line-registry.md`.

```mermaid
flowchart TD
  B["Comment body from agent"] --> K{"Gate surface writer?"}
  K -- yes --> W["wrapOperatorOwnedPhrases"]
  W --> GD
  K -- no --> GD["guardCommentBodyNoIssuePrIds"]
  GD --> F{"findOperatorOwnedLineRefusal"}
  F -- "approve merge line" --> X["Refuse, no override"]
  F -- "approve release vN" --> X
  F -- "adr-tripwire:allow line" --> X2["Refuse, only waive-adr-tripwire writes it"]
  F -- "operator disposition marker" --> SA{"--standing-authorization?"}
  SA -- yes --> ID
  SA -- no --> X
  F -- none --> ID{"Bare #id not in allowedRefs?"}
  ID -- yes --> X3["Refuse: no ids in comments"]
  ID -- no --> P["Post comment"]
```

<a id="d165"></a>

### Secret scan enforcement split

Type: `flowchart`

The diagram shows the two call sites of `scanDiffText` and how each treats a hit or a scanner error. Insight: warn locally, block at merge; a blocking false positive costs an agent loop a stopped pass, so the only blocking path uses the maintained secretlint preset, and a finding never carries the matched value. Derived from `packages/core/src/security/secret-scan.mjs`, `scripts/security/scan-staged-diff.mjs`, `packages/core/src/loop/default-branch-guard.mjs` and `scripts/github/merge-pr.mjs`.

```mermaid
flowchart LR
  subgraph LOCAL["Local: warn only"]
    PC["pre-commit hook"] --> SSD["scan-staged-diff.mjs"]
    SSD --> D1["git diff --cached"]
  end
  subgraph GATE["Merge gate: fail closed"]
    MP["merge-pr.mjs"] --> D2["git diff base...head"]
  end
  D1 --> CORE["scanDiffText"]
  D2 --> CORE
  CORE --> SL["secretlint recommend preset"]
  SL --> AL{"Added line has allow marker with reason?"}
  AL -- yes --> OK["Line exempt"]
  AL -- no --> HIT["Finding: file, line, rule id"]
  HIT --> WARN["stderr warning, commit proceeds"]
  HIT --> BLOCK["secret_scan refusal"]
  CORE -. "throws" .-> BLOCK
```

<a id="d166"></a>

### Untrusted input surfaces and mitigations

Type: `mindmap`

The mindmap groups the surfaces that can carry attacker-controlled text toward an agent and the mitigation the code applies to each. Insight: the residual risk is the trust ceiling, because a workflow that echoes fork input under the GitHub Actions identity, or a configured `trust.reviewers` login, is trusted on every gate-evidence surface. Derived from `scripts/github/write-gate-context.mjs`, `scripts/loop/emit-fixer-work-order.mjs`, `scripts/loop/emit-judge-work-order.mjs`, `scripts/github/_untrusted-skip-note.mjs`, `docs/decisions/0273-github-actions-bot-is-a-trusted-comment-author.md` and `docs/decisions/0290-comment-trust-config-in-devloops.md`.

```mermaid
mindmap
  root((Untrusted input))
    Review threads
      Dropped at ingestion
      Skip note with logins only
    Review bodies
      Copilot or maintainer only as fixer source
    Issue and PR comments
      Same predicate via REST adapter
    Linked issue body
      Fenced as inert text in gate context
    Work orders
      Text is data never instructions
    Gate evidence
      Round inputs filtered
      Deferral markers filtered
    Trust ceiling
      Actions bot echo of fork input
      trust.reviewers logins
    Config
      Default branch only
      Stale local ref until fetch
```

<a id="d167"></a>

### Comment trust decision history

Type: `timeline`

The timeline orders the accepted decision records that shaped comment trust and the write-side registry. Insight: the trusted set started closed with no configuration surface, gained exact-login bots one at a time, and became configurable only after the default-branch read made self-granted trust impossible. Derived from the Status lines of `docs/decisions/0233-fixer-work-order-from-review-body.md`, `docs/decisions/0238-comment-text-from-non-maintainers-never-reaches-an-agent.md`, `docs/decisions/0240-copilot-reviewer-matched-by-exact-login.md`, `docs/decisions/0247-untrusted-comment-skip-note-and-issue-comment-readers.md`, `docs/decisions/0248-detector-evidence-trust-filter.md`, `docs/decisions/0258-operator-owned-line-registry.md`, `docs/decisions/0273-github-actions-bot-is-a-trusted-comment-author.md` and `docs/decisions/0290-comment-trust-config-in-devloops.md`.

```mermaid
timeline
  title Comment trust ADRs
  2026-11-02 : ADR 0233 review-body fixer source filtered
             : ADR 0238 one trust predicate at ingestion
  2026-11-03 : ADR 0240 Copilot matched by exact login
             : ADR 0247 skip note and issue comment readers
             : ADR 0248 detector evidence trust filter
  2026-11-08 : ADR 0258 operator-owned line registry
  2026-11-12 : ADR 0273 GitHub Actions bot trusted
  2026-11-17 : ADR 0290 trust block in .devloops
```

<a id="d168"></a>

### Claude Code PreToolUse guard layer

Type: `flowchart`

The diagram shows which hook runs for which Claude Code tool event. The main-agent and coordinator write boundaries run only when `DEVLOOPS_MAIN_AGENT_READONLY=1` or `DEVLOOPS_COORDINATOR_READONLY=1` is set. Insight: these hooks bound agent roles independently of comment trust, so a fixer that was steered anyway still cannot write outside its pulled work order's mutation authority, and a coordinator cannot dispatch arbitrary agents. The approval record guard and the ask answers guard keep an agent from forging the merge approval answer (`MERGE-ASK-APPROVAL`, ADR 0315). Derived from `.claude/hooks/hooks.json`, `.claude/hooks/pre-tool-use-approval-guard.mjs`, `.claude/hooks/pre-tool-use-ask-answers-guard.mjs`, `.claude/hooks/pre-tool-use-bash-gate.mjs`, `.claude/hooks/pre-tool-use-write-guard.mjs`, `.claude/hooks/pre-tool-use-agent-guard.mjs` and `.claude/hooks/_bash-gate-decisions.mjs`.

```mermaid
flowchart LR
  AG["Agent tool call"] --> EV{"Tool"}
  EV -- Bash --> BG["Bash gate: registered deny rules"]
  EV -- "Edit or Write" --> WG["Write guard"]
  EV -- "Agent or Task" --> DG["Dispatch guard"]
  EV -- "Bash, file, search or MCP" --> AR["Approval record guard"]
  EV -- AskUserQuestion --> AQ["Ask answers guard: no pre-filled answers"]
  AR --> DEC
  AQ --> DEC
  WG --> W0["Fixer: work-order mutation authority"]
  WG --> W1["Judge: verdict files only"]
  WG --> W2["Wrong-checkout deny"]
  WG --> W3["Main-agent read-only, opt-in"]
  WG --> W4["Coordinator read-only, opt-in"]
  DG --> D0["decideAgentDispatch for dev-loop and gate-coordinator"]
  BG --> DEC{"Deny?"}
  W0 --> DEC
  W1 --> DEC
  W2 --> DEC
  W3 --> DEC
  W4 --> DEC
  D0 --> DEC
  DEC -- yes --> DENY["emitDeny with reason"]
  DEC -- no --> ALLOW["emitAllow"]
  AG -. "after Bash" .-> POST["PostToolUse merge hook"]
  AG -. "after AskUserQuestion" .-> POSTA["PostToolUse approval-answer hook"]
  AG -. "subagent stop" .-> STOP["Uncommitted-work guard"]
```

<a id="d169"></a>

### Merge approval path

Type: `flowchart`

The diagram shows how the merge gate decides whether a merge is authorized. Insight: the `approve merge` operator line is the only comment that can authorize an escalated merge; it must open its line, come from the named human login and match the current head, or carry a `patch-id` that matches the current diff so a base-only head change keeps the approval (ADR 0279), and the operator-owned registry refuses it on every agent write path. Derived from `packages/core/src/loop/merge-approval.mjs` (`resolveMergeClass`, `verifyFreshHumanApproval`, `resolveMergeApprovalDecision`), `scripts/github/merge-pr.mjs` and `packages/core/src/github/operator-owned-lines.mjs`.

```mermaid
flowchart TD
  IN["merge-pr: merge_approval"] --> CL{"Stable release, size escalate or block, or T1 touched?"}
  CL -- yes --> ESC["Class: escalated"]
  CL -- no --> DRN["Class: drain"]
  DRN --> SA{"Standing authorization?"}
  SA -- yes --> OK["Authorized"]
  SA -- no --> RV
  ESC --> RV{"Latest review by named login is APPROVED at head and not Bot?"}
  RV -- yes --> OK
  RV -- no --> CM{"Named login comment opens a line with approve merge headSha?"}
  CM -- yes --> OK
  CM -- no --> PM{"Named login comment opens a line with approve merge sha patch-id matching the current patch-id?"}
  PM -- yes --> OK
  PM -- no --> NO["Refuse"]
```

