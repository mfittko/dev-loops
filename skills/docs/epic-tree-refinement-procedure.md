# Epic tree refinement procedure

Canonical owner for depth-first, top-down-then-bottom-up refinement of an existing GitHub
sub-issue tree (parent → children → grandchildren).

Use it to align AC, DoD, scope boundaries, and delegation contracts across all levels of an
existing tree. [Issue Intake Procedure](./issue-intake-procedure.md) Phase 3b creates a new tree
and calls this procedure. [Sub-Issue Tree Contract](./sub-issue-tree-contract.md) owns the
sub-issue tooling.

---

## Definitions

| Term | Meaning |
|---|---|
| **Root** | The umbrella/epic issue at the top of the tree |
| **Parent** | Any issue that has at least one sub-issue child |
| **Child** | A direct sub-issue of a parent |
| **Leaf** | An issue with no sub-issue children |
| **Phase table** | A section of the root/parent body that names each child and what it owns vs excludes |
| **Scope boundary** | Explicit text in an issue body: `"This issue owns X. It does NOT own Y (#NNN)."` |
| **AC/DoD matrix** | A two-column table mapping each acceptance-criterion outcome to its required completion evidence — the authoritative AC→DoD artifact (#1951). Do NOT author separate interactive issue-side AC / DoD checklists; the PR carries the derived list-form checklists |

---

## Prerequisites

Before starting, verify:

1. The root issue and all intended children/grandchildren exist as GitHub issues in the repo.
2. The sub-issue tree is attached (run `node <resolved-skill-scripts>/github/manage-sub-issues.mjs list --repo <repo> --issue <root>` to inspect it).
3. You have the resolved repo slug (`owner/name`).

Optional but recommended before and after edits:

```sh
dev-loops refine verify --issue <root> --repo <repo>
```

This verification command checks linkage policy, sibling scope boundaries, refinement completeness,
and tree integrity in one deterministic pass.

If the sub-issue tree does not yet exist, use [Issue Intake Procedure](./issue-intake-procedure.md) Phase 3b to decompose and attach it first.

---

## Phases

### Phase A — Root refinement (serial)

Refine the root issue **first** before touching any child.

For the root issue:
1. Read the current body: `node scripts/github/view-issue.mjs --repo <repo> --issue <root> --json number,title,body`
2. Confirm the problem statement is clear and scoped
3. Confirm a **phase scope table** exists — one row per immediate child naming what each child
   owns and what it excludes; add or update this table if missing
4. Confirm the **AC/DoD matrix** (see Definitions). For the root, each criterion outcome is the end-to-end goal, not the implementation details owned by children, and its completion evidence is the merge-ready condition for the root issue as a whole
5. Confirm **non-goals** section
6. Write the updated body to a tmp file: `tmp/issues/<root>/refinement/root-body.md`
7. Show the diff and obtain confirmation before mutating GitHub
8. Apply: `dev-loops issue edit --repo <repo> --issue <root> --body-file tmp/issues/<root>/refinement/root-body.md`

<!-- rule: EPIC-REFINEMENT-SERIAL-PHASE-GATE -->
**Gate:** Phase B MUST NOT start until Phase A is complete and the root body is updated on GitHub. The same serial-gate discipline applies at every phase boundary below: a level/phase MUST fully complete (siblings may run in parallel within it) before the next one starts.

---

### Phase B — Descend: refine children against parent (parallel fan-out per level)

For **each level** of the tree (breadth-first traversal of levels, depth-first traversal within
a single branch), refine all siblings in parallel — siblings are independent and only need the
parent's updated body, not each other's output.

**For each issue at this level:**

1. Read the parent's updated body: `node scripts/github/view-issue.mjs --repo <repo> --issue <parent> --json number,title,body`
2. Read the current child body: `node scripts/github/view-issue.mjs --repo <repo> --issue <child> --json number,title,body`
3. Verify the child's scope matches what the parent's phase table delegates to it
4. Identify any overlap with sibling issues (read sibling titles/bodies if needed)
5. Refine the child body with:
   - **Scope boundary** (explicit): `"This issue owns X. It does NOT own Y (#NNN) or Z (#MMM)."`
   - **AC/DoD matrix** specific to this child's bounded scope — each criterion outcome (when is this child independently closable?) mapped to its required completion evidence
   - **Non-goals** — what this child intentionally excludes
6. Write refined body to `tmp/issues/<child>/refinement/child-body.md`
7. Show the diff and obtain confirmation before mutating (unless running unattended with explicit authorization)
8. Apply: `dev-loops issue edit --repo <repo> --issue <child> --body-file tmp/issues/<child>/refinement/child-body.md`

**Serial gate between levels** ([EPIC-REFINEMENT-SERIAL-PHASE-GATE](#phase-a--root-refinement-serial)): all children at level N must complete before descending to level N+1.

Repeat Phase B until all leaves are refined.

---

### Phase C — Ascend: reconcile parents with children (parallel fan-out per level)

After all children under a given parent are refined, reconcile that parent. Work bottom-up.

All parents at the same depth can be reconciled in parallel (they only need their own children's
updated bodies, not sibling parents).

**For each parent (bottom-up):**

1. Re-read the parent body: `node scripts/github/view-issue.mjs --repo <repo> --issue <parent> --json number,title,body`
2. Re-read all direct children bodies
3. Verify:
   - The parent's phase scope table still matches what the children now claim to own
   - No orphaned responsibilities (parent promised something no child owns)
   - No duplicate ownership (two children claiming the same thing)
4. Update the parent's phase scope table and AC/DoD as needed to reflect what children now explicitly own
5. Write refined body to `tmp/issues/<parent>/refinement/parent-reconciled-body.md`
6. Show the diff and obtain confirmation before mutating
7. Apply: `dev-loops issue edit --repo <repo> --issue <parent> --body-file tmp/issues/<parent>/refinement/parent-reconciled-body.md`

**Serial gate between levels** ([EPIC-REFINEMENT-SERIAL-PHASE-GATE](#phase-a--root-refinement-serial)): all parents at depth N must complete reconciliation before ascending to depth N-1.

---

### Phase D — Root final reconcile (serial)

After all immediate children of the root have been reconciled:

1. Re-read the root body: `node scripts/github/view-issue.mjs --repo <repo> --issue <root> --json number,title,body`
2. Re-read all immediate children bodies
3. Verify:
   - Phase scope table matches actual child scope
   - Dependency chain is correct (does execution order in the sub-issue tree match dependencies?)
   - No orphaned responsibilities; no duplicate ownership
4. Update the root body with the final reconciled phase scope table and AC/DoD
5. Write to `tmp/issues/<root>/refinement/root-final-body.md`
6. Show the diff and obtain confirmation before mutating
7. Apply: `dev-loops issue edit --repo <repo> --issue <root> --body-file tmp/issues/<root>/refinement/root-final-body.md`
8. Verify the sub-issue tree still reflects the correct execution order:
   ```sh
   node <resolved-skill-scripts>/github/manage-sub-issues.mjs verify \
     --repo <repo> --issue <root> --expected <n1,n2,...> --ordered
   ```

**Gate:** Root final reconcile completes the procedure. Every issue in the tree must now satisfy
[EPIC-REFINEMENT-REQUIRED-CONTRACTS](#rules).

---

## Rules

<!-- rule: EPIC-REFINEMENT-SCOPE-BOUNDARY -->
This procedure MUST stay refinement-only: no implementation, no PRs, no Copilot assignment.
Apply changes directly with `dev-loops issue edit` (raw `node scripts/github/edit-issue.mjs` remains a source-repo fallback) — never create new issues or PRs. Hierarchy MUST
stay in the GitHub sub-issues API, not prose parent/child links or a duplicated child-list
checklist in parent bodies.

<!-- rule: EPIC-REFINEMENT-REQUIRED-CONTRACTS -->
Each issue in the tree MUST carry: the authoritative AC→DoD mapping matrix (a two-column
table mapping each acceptance-criterion outcome to its required completion evidence), a
non-goals section, and an explicit scope boundary in the format
`"This issue owns X. It does NOT own Y (#NNN) or Z (#MMM)."` (#1951). Interactive issue-side
AC / DoD checklists are NOT required — the matrix is the authoritative AC→DoD artifact and
`loop-grill` synthesizes a matrix-only body; the PR carries the derived list-form checklists.
The deterministic verifier is `refinement-completeness-checker.mjs` (shares `detectAcDodMatrix`
with the enqueue/draft gate), which rejects a missing/empty/identifier-only matrix.

<!-- rule: EPIC-REFINEMENT-CONFIRM-BEFORE-MUTATE -->
`EPIC-REFINEMENT-CONFIRM-BEFORE-MUTATE`: The procedure MUST write the refined body to
`tmp/issues/<number>/refinement/` first and MUST show the diff and get confirmation before
each `dev-loops issue edit` mutation, unless running unattended with explicit authorization.

---

## Completion criteria

The procedure is complete when all issues in the tree satisfy [EPIC-REFINEMENT-REQUIRED-CONTRACTS](#rules), verified as:

| Check | How to verify |
|---|---|
| AC/DoD matrix present + valid | Issue body contains a two-column `## AC / DoD matrix` table mapping each criterion outcome to concrete completion evidence (empty or identifier-only tables are rejected) |
| Non-goals present | Issue body contains `## Non-goals` section |
| Scope boundary present | Issue body contains explicit `"This issue owns ... It does NOT own ..."` text |
| No orphaned responsibilities | Each thing the parent delegates maps to exactly one child |
| No duplicate ownership | No two siblings claim the same responsibility |
| Sub-issue tree order valid | `manage-sub-issues.mjs verify --ordered` exits 0 **and** its JSON reports `verified: true`; see [Sub-Issue Tree Contract](./sub-issue-tree-contract.md). A mismatch exits 0 with `verified: false` and is not completion. |

---

## Example traversal for a 3-level tree

For root #715 with children #716, #717, #718 and grandchildren #720–#729:

```
Phase A: #715 refine
Phase B level 2 (parallel): #716 refine  ‖  #717 refine  ‖  #718 refine
Phase B level 3 (parallel): #720 ‖ #721 ‖ #722  (under #716)
                             #723 ‖ #724         (under #717)
                             #726 ‖ #729 ‖ #727 ‖ #728  (under #718)
Phase C level 2 (parallel): #716 reconcile  ‖  #717 reconcile  ‖  #718 reconcile
Phase D: #715 root reconcile
```

Wall-clock serial steps: 5 (not 17).
