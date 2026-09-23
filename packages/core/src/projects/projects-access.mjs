// Canonical, package-owned Projects V2 read mechanics shared by the core
// list/move/board-sync operations and the root add/ensure/reorder/archive
// scripts (issue #2038). This module owns ONLY the read mechanics that were
// byte-for-byte duplicated across those callers:
//
//   - strict `owner/name` repository validation (INVALID_REPO)
//   - the identical `projectsV2` discovery query + cursor traversal
//   - a generic connection cursor traversal (each caller supplies its own
//     query projection, page size, and traversal boundary)
//   - the identical single-select `Status` field listing
//   - `Status` option extraction from an item's field values
//
// It deliberately does NOT own selection policy, caching, null handling,
// error presentation, mutation policy, or public result shaping — those stay
// in each command/domain owner. It composes the already-canonical GitHub
// transport (`ghGraphql`); owner resolution (`resolveOwner`) stays canonical
// at each caller. It adds no second transport, client class, query DSL, or
// pagination framework.
//
// It imports neither queue orchestration nor repository-root scripts.
import { ghGraphql } from "../github/gh.mjs";

// ── Repository validation ──────────────────────────────────────────────────

const OWNER_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/;
const REPO_NAME_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9_.-]*[a-zA-Z0-9])?$/;

/**
 * Validate a `--repo` value as exactly `owner/name`. Throws INVALID_REPO on
 * empty/missing input, leading/trailing whitespace, a missing slash, or an
 * owner/name that fails GitHub's slug shape. Returns the input unchanged on
 * success. This is the strict Projects repository acceptance rule — narrower
 * than the general repo-slug parser, which is intentionally not substituted.
 */
export function validateProjectsRepo(repo) {
  if (!repo || typeof repo !== "string") {
    throw Object.assign(new Error("--repo is required"), { code: "INVALID_REPO" });
  }
  const trimmed = repo.trim();
  if (trimmed !== repo) {
    throw Object.assign(
      new Error(`--repo must not have leading/trailing whitespace, got "${repo}"`),
      { code: "INVALID_REPO" },
    );
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

// ── Generic connection cursor traversal ────────────────────────────────────

/**
 * Walk a GraphQL Relay-style connection to completion, accumulating every
 * page's `nodes` in order. Each caller supplies the query, the base variables
 * (the `$after` cursor is injected only once a page reports one), and a
 * `selectConnection(payload)` selector that returns the `{ nodes, pageInfo }`
 * connection for that query. `entity` names the connection in the malformed
 * -page error only.
 *
 * Preserved boundary semantics (identical to every migrated copy):
 *   - pages are concatenated in returned order (position/continuation order)
 *   - `after` is set from `pageInfo.endCursor` only when `hasNextPage` is true
 *   - a page that reports `hasNextPage` with no `endCursor` fails closed with
 *     code GH_API_ERROR (an unpaginatable continuation is never silently
 *     truncated)
 *
 * @param {object} opts
 * @param {string} opts.query
 * @param {object} [opts.variables]
 * @param {(payload:any)=>any} opts.selectConnection
 * @param {object} opts.env
 * @param {Function} opts.runChild
 * @param {string} [opts.entity]
 * @returns {Promise<any[]>}
 */
export async function paginateNodes({ query, variables = {}, selectConnection, env, runChild, entity = "connection" }) {
  const acc = [];
  let after = null;
  while (true) {
    const vars = { ...variables };
    if (after) vars.after = after;
    const payload = await ghGraphql(query, vars, env, runChild);
    const connection = selectConnection(payload);
    const nodes = connection?.nodes ?? [];
    acc.push(...nodes);
    const pageInfo = connection?.pageInfo ?? {};
    if (!pageInfo.hasNextPage) break;
    if (!pageInfo.endCursor) {
      throw Object.assign(
        new Error(`Invalid ${entity} payload: hasNextPage is true but endCursor is missing`),
        { code: "GH_API_ERROR" },
      );
    }
    after = pageInfo.endCursor;
  }
  return acc;
}

// ── Project discovery ──────────────────────────────────────────────────────

const LIST_USER_PROJECTS = [
  "query($login:String!, $after:String) {",
  "  user(login:$login) {",
  "    projectsV2(first:50, after:$after) {",
  "      pageInfo { hasNextPage endCursor }",
  "      nodes { id number title url }",
  "    }",
  "  }",
  "}",
].join("\n");

const LIST_ORG_PROJECTS = [
  "query($login:String!, $after:String) {",
  "  organization(login:$login) {",
  "    projectsV2(first:50, after:$after) {",
  "      pageInfo { hasNextPage endCursor }",
  "      nodes { id number title url }",
  "    }",
  "  }",
  "}",
].join("\n");

/**
 * Discover every ProjectV2 (id/number/title/url) owned by `login`, resolving
 * the user vs organization query from `kind` ("org" selects the organization
 * root, anything else the user root). Traverses all pages. Returns raw nodes;
 * callers that need null filtering (board-sync) filter the result themselves.
 */
export function discoverProjects(login, kind, env, runChild) {
  const isOrg = kind === "org";
  return paginateNodes({
    query: isOrg ? LIST_ORG_PROJECTS : LIST_USER_PROJECTS,
    variables: { login },
    selectConnection: (payload) =>
      isOrg ? payload?.data?.organization?.projectsV2 : payload?.data?.user?.projectsV2,
    env,
    runChild,
    entity: "projects list",
  });
}

// ── Status field listing ───────────────────────────────────────────────────

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
  "}",
].join("\n");

/**
 * List every single-select field (id/name + `options{id name}`) on a project,
 * traversing all pages. This is the identical field projection used by the
 * list/move/add callers. Operations that need a wider option projection (e.g.
 * ensure-queue-board, which also reads option color/description for repair)
 * call `paginateNodes` with their own field query instead.
 */
export function listProjectFields(projectId, env, runChild) {
  return paginateNodes({
    query: GET_PROJECT_FIELDS,
    variables: { projectId },
    selectConnection: (payload) => payload?.data?.node?.fields,
    env,
    runChild,
    entity: "fields",
  });
}

// ── Status extraction ──────────────────────────────────────────────────────

/**
 * Extract an item's current `Status` single-select option name from its
 * `fieldValues`, or null when the item has no Status value. Preserves the
 * exact matching used by every caller: the first field value whose owning
 * single-select field is named "Status".
 */
export function extractStatus(node) {
  const fvs = node?.fieldValues?.nodes ?? [];
  for (const fv of fvs) {
    if (fv && fv.field && fv.field.name === "Status") return fv.name;
  }
  return null;
}

// ── Single item resolution ─────────────────────────────────────────────────

// Item projection shared by both lookups. It matches the board listing node
// shape (id, fieldValues, content) so `extractStatus` works on the result.
const ITEM_FIELDS = [
  "id isArchived project { id }",
  "fieldValues(first:20) {",
  "  nodes {",
  "    ... on ProjectV2ItemFieldSingleSelectValue {",
  "      field { ... on ProjectV2SingleSelectField { id name } }",
  "      name",
  "    }",
  "  }",
  "}",
  "content {",
  "  ... on Issue { __typename number repository { nameWithOwner } }",
  "  ... on PullRequest { __typename number repository { nameWithOwner } }",
  "}",
].join("\n");

// ponytail: projectItems(first:100) ceiling; an issue on more than 100 boards needs a page loop here.
const GET_ITEMS_BY_CONTENT_NUMBER = [
  "query($owner:String!, $name:String!, $number:Int!) {",
  "  repository(owner:$owner, name:$name) {",
  "    issueOrPullRequest(number:$number) {",
  `      ... on Issue { projectItems(first:100, includeArchived:false) { nodes { ${ITEM_FIELDS} } } }`,
  `      ... on PullRequest { projectItems(first:100, includeArchived:false) { nodes { ${ITEM_FIELDS} } } }`,
  "    }",
  "  }",
  "}",
].join("\n");

const GET_ITEM_BY_ID = [
  "query($id:ID!) {",
  `  node(id:$id) { ... on ProjectV2Item { ${ITEM_FIELDS} } }`,
  "}",
].join("\n");

function itemNotFound(message) {
  return Object.assign(new Error(message), { code: "ITEM_NOT_FOUND" });
}

/**
 * Throw GRAPHQL_ERROR for any GraphQL error in `payload` other than NOT_FOUND.
 * Use it on a `ghGraphql(..., { allowErrors: true })` payload where NOT_FOUND
 * means "no such entity" and every other error must keep its message.
 */
export function assertOnlyNotFoundErrors(payload) {
  const other = (payload?.errors ?? []).filter((e) => e?.type !== "NOT_FOUND");
  if (other.length > 0) {
    throw Object.assign(
      new Error(`GraphQL errors: ${other.map((e) => e.message).join("; ")}`),
      { code: "GRAPHQL_ERROR" },
    );
  }
}

/**
 * Resolve one project item without the whole-board `ProjectV2.items` listing,
 * which can lag behind GitHub by hours and omit newly added items.
 *
 *   - number ref: read the issue or PR's own `projectItems` and pick the
 *     unarchived item on `projectId`.
 *   - id ref: look the item node up directly, then verify that it belongs to
 *     `projectId` and that its content is in `repo`.
 *
 * Every miss or mismatch fails closed with code ITEM_NOT_FOUND. Returns a node
 * in the listing shape: `{ id, isArchived, project, fieldValues, content }`.
 *
 * @param {object} opts
 * @param {string} opts.projectId
 * @param {string} [opts.projectTitle]  shown in ITEM_NOT_FOUND messages when present
 * @param {string} opts.repo  validated `owner/name`
 * @param {{kind:"number"|"id", value:number|string}} opts.itemRef  from parseItemRef
 * @param {object} opts.env
 * @param {Function} opts.runChild
 */
export async function resolveProjectItem({ projectId, projectTitle, repo, itemRef, env, runChild }) {
  const projectLabel = projectTitle ?? projectId;
  if (itemRef.kind === "number") {
    const [owner, name] = repo.split("/");
    const payload = await ghGraphql(
      GET_ITEMS_BY_CONTENT_NUMBER,
      { owner, name, number: itemRef.value },
      env,
      runChild,
      { allowErrors: true },
    );
    const nodes = payload?.data?.repository?.issueOrPullRequest?.projectItems?.nodes ?? [];
    const match = nodes.find((n) => n && n.project?.id === projectId && !n.isArchived);
    if (!match) {
      // A partial response can carry errors for other boards the token cannot
      // read (e.g. FORBIDDEN). A match on the configured board wins; the error
      // is raised only when no match exists.
      assertOnlyNotFoundErrors(payload);
      throw itemNotFound(`Item #${itemRef.value} not found in project "${projectLabel}" for repo "${repo}"`);
    }
    return match;
  }

  const payload = await ghGraphql(GET_ITEM_BY_ID, { id: itemRef.value }, env, runChild, { allowErrors: true });
  assertOnlyNotFoundErrors(payload);
  const node = payload?.data?.node;
  if (!node?.id || node.isArchived) {
    throw itemNotFound(`Item "${itemRef.value}" not found in project "${projectLabel}" for repo "${repo}"`);
  }
  if (node.project?.id !== projectId) {
    throw itemNotFound(
      `Item "${itemRef.value}" belongs to project "${node.project?.id ?? "(unknown)"}", not "${projectId}"`,
    );
  }
  const itemRepo = node.content?.repository?.nameWithOwner ?? null;
  if (itemRepo !== repo) {
    throw itemNotFound(`Item "${itemRef.value}" is for repo "${itemRepo ?? "(none)"}", not "${repo}"`);
  }
  return node;
}
