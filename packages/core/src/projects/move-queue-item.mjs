import { runChild as _runChild } from "../cli/primitives.mjs";
import { parseJsonText } from "../github/review-threads.mjs";
import { decideEnqueueRefinementGate, detectIssueRefinementArtifact } from "../loop/issue-refinement-artifact.mjs";
import { loadStateColumnMap, LOGICAL_COLUMN } from "../loop/queue-board-sync.mjs";
import { resolveProjectSelector, findProject, parseItemRef } from "./resolve-project.mjs";

// ── Validation ───────────────────────────────────────────────────────────

const OWNER_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/;
const REPO_NAME_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9_.-]*[a-zA-Z0-9])?$/;

function validateRepo(repo) {
  if (!repo || typeof repo !== "string") {
    throw Object.assign(new Error("--repo is required"), { code: "INVALID_REPO" });
  }
  const trimmed = repo.trim();
  if (trimmed !== repo) {
    throw Object.assign(new Error(`--repo must not have leading/trailing whitespace, got "${repo}"`), { code: "INVALID_REPO" });
  }
  const slashIdx = repo.indexOf("/");
  if (slashIdx === -1) {
    throw Object.assign(new Error(`--repo must be exactly owner/name, got "${repo}"`), { code: "INVALID_REPO" });
  }
  const owner = repo.slice(0, slashIdx);
  const name = repo.slice(slashIdx + 1);
  if (!owner || !name || !OWNER_RE.test(owner) || !REPO_NAME_RE.test(name)) {
    throw Object.assign(new Error(`--repo must be exactly owner/name, got "${repo}"`), { code: "INVALID_REPO" });
  }
  return repo;
}

// ── API helpers ──────────────────────────────────────────────────────────

async function ghGraphql(query, vars, env, runChild = _runChild) {
  const fieldArgs = [];
  for (const [key, value] of Object.entries(vars)) {
    fieldArgs.push("--field", `${key}=${value}`);
  }
  const result = await runChild(
    "gh",
    ["api", "graphql", "--field", `query=${query}`, ...fieldArgs],
    env,
  );
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    throw Object.assign(new Error(`gh api graphql failed: ${detail}`), { code: "GH_API_ERROR" });
  }
  const payload = parseJsonText(result.stdout);
  if (payload.errors && payload.errors.length > 0) {
    throw Object.assign(
      new Error(`GraphQL errors: ${payload.errors.map((e) => e.message).join("; ")}`),
      { code: "GRAPHQL_ERROR" },
    );
  }
  return payload;
}

// ── GraphQL fragments ────────────────────────────────────────────────────

const GET_USER_ID = [
  "query($login:String!) {",
  "  user(login:$login) { id }",
  "}"
].join("\n");

const GET_ORG_ID = [
  "query($login:String!) {",
  "  organization(login:$login) { id }",
  "}"
].join("\n");

const LIST_USER_PROJECTS = [
  "query($login:String!, $after:String) {",
  "  user(login:$login) {",
  "    projectsV2(first:50, after:$after) {",
  "      pageInfo { hasNextPage endCursor }",
  "      nodes { id number title url }",
  "    }",
  "  }",
  "}"
].join("\n");

const LIST_ORG_PROJECTS = [
  "query($login:String!, $after:String) {",
  "  organization(login:$login) {",
  "    projectsV2(first:50, after:$after) {",
  "      pageInfo { hasNextPage endCursor }",
  "      nodes { id number title url }",
  "    }",
  "  }",
  "}"
].join("\n");

const GET_PROJECT_FIELDS = [
  "query($projectId:ID!, $after:String) {",
  "  node(id:$projectId) {",
  "    ... on ProjectV2 {",
  "      fields(first:50, after:$after) {",
  "        pageInfo { hasNextPage endCursor }",
  "        nodes {",
  "          ... on ProjectV2SingleSelectField {",
  "            id name",
  "            options { id name }",
  "          }",
  "        }",
  "      }",
  "    }",
  "  }",
  "}"
].join("\n");

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

// ── Owner resolution ────────────────────────────────────────────────────

async function resolveOwner(login, env, runChild) {
  const userPayload = await ghGraphql(GET_USER_ID, { login }, env, runChild);
  if (userPayload?.data?.user?.id) {
    return { id: userPayload.data.user.id, kind: "user" };
  }
  const orgPayload = await ghGraphql(GET_ORG_ID, { login }, env, runChild);
  if (orgPayload?.data?.organization?.id) {
    return { id: orgPayload.data.organization.id, kind: "org" };
  }
  throw Object.assign(
    new Error(`Could not resolve owner ID for "${login}"`),
    { code: "NO_USER_ID" },
  );
}

// ── Paginated project listing ────────────────────────────────────────────

async function listAllProjects(login, kind, env, runChild) {
  const query = kind === "org" ? LIST_ORG_PROJECTS : LIST_USER_PROJECTS;
  const projects = [];
  let after = null;
  while (true) {
    const vars = { login };
    if (after) vars.after = after;
    const payload = await ghGraphql(query, vars, env, runChild);
    const connection = kind === "org"
      ? payload?.data?.organization?.projectsV2
      : payload?.data?.user?.projectsV2;
    const nodes = connection?.nodes ?? [];
    projects.push(...nodes);
    const pageInfo = connection?.pageInfo ?? {};
    if (!pageInfo.hasNextPage) break;
    if (!pageInfo.endCursor) {
      throw Object.assign(
        new Error("Invalid projects list payload: hasNextPage is true but endCursor is missing"),
        { code: "GH_API_ERROR" },
      );
    }
    after = pageInfo.endCursor;
  }
  return projects;
}

// ── Paginated field listing ──────────────────────────────────────────────

async function listAllFields(projectId, env, runChild) {
  const fields = [];
  let after = null;
  while (true) {
    const vars = { projectId };
    if (after) vars.after = after;
    const payload = await ghGraphql(GET_PROJECT_FIELDS, vars, env, runChild);
    const connection = payload?.data?.node?.fields;
    const nodes = connection?.nodes ?? [];
    fields.push(...nodes);
    const pageInfo = connection?.pageInfo ?? {};
    if (!pageInfo.hasNextPage) break;
    if (!pageInfo.endCursor) {
      throw Object.assign(
        new Error("Invalid fields payload: hasNextPage is true but endCursor is missing"),
        { code: "GH_API_ERROR" },
      );
    }
    after = pageInfo.endCursor;
  }
  return fields;
}

// ── Paginated item listing (position order) ──────────────────────────────

async function fetchAllItems(projectId, env, runChild) {
  const items = [];
  let after = null;
  while (true) {
    const vars = { projectId };
    if (after) vars.after = after;
    const payload = await ghGraphql(GET_PROJECT_ITEMS_BY_CONTENT, vars, env, runChild);
    const connection = payload?.data?.node?.items;
    const nodes = connection?.nodes ?? [];
    items.push(...nodes);
    const pageInfo = connection?.pageInfo ?? {};
    if (!pageInfo.hasNextPage) break;
    if (!pageInfo.endCursor) {
      throw Object.assign(
        new Error("Invalid items payload: hasNextPage is true but endCursor is missing"),
        { code: "GH_API_ERROR" },
      );
    }
    after = pageInfo.endCursor;
  }
  return items;
}

function statusOf(node) {
  const fvs = node?.fieldValues?.nodes ?? [];
  for (const fv of fvs) {
    if (fv && fv.field && fv.field.name === "Status") return fv.name;
  }
  return null;
}

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
  // here (in core, not the script wrapper) so every caller routing through
  // core — including reconcile-queue.mjs — shares the guard. The column name is
  // only derivable when cwd/config is supplied: an interactive `queue move` from
  // a worktree passes cwd (gate fires), while headless callers (e.g.
  // reconcile-queue.mjs, which never moves to the pickup column anyway) omit it
  // and are unaffected — we simply never derive the column.
  let refinement = null;
  if (issueNumber !== null && typeof cwd === "string" && cwd.length > 0) {
    const { columnNames, error: columnError } = loadStateColumnMap(cwd);
    if (!columnError) {
      const pickupColumn = columnNames[LOGICAL_COLUMN.NEXT_UP];
      if (pickupColumn && toColumn === pickupColumn) {
        const bodyResult = await child(
          "gh",
          ["issue", "view", String(issueNumber), "--repo", repo, "--json", "body"],
          env,
        );
        if (bodyResult.code !== 0) {
          const detail = bodyResult.stderr.trim() || `exit code ${bodyResult.code}`;
          throw Object.assign(new Error(`gh issue view failed: ${detail}`), { code: "GH_API_ERROR" });
        }
        const bodyPayload = parseJsonText(bodyResult.stdout);
        const body = typeof bodyPayload?.body === "string" ? bodyPayload.body : "";
        const artifact = detectIssueRefinementArtifact({ body, issueNumber });
        const decision = decideEnqueueRefinementGate({ artifact, targetIsPickup: true, auto: false });
        if (decision.action === "block") {
          throw Object.assign(new Error(decision.reason), {
            code: "MISSING_REFINEMENT_ARTIFACT",
            missing: decision.missing,
          });
        }
        refinement = { refined: decision.action === "enqueue" };
      }
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
