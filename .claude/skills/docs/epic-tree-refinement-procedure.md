# Epic tree refinement procedure

This document is the canonical procedure for depth-first, top-down-then-bottom-up refinement of
an existing GitHub sub-issue tree (parent → children → grandchildren).

Use it together with:
- [Issue Intake Procedure](./issue-intake-procedure.md) — Phase 3b calls this procedure for epic decomposition
- [Sub-Issue Tree Contract](../../docs/sub-issue-tree-contract.md) — authoritative sub-issue tooling (source-repo reference)

When you have a tree of GitHub issues that already exists and you need to align AC, DoD, scope
boundaries, and delegation contracts across all levels, follow this procedure. It is deterministic
enough that a fresh agent can run it without prior context about the tree.

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
| **AC/DoD matrix** | A two-column table mapping each acceptance criterion to its corresponding DoD checklist item(s) |

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
1. Read the current body: `gh issue view <root> --repo <repo> --json number,title,body`
2. Confirm the problem statement is clear and scoped
3. Confirm a **phase scope table** exists — one row per immediate child naming what each child
   owns and what it excludes; add or update this table if missing
4. Confirm **AC checklist** covers the end-to-end goal (not the implementation details owned by children)
5. Confirm **DoD checklist** — merge-ready condition for the root issue as a whole
6. Confirm **AC/DoD matrix** — each AC maps to at least one DoD item
7. Confirm **non-goals** section — prevents scope creep into adjacent areas
8. Write the updated body to a tmp file: `tmp/issues/<root>/refinement/root-body.md`
9. Show the diff and obtain confirmation before mutating GitHub
10. Apply: `gh issue edit <root> --repo <repo> --body-file tmp/issues/<root>/refinement/root-body.md`

**Gate:** Phase B must not start until Phase A is complete and the root body is updated on GitHub.

---

### Phase B — Descend: refine children against parent (parallel fan-out per level)

For **each level** of the tree (breadth-first traversal of levels, depth-first traversal within
a single branch), refine all siblings in parallel — siblings are independent and only need the
parent's updated body, not each other's output.

**For each issue at this level:**

1. Read the parent's updated body: `gh issue view <parent> --repo <repo> --json number,title,body`
2. Read the current child body: `gh issue view <child> --repo <repo> --json number,title,body`
3. Verify the child's scope matches what the parent's phase table delegates to it
4. Identify any overlap with sibling issues (read sibling titles/bodies if needed)
5. Refine the child body with:
   - **Scope boundary** (explicit): `"This issue owns X. It does NOT own Y (#NNN) or Z (#MMM)."`
   - **AC checklist** specific to this child's bounded scope
   - **DoD checklist** — when is this child independently closable?
   - **AC/DoD matrix**
   - **Non-goals** — what this child intentionally excludes
6. Write refined body to `tmp/issues/<child>/refinement/child-body.md`
7. Show the diff and obtain confirmation before mutating (unless running unattended with explicit authorization)
8. Apply: `gh issue edit <child> --repo <repo> --body-file tmp/issues/<child>/refinement/child-body.md`

**Parallelism rule:** All siblings at the same level can be refined concurrently. No child needs
another child's output; each child only reads the parent's contract and its own current body.

**Serial gate between levels:** All children at level N must complete before descending to level N+1.

Repeat Phase B until all leaves are refined.

---

### Phase C — Ascend: reconcile parents with children (parallel fan-out per level)

After all children under a given parent are refined, reconcile that parent. Work bottom-up.

All parents at the same depth can be reconciled in parallel (they only need their own children's
updated bodies, not sibling parents).

**For each parent (bottom-up):**

1. Re-read the parent body: `gh issue view <parent> --repo <repo> --json number,title,body`
2. Re-read all direct children bodies
3. Verify:
   - The parent's phase scope table still matches what the children now claim to own
   - No orphaned responsibilities (parent promised something no child owns)
   - No duplicate ownership (two children claiming the same thing)
4. Update the parent's phase scope table and AC/DoD as needed to reflect what children now explicitly own
5. Write refined body to `tmp/issues/<parent>/refinement/parent-reconciled-body.md`
6. Show the diff and obtain confirmation before mutating
7. Apply: `gh issue edit <parent> --repo <repo> --body-file tmp/issues/<parent>/refinement/parent-reconciled-body.md`

**Serial gate between levels:** All parents at depth N must complete reconciliation before ascending to depth N-1.

---

### Phase D — Root final reconcile (serial)

After all immediate children of the root have been reconciled:

1. Re-read the root body: `gh issue view <root> --repo <repo> --json number,title,body`
2. Re-read all immediate children bodies
3. Verify:
   - Phase scope table matches actual child scope
   - Dependency chain is correct (does execution order in the sub-issue tree match dependencies?)
   - No orphaned responsibilities; no duplicate ownership
4. Update the root body with the final reconciled phase scope table and AC/DoD
5. Write to `tmp/issues/<root>/refinement/root-final-body.md`
6. Show the diff and obtain confirmation before mutating
7. Apply: `gh issue edit <root> --repo <repo> --body-file tmp/issues/<root>/refinement/root-final-body.md`
8. Verify the sub-issue tree still reflects the correct execution order:
   ```sh
   node <resolved-skill-scripts>/github/manage-sub-issues.mjs verify \
     --repo <repo> --issue <root> --expected <n1,n2,...> --ordered
   ```

**Gate:** Root final reconcile completes the procedure. All issues in the tree must now have:
- AC checklist, DoD checklist, AC/DoD matrix, non-goals, explicit scope boundary

---

## Rules

- **No implementation, no PRs, no Copilot assignment** — this procedure is refinement-only
- **Use `gh issue edit`** to apply changes directly — do not create new issues or PRs
- **No prose parent/child links in bodies** — GitHub sub-issues API handles hierarchy
- **Each issue must have:** AC checklist, DoD checklist, non-goals, AC/DoD matrix, scope boundary
- **Scope boundary format:** `"This issue owns X. It does NOT own Y (#NNN) or Z (#MMM)."`
- **Show the diff** and get confirmation before each `gh issue edit` mutation (unless unattended with explicit authorization)
- **Write tmp artifacts** under `tmp/issues/<number>/refinement/` before applying
- **Do not duplicate** the child list in parent bodies — the sub-issue tree API owns hierarchy

---

## Parallelism model

Sibling refinements are independent: siblings only need the parent's contract, not each other's
output. The wall-clock complexity is O(depth), not O(nodes).

```text
Phase A:  [root]                            serial (1 step)
Phase B:  [child1 || child2 || child3]      parallel per level (1 step per level)
          [gc1a || gc1b || gc2a || gc3a]    parallel per level (1 step per level)
Phase C:  [child1 || child2 || child3]      parallel per level (1 step per level)
Phase D:  [root]                            serial (1 step)
```

Total serial steps for a tree with depth D: `1 + (D-1) + (D-1) + 1 = 2D`

**Fan-out rule:** At any level, when a parent is refined, ALL its children can be refined in parallel.

**Serial gates:**
- Root refinement must complete before any child starts
- A parent's reconciliation must wait for ALL its children to finish
- Root reconciliation must wait for all immediate children to reconcile

---

## Completion criteria

The procedure is complete when all issues in the tree satisfy:

| Check | How to verify |
|---|---|
| AC checklist present | Issue body contains `## Acceptance Criteria` with at least one `- [ ]` item |
| DoD checklist present | Issue body contains `## Definition of Done` with at least one `- [ ]` item |
| AC/DoD matrix present | Issue body contains a two-column table mapping AC items to DoD items |
| Non-goals present | Issue body contains `## Non-goals` section |
| Scope boundary present | Issue body contains explicit `"This issue owns ... It does NOT own ..."` text |
| No orphaned responsibilities | Each thing the parent delegates maps to exactly one child |
| No duplicate ownership | No two siblings claim the same responsibility |
| Sub-issue tree order valid | `manage-sub-issues.mjs verify --ordered` exits 0 |

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

---

## Relationship to other procedures

| Procedure | When to use it |
|---|---|
| [Issue Intake Procedure](./issue-intake-procedure.md) Phase 3b | *Creating* a new sub-issue tree from an umbrella issue |
| **This procedure** | *Refining* an existing sub-issue tree to align scope, AC, DoD, and delegation contracts |
| [Sub-Issue Tree Contract](../../docs/sub-issue-tree-contract.md) | Tooling for listing, attaching, ordering, and verifying sub-issue trees |

These are complementary. Phase 3b creates the structure; this procedure aligns the contracts.
