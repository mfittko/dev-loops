#!/usr/bin/env node
import { formatCliError, isDirectCliRun, parseJsonText } from "../_core-helpers.mjs";
import { runChild as _runChild } from "../_cli-primitives.mjs";
import { resolveProjectSelector, findProject, applyDevloopsBoard } from "./_resolve-project.mjs";
import { parseArgs } from "node:util";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";

const USAGE = `Usage:
  dev-loops queue reorder --repo <owner/name> --project <number|id|board-uri> --item <number|node-id> [--after <number|node-id>]
  dev-loops queue reorder move-to-top <ref> --repo <owner/name> --project <number|id|board-uri>
  dev-loops queue reorder move-after <ref> <after-ref> --repo <owner/name> --project <number|id|board-uri>
  dev-loops queue reorder order <ref1> <ref2> ... --repo <owner/name> --project <number|id|board-uri>
  (dev-loops project reorder … is a back-compat alias)

Reorder GitHub Projects V2 items by board position via updateProjectV2ItemPosition.

Forms:
  (no subcommand)   Flag form. Moves --item to top, or after --after when provided.
  move-to-top <ref> Move <ref> to the first position in its current Status column.
  move-after <ref> <after-ref>
                    Move <ref> immediately after <after-ref>.
  order <ref1> ...  Set explicit ordering: ref1 first, ref2 after ref1, and so on.

A <ref> is an issue/PR number OR a project item node ID. Works for both issues and PRs.

Options:
  --repo <owner/name>                 Required. Repository to scope the project search.
  --project <number|id|board-uri>     Project number, node ID, or board URI
                                      (e.g. https://github.com/users/me/projects/3).
                                      When omitted, resolved from .devloops
                                      queue.projectNumber / queue.boardTitle.
  --item <number|node-id>             Flag form: item to reorder.
  --after <number|node-id>            Flag form: position after this item. When omitted, move to top.
  --dry-run                           Print the intended GraphQL mutation(s) without executing.
  --help, -h                          Show this help.

Output (stdout):
  JSON. Move/move-to-top: { ok, item, after_ref|null, before, after }.
        order: { ok, moves: [...], before, after }.
        dry-run: { ok, dryRun: true, mutations: [{ query, variables }], before }.

${JQ_OUTPUT_USAGE}

Exit codes:
  0 — success
  1 — usage or argument error
  2 — GitHub API error / invalid --jq filter
  3 — project, item, or after-item not found
`.trim();

const SUBCOMMANDS = new Set(["move-to-top", "move-after", "order"]);

function parseCliArgs(argv) {
  const parseError = (message) => Object.assign(new Error(message), { usage: USAGE });
  const requireValue = (token, message) => {
    const v = token.value;
    if (typeof v !== "string" || v.length === 0 || v.startsWith("-")) {
      throw parseError(message);
    }
    return v;
  };

  const args = { _positional: [] };
  let rest = argv;

  if (argv.length > 0 && SUBCOMMANDS.has(argv[0])) {
    args._subcommand = argv[0];
    rest = argv.slice(1);
  }

  const { tokens } = parseArgs({
    args: [...rest],
    options: {
      repo: { type: "string" },
      project: { type: "string" },
      item: { type: "string" },
      after: { type: "string" },
      "dry-run": { type: "boolean" },
      help: { type: "boolean", short: "h" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });

  for (const token of tokens) {
    if (token.kind === "positional") {
      args._positional.push(token.value);
      continue;
    }
    if (token.kind !== "option") {
      continue;
    }
    switch (token.name) {
      case "help":
        if (token.value !== undefined) {
          throw parseError(`Unknown flag: ${token.rawName}=${token.value}`);
        }
        args.help = true;
        break;
      case "repo":
        args.repo = requireValue(token, "--repo requires a value (owner/name)");
        break;
      case "project":
        args.project = requireValue(token, "--project requires a value (number or node ID)");
        break;
      case "item":
        args.item = requireValue(token, "--item requires a value (number or node ID)");
        break;
      case "after":
        args.after = requireValue(token, "--after requires a value (number or node ID)");
        break;
      case "dry-run":
        if (token.value !== undefined) {
          throw parseError(`Unknown flag: ${token.rawName}=${token.value}`);
        }
        args.dryRun = true;
        break;
      default: {
        if (matchJqOutputToken(token, args, (t) => requireValue(t, "--jq requires a filter"))) break;
        throw parseError(`Unknown flag: ${token.rawName}`);
      }
    }
  }
  return args;
}
// ── Validation ───────────────────────────────────────────────────────────

const OWNER_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/;
const REPO_NAME_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9_.-]*[a-zA-Z0-9])?$/;
const GLOBAL_NODE_ID_RE = /^[A-Za-z0-9_]+$/;

function validateRepo(repo) {
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

function parseItemRef(raw) {
  if (!raw || typeof raw !== "string" || raw.trim().length === 0) {
    throw Object.assign(new Error("--item is required"), { code: "INVALID_ITEM" });
  }
  const trimmed = raw.trim();
  const asNum = Number(trimmed);
  if (Number.isInteger(asNum) && asNum > 0 && String(asNum) === trimmed) {
    return { kind: "number", value: asNum };
  }
  if (trimmed === "0") {
    throw Object.assign(new Error(`--item must be a positive integer or an item node ID, got "${raw}"`), { code: "INVALID_ITEM" });
  }
  if (GLOBAL_NODE_ID_RE.test(trimmed)) {
    return { kind: "id", value: trimmed };
  }
  throw Object.assign(new Error(`--item must be a positive integer or an item node ID, got "${raw}"`), { code: "INVALID_ITEM" });
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

const GET_PROJECT_ITEMS_BY_CONTENT = [
  "query($projectId:ID!, $after:String) {",
  "  node(id:$projectId) {",
  "    ... on ProjectV2 {",
  "      items(first:10, after:$after, orderBy:{field:POSITION, direction:ASC}) {",
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

const GET_PROJECT_ITEM = [
  "query($projectId:ID!, $itemId:ID!) {",
  "  node(id:$projectId) {",
  "    ... on ProjectV2 {",
  "      item: item(id:$itemId) {",
  "        id",
  "        fieldValues(first:20) {",
  "          nodes {",
  "            ... on ProjectV2ItemFieldSingleSelectValue {",
  "              field { ... on ProjectV2SingleSelectField { id name } }",
  "              name",
  "            }",
  "          }",
  "        }",
  "        content {",
  "          ... on Issue { __typename number title url }",
  "          ... on PullRequest { __typename number title url }",
  "        }",
  "      }",
  "    }",
  "  }",
  "}"
].join("\n");

const UPDATE_ITEM_POSITION = [
  "mutation($projectId:ID!, $itemId:ID!, $afterId:ID) {",
  "  updateProjectV2ItemPosition(input:{projectId:$projectId, itemId:$itemId, afterId:$afterId}) {",
  "    clientMutationId",
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

// ── Fetch all project items (paginated, position order) ────────────────

async function fetchAllItems(projectId, env, runChild) {
  const allItems = [];
  let after = null;
  while (true) {
    const vars = { projectId };
    if (after) vars.after = after;
    const itemsPayload = await ghGraphql(GET_PROJECT_ITEMS_BY_CONTENT, vars, env, runChild);
    const connection = itemsPayload?.data?.node?.items;
    const nodes = connection?.nodes ?? [];
    allItems.push(...nodes);
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
  return allItems;
}

function statusOf(node) {
  const fvs = node?.fieldValues?.nodes ?? [];
  for (const fv of fvs) {
    if (fv && fv.field && fv.field.name === "Status") return fv.name;
  }
  return null;
}

function describeItem(node) {
  return {
    itemId: node.id,
    issueNumber: node.content?.__typename === "Issue" ? node.content.number : null,
    prNumber: node.content?.__typename === "PullRequest" ? node.content.number : null,
    status: statusOf(node),
  };
}

// Build a diff-friendly snapshot of items in `repo` (optionally a single Status
// column), in board position order, from a pre-fetched item list.
function snapshotFromItems(items, repo, statusFilter) {
  return items
    .filter((it) => it.content && it.content.repository?.nameWithOwner === repo)
    .filter((it) => (statusFilter == null ? true : statusOf(it) === statusFilter))
    .map(describeItem);
}

async function snapshotOrder(projectId, repo, statusFilter, env, runChild) {
  const items = await fetchAllItems(projectId, env, runChild);
  return snapshotFromItems(items, repo, statusFilter);
}

// Resolve a ref (number or item node ID) against a pre-fetched item list,
// enforcing the same repo scope for BOTH number and id refs so a cross-project
// ref fails closed with ITEM_NOT_FOUND.
function resolveFromItems(items, itemRef, repo) {
  let match;
  if (itemRef.kind === "id") {
    match = items.find(
      (it) => it.id === itemRef.value && it.content?.repository?.nameWithOwner === repo,
    );
    if (!match) {
      throw Object.assign(
        new Error(`Item "${itemRef.value}" not found in project for repo "${repo}"`),
        { code: "ITEM_NOT_FOUND" },
      );
    }
  } else {
    match = items.find(
      (it) =>
        it.content &&
        it.content.repository?.nameWithOwner === repo &&
        it.content.number === itemRef.value,
    );
    if (!match) {
      throw Object.assign(
        new Error(`Item #${itemRef.value} not found in project for repo "${repo}"`),
        { code: "ITEM_NOT_FOUND" },
      );
    }
  }
  return describeItem(match);
}

// ── Resolve an item in a project by reference (number or node ID) ──────

async function resolveProjectItem(projectId, itemRef, owner, repoName, repo, env, runChild) {
  let itemId;
  let issueNumber = null;
  let prNumber = null;
  let status = null;

  if (itemRef.kind === "id") {
    // Direct item node ID lookup
    const itemPayload = await ghGraphql(GET_PROJECT_ITEM, {
      projectId,
      itemId: itemRef.value,
    }, env, runChild);
    const item = itemPayload?.data?.node?.item;
    if (!item) {
      throw Object.assign(
        new Error(`Item "${itemRef.value}" not found in project`),
        { code: "ITEM_NOT_FOUND" },
      );
    }
    itemId = item.id;
    const fvs = item.fieldValues?.nodes ?? [];
    for (const fv of fvs) {
      if (fv && fv.field && fv.field.name === "Status") {
        status = fv.name;
        break;
      }
    }
    if (item.content) {
      if (item.content.__typename === "Issue") {
        issueNumber = item.content.number;
      } else {
        prNumber = item.content.number;
      }
    }
  } else {
    // Look up by issue/PR number in the project (paginated)
    const targetNumber = itemRef.value;
    const allItems = await fetchAllItems(projectId, env, runChild);

    // Filter by matching repo AND number exactly
    const matchingItems = allItems.filter((it) => {
      if (!it.content) return false;
      if (it.content.repository?.nameWithOwner !== repo) return false;
      return it.content.number === targetNumber;
    });

    if (matchingItems.length === 0) {
      throw Object.assign(
        new Error(`Item #${targetNumber} not found in project for repo "${repo}"`),
        { code: "ITEM_NOT_FOUND" },
      );
    }

    // Use the first match (by position order)
    const match = matchingItems[0];
    itemId = match.id;
    const fvs = match.fieldValues?.nodes ?? [];
    for (const fv of fvs) {
      if (fv && fv.field && fv.field.name === "Status") {
        status = fv.name;
        break;
      }
    }
    if (match.content) {
      if (match.content.__typename === "Issue") {
        issueNumber = match.content.number;
      } else {
        prNumber = match.content.number;
      }
    }
  }

  return { itemId, issueNumber, prNumber, status };
}

// ── Exit code classification ────────────────────────────────────────────

function classifyExitCode(err) {
  if (err.code === "INVALID_REPO" || err.code === "INVALID_PROJECT" || err.code === "INVALID_ITEM" ||
      err.code === "INVALID_AFTER" || err.code === "INVALID_ARGS") return 1;
  if (err.code === "PROJECT_NOT_FOUND" || err.code === "ITEM_NOT_FOUND" || err.code === "AFTER_ITEM_NOT_FOUND") return 3;
  return 2;
}

// ── Resolve owner + project (shared) ──────────────────────────────────────

// Resolve the project based on a selector (from resolveProjectSelector).
// When the selector contains a URI ref, the URI-encoded owner overrides the
// repo-derived owner so cross-scope boards (user vs org) resolve unambiguously.
async function resolveProject(repoOwner, selector, env, child) {
  const projectRef = selector.projectRef;
  const effectiveOwner = projectRef?.kind === "uri" ? projectRef.owner : repoOwner;
  const ownerKind = projectRef?.kind === "uri"
    ? projectRef.ownerKind
    : (await resolveOwner(repoOwner, env, child)).kind;
  const projects = await listAllProjects(effectiveOwner, ownerKind, env, child);
  return findProject(projects, selector, effectiveOwner);
}

function executePosition(projectId, itemId, afterId) {
  return {
    query: UPDATE_ITEM_POSITION,
    variables: afterId
      ? { projectId, itemId, afterId }
      : { projectId, itemId },
  };
}

// ── Legacy flag form: --item [--after] ────────────────────────────────────

async function mainFlagForm(args, { env, child, repo, owner, repoName, project }) {
  const itemRef = parseItemRef(args.item);
  let afterRef = null;
  if (args.after !== undefined) afterRef = parseItemRef(args.after);

  const item = await resolveProjectItem(project.id, itemRef, owner, repoName, repo, env, child);

  let afterItem = null;
  if (afterRef) {
    afterItem = await resolveProjectItem(project.id, afterRef, owner, repoName, repo, env, child);
    if (afterItem.itemId === item.itemId) {
      throw Object.assign(new Error("Cannot reorder an item after itself"), { code: "INVALID_AFTER" });
    }
  }

  const mutation = executePosition(project.id, item.itemId, afterItem ? afterItem.itemId : null);

  if (args.dryRun) {
    // Include the before snapshot for parity with the subcommand dry-run form.
    const before = await snapshotOrder(project.id, repo, item.status ?? null, env, child);
    return {
      ok: true,
      dryRun: true,
      mutations: [mutation],
      before,
    };
  }

  const mutationPayload = await ghGraphql(mutation.query, mutation.variables, env, child);
  if (!mutationPayload?.data?.updateProjectV2ItemPosition) {
    throw Object.assign(new Error("Failed to reorder item"), { code: "MUTATION_FAILED" });
  }

  return {
    ok: true,
    item: {
      itemId: item.itemId,
      issueNumber: item.issueNumber,
      prNumber: item.prNumber,
      status: item.status,
      position: afterItem ? "after" : "top",
    },
    after: afterItem
      ? { itemId: afterItem.itemId, issueNumber: afterItem.issueNumber, prNumber: afterItem.prNumber }
      : null,
  };
}

// ── Subcommand forms: move-to-top / move-after / order ────────────────────

function requirePositionals(subcommand, positional) {
  if (subcommand === "move-to-top") {
    if (positional.length !== 1) {
      throw Object.assign(new Error("move-to-top requires exactly one <ref>"), { code: "INVALID_ARGS", usage: USAGE });
    }
  } else if (subcommand === "move-after") {
    if (positional.length !== 2) {
      throw Object.assign(new Error("move-after requires <ref> <after-ref>"), { code: "INVALID_ARGS", usage: USAGE });
    }
  } else if (subcommand === "order") {
    if (positional.length < 2) {
      throw Object.assign(new Error("order requires at least two <ref> values"), { code: "INVALID_ARGS", usage: USAGE });
    }
  }
}

async function mainSubcommand(args, { env, child, repo, project }) {
  const subcommand = args._subcommand;
  const positional = args._positional ?? [];
  requirePositionals(subcommand, positional);

  // Fetch the board item list ONCE, then resolve every ref (number or id) from
  // that single list — avoids N full-board scans for N refs and enforces the
  // same repo scope for both ref kinds (cross-project refs fail closed).
  const items = await fetchAllItems(project.id, env, child);

  // Resolve all referenced items up-front (fail closed before any mutation).
  const refs = positional.map((p) => parseItemRef(p));
  const resolved = refs.map((ref) => resolveFromItems(items, ref, repo));

  // Reordering positions within a single Status column. The before/after snapshot is scoped
  // to one column, and a cross-column move plan is misleading/invalid — so fail closed unless
  // every resolved ref shares the first ref's Status (multi-ref subcommands only).
  if (resolved.length > 1) {
    const primaryStatus = resolved[0].status ?? null;
    const offender = resolved.find((it) => (it.status ?? null) !== primaryStatus);
    if (offender) {
      throw Object.assign(
        new Error(
          `All reordered items must be in the same Status column as the first item (${primaryStatus ?? "(none)"}); ` +
            `${offender.itemId} is in ${offender.status ?? "(none)"}.`,
        ),
        { code: "MIXED_STATUS" },
      );
    }
  }

  // Build the ordered list of position moves, each { item, afterItem|null }.
  let plan;
  if (subcommand === "move-to-top") {
    plan = [{ item: resolved[0], afterItem: null }];
  } else if (subcommand === "move-after") {
    const [item, afterItem] = resolved;
    if (item.itemId === afterItem.itemId) {
      throw Object.assign(new Error("Cannot reorder an item after itself"), { code: "INVALID_AFTER" });
    }
    plan = [{ item, afterItem }];
  } else {
    // order: ref1 to top, then each subsequent ref after its predecessor.
    plan = resolved.map((item, idx) => ({
      item,
      afterItem: idx === 0 ? null : resolved[idx - 1],
    }));
  }

  const mutations = plan.map((m) => executePosition(project.id, m.item.itemId, m.afterItem ? m.afterItem.itemId : null));

  // Status column for the diff snapshot: use the primary moved item's status.
  // Reuse the already-fetched list for the before-snapshot (no extra fetch).
  const statusFilter = resolved[0].status ?? null;
  const before = snapshotFromItems(items, repo, statusFilter);

  if (args.dryRun) {
    return { ok: true, dryRun: true, mutations, before };
  }

  // NOTE: `order` applies N sequential position mutations and is NOT atomic. A
  // mid-sequence failure leaves the board partially reordered; re-running the
  // same `order` command is idempotent and is the supported recovery path. The
  // thrown error reports how many moves were applied before failing.
  for (let i = 0; i < mutations.length; i++) {
    const mutation = mutations[i];
    let payload;
    try {
      payload = await ghGraphql(mutation.query, mutation.variables, env, child);
    } catch (err) {
      if (subcommand === "order") {
        err.message = `${err.message} (order partially applied: ${i} of ${mutations.length} moves completed; re-run the same order command to recover)`;
        err.appliedMoves = i;
        err.totalMoves = mutations.length;
      }
      throw err;
    }
    if (!payload?.data?.updateProjectV2ItemPosition) {
      const detail = subcommand === "order"
        ? ` (order partially applied: ${i} of ${mutations.length} moves completed; re-run the same order command to recover)`
        : "";
      throw Object.assign(new Error(`Failed to reorder item${detail}`), {
        code: "MUTATION_FAILED",
        ...(subcommand === "order" ? { appliedMoves: i, totalMoves: mutations.length } : {}),
      });
    }
  }

  const after = await snapshotOrder(project.id, repo, statusFilter, env, child);

  const moves = plan.map((m) => ({
    itemId: m.item.itemId,
    issueNumber: m.item.issueNumber,
    prNumber: m.item.prNumber,
    status: m.item.status,
    position: m.afterItem ? "after" : "top",
    afterId: m.afterItem ? m.afterItem.itemId : null,
  }));

  if (subcommand === "order") {
    return { ok: true, moves, before, after };
  }

  // move-to-top / move-after: single move, richer shape.
  const m = plan[0];
  return {
    ok: true,
    item: {
      itemId: m.item.itemId,
      issueNumber: m.item.issueNumber,
      prNumber: m.item.prNumber,
      status: m.item.status,
      position: m.afterItem ? "after" : "top",
    },
    after_ref: m.afterItem
      ? { itemId: m.afterItem.itemId, issueNumber: m.afterItem.issueNumber, prNumber: m.afterItem.prNumber }
      : null,
    before,
    after,
  };
}

// ── Main logic ──────────────────────────────────────────────────────────

async function main(args, { env = process.env, runChild } = {}) {
  const child = runChild ?? _runChild;
  const repo = validateRepo(args.repo);
  const [owner, repoName] = repo.split("/");
  const selector = resolveProjectSelector(args);

  // Fail closed: the legacy flag form takes no positional arguments. A stray
  // token (e.g. `reorder 630 --item ...`) must not be silently ignored.
  if (!args._subcommand && (args._positional?.length ?? 0) > 0) {
    throw Object.assign(
      new Error(`Unexpected argument: ${args._positional[0]}`),
      { code: "INVALID_ARGS", usage: USAGE },
    );
  }

  const project = await resolveProject(owner, selector, env, child);

  if (args._subcommand) {
    return mainSubcommand(args, { env, child, repo, project });
  }
  return mainFlagForm(args, { env, child, repo, owner, repoName, project });
}

// ── CLI entrypoint ──────────────────────────────────────────────────────

async function runCli(argv, { stdout = process.stdout, stderr = process.stderr, env = process.env, cwd = process.cwd() } = {}) {
  let args;
  try {
    args = parseCliArgs(argv);
  } catch (err) {
    stderr.write(`${formatCliError(err)}\n`);
    process.exitCode = 1;
    return;
  }
  if (args.help) {
    stdout.write(USAGE);
    return;
  }

  // Resolve the board from .devloops when --project is absent.
  applyDevloopsBoard(args, cwd);

  try {
    const result = await main(args, { env });
    process.exitCode = emitResult(result, { jq: args.jq, silent: args.silent, stdout, stderr });
  } catch (err) {
    stderr.write(JSON.stringify({ ok: false, error: err.message, code: err.code ?? "UNKNOWN" }) + "\n");
    process.exitCode = classifyExitCode(err);
  }
}

if (isDirectCliRun(import.meta.url)) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(JSON.stringify({ ok: false, error: error.message, code: error.code ?? "UNKNOWN" }) + "\n");
    process.exitCode = 2;
  });
}

export { main };
