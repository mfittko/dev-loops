import { runChild as _runChild } from "../cli/primitives.mjs";
import { runPickupRefinementGate } from "../loop/issue-refinement-artifact.mjs";
import { loadStateColumnMap, LOGICAL_COLUMN } from "../loop/queue-board-sync.mjs";
import { resolveProjectSelector, findProject, parseItemRef } from "./resolve-project.mjs";
import { ghGraphql, resolveOwner } from "../github/gh.mjs";
import { validateProjectsRepo, discoverProjects, listProjectFields, paginateNodes, extractStatus } from "./projects-access.mjs";

// ── Validation ───────────────────────────────────────────────────────────

const validateRepo = validateProjectsRepo;

// ── GraphQL fragments ────────────────────────────────────────────────────

const GET_PROJECT_ITEMS_BY_CONTENT = [
  "query($projectId:ID!, $after:String) {",
  "  node(id:$projectId) {",
  "    ... on ProjectV2 {",
  "      items(first:100, after:$after, orderBy:{field:POSITION, direction:ASC}) {",
  "        pageInfo { hasNextPage endCursor }",
  "        nodes {",
  "          id",
  "          fieldValues(first:20) {",
  "            nodes {",
  "              ... on ProjectV2ItemFieldSingleSelectValue {",
  "                field { ... on ProjectV2SingleSelectField { id name } }",
  "                name",
  "              }",
  "            }",
  "          }",
  "          content {",
  "            ... on Issue { __typename number repository { nameWithOwner } }",
  "            ... on PullRequest { __typename number repository { nameWithOwner } }",
  "          }",
  "        }",
  "      }",
  "    }",
  "  }",
  "}"
].join("\n");

const UPDATE_ITEM_FIELD = [
  "mutation($projectId:ID!, $itemId:ID!, $fieldId:ID!, $optionId:String!) {",
  "  updateProjectV2ItemFieldValue(input:{projectId:$projectId, itemId:$itemId, fieldId:$fieldId, value:{singleSelectOptionId:$optionId}}) {",
  "    projectV2Item {",
  "      id",
  "    }",
  "  }",
  "}"
].join("\n");

// ── Paginated project + field listing (shared via projects-access) ────────

const listAllProjects = discoverProjects;
const listAllFields = listProjectFields;

// ── Paginated item listing (position order) ──────────────────────────────

function fetchAllItems(projectId, env, runChild) {
  return paginateNodes({
    query: GET_PROJECT_ITEMS_BY_CONTENT,
    variables: { projectId },
    selectConnection: (payload) => payload?.data?.node?.items,
    env,
    runChild,
    entity: "items",
  });
}

const statusOf = extractStatus;

// ── Exit code classification ────────────────────────────────────────────

function classifyExitCode(err) {
  if (err.code === "INVALID_REPO" || err.code === "INVALID_PROJECT" || err.code === "INVALID_ITEM" ||
      err.code === "INVALID_COLUMN" || err.code === "INVALID_ARGS") return 1;
  if (err.code === "MISSING_REFINEMENT_ARTIFACT") return 4;
  if (err.code === "PROJECT_NOT_FOUND" || err.code === "FIELD_NOT_FOUND" || err.code === "COLUMN_NOT_FOUND" ||
      err.code === "ITEM_NOT_FOUND") return 3;
  return 2;
}

// ── Main logic ──────────────────────────────────────────────────────────

async function main(args, { env = process.env, runChild, cwd = null } = {}) {
  const child = runChild ?? _runChild;
  const repo = validateRepo(args.repo);
  const [owner, repoName] = repo.split("/");
  const selector = resolveProjectSelector(args);
  const itemRef = parseItemRef(args.item);
  const toColumn = (args.toColumn ?? "").trim();
  if (!toColumn) {
    throw Object.assign(new Error("--to-column is required"), { code: "INVALID_COLUMN" });
  }

  // 1. Resolve owner.
  // URI refs encode owner+kind directly; skip the API round-trip for owner resolution.
  const projectOwner = selector.projectRef?.kind === "uri" ? selector.projectRef.owner : owner;
  const ownerKind = selector.projectRef?.kind === "uri"
    ? selector.projectRef.ownerKind
    : (await resolveOwner(owner, env, child)).kind;

  // 2. Resolve project
  const projects = await listAllProjects(projectOwner, ownerKind, env, child);
  const project = findProject(projects, selector, projectOwner);

  // 3. Resolve Status field and target column
  const fieldNodes = await listAllFields(project.id, env, child);
  const statusField = fieldNodes.find((f) => f.name === "Status" && f.options);
  if (!statusField) {
    throw Object.assign(
      new Error(`Status field not found in project "${project.title}" (number ${project.number})`),
      { code: "FIELD_NOT_FOUND" },
    );
  }

  const targetOption = statusField.options.find((o) => o.name === toColumn);
  if (!targetOption) {
    const available = statusField.options.map((o) => o.name).join(", ");
    throw Object.assign(
      new Error(`Column "${toColumn}" not found in Status field. Available: ${available}`),
      { code: "COLUMN_NOT_FOUND" },
    );
  }

  // 4. Find the item.
  //
  // Fetch the full board item list ONCE (paginated, position order) and resolve
  // BOTH ref kinds against it. This reuses the proven pattern from
  // reorder-queue-item / list-queue-items: a node-id ref matches by item.id, a
  // number ref matches by content.number. Both are scoped to the requested repo
  // so a cross-project ref fails closed with ITEM_NOT_FOUND. (The previous code
  // used `ProjectV2.item` — a field that does not exist — for the node-id path,
  // and a single non-paginated `items(first:10)` page for the number path, so it
  // could not find items beyond the first page.)
  const allItems = await fetchAllItems(project.id, env, child);

  let match;
  if (itemRef.kind === "id") {
    match = allItems.find(
      (it) => it.id === itemRef.value && it.content?.repository?.nameWithOwner === repo,
    );
    if (!match) {
      throw Object.assign(
        new Error(`Item "${itemRef.value}" not found in project "${project.title}" for repo "${repo}"`),
        { code: "ITEM_NOT_FOUND" },
      );
    }
  } else {
    match = allItems.find(
      (it) =>
        it.content &&
        it.content.repository?.nameWithOwner === repo &&
        it.content.number === itemRef.value,
    );
    if (!match) {
      throw Object.assign(
        new Error(`Item #${itemRef.value} not found in project "${project.title}" for repo "${repo}"`),
        { code: "ITEM_NOT_FOUND" },
      );
    }
  }

  const itemId = match.id;
  const previousColumn = statusOf(match);
  let issueNumber = null;
  let prNumber = null;
  if (match.content) {
    if (match.content.__typename === "PullRequest") {
      prNumber = match.content.number;
    } else {
      issueNumber = match.content.number;
    }
  }

  // 5. No-op if already at target column
  if (previousColumn === toColumn) {
    return {
      ok: true,
      item: {
        itemId,
        issueNumber,
        prNumber,
        previousColumn,
        newColumn: toColumn,
        unchanged: true,
      },
    };
  }

  // 5b. QUEUE-ENQUEUE-REFINEMENT-GATE: moving an ISSUE into the pickup column
  // must pass the same refinement gate `queue add` applies — a guard at one
  // entry point but not its sibling is exactly the asymmetry this closes. Put
  // here (in core, not the script wrapper) so every caller routing through core
  // is covered — reconcile-queue.mjs included. reconcile is unaffected because
  // it passes no cwd and never derives the pickup column. The column name is
  // only derivable when cwd/config is supplied: an interactive `queue move` from
  // a worktree passes cwd (gate fires), while headless callers (e.g.
  // reconcile-queue.mjs) omit it and are unaffected — we simply never derive
  // the column.
  let refinement = null;
  if (issueNumber !== null && typeof cwd === "string" && cwd.length > 0) {
    const { columnNames, error: columnError } = loadStateColumnMap(cwd);
    const pickupColumn = columnNames[LOGICAL_COLUMN.NEXT_UP];
    if (pickupColumn && toColumn === pickupColumn) {
      // Mirror queue add's fail-closed posture on a malformed `.devloops` when the
      // interactive path supplied cwd AND the target is actually the pickup
      // column: a config parse failure must never silently bypass the just-moved
      // pickup refinement gate (the exact sibling asymmetry this issue closes).
      // Scoped here (after the pickup-column guard) so an unrelated column move
      // is not over-broadened into a hard CONFIG_ERROR failure.
      if (columnError) {
        throw Object.assign(
          new Error(`could not resolve the pickup column (config read/parse error: ${columnError})`),
          { code: "CONFIG_ERROR" },
        );
      }
      const decision = await runPickupRefinementGate({ issueNumber, repo, env, runChild: child, auto: false, repoRoot: cwd });
      refinement = { refined: decision.action === "enqueue" };
    }
  }

  // 6. Update Status via mutation
  const updatePayload = await ghGraphql(UPDATE_ITEM_FIELD, {
    projectId: project.id,
    itemId,
    fieldId: statusField.id,
    optionId: targetOption.id,
  }, env, child);

  const updated = updatePayload?.data?.updateProjectV2ItemFieldValue?.projectV2Item;
  if (!updated) {
    throw Object.assign(new Error("Failed to update item field value"), { code: "MUTATION_FAILED" });
  }

  return {
    ok: true,
    item: {
      itemId,
      issueNumber,
      prNumber,
      previousColumn,
      newColumn: toColumn,
      unchanged: false,
    },
    ...(refinement ? { refinement } : {}),
  };
}

export { main, classifyExitCode };
