#!/usr/bin/env node
import { formatCliError, isDirectCliRun, parseJsonText } from "../_core-helpers.mjs";
import { runChild as _runChild } from "../_cli-primitives.mjs";
import { parseArgs } from "node:util";

const USAGE = `Usage: dev-loops project move --repo <owner/name> --project <number|id> --item <number|node-id> --to-column <name>

Move a GitHub Projects V2 item between Status columns.

Options:
  --repo <owner/name>         Required. Repository to scope the project search.
  --project <number|id>       Required. Project number (integer) or node ID.
  --item <number|node-id>     Required. Item to move: issue/PR number, or project item node ID.
  --to-column <name>          Required. Target Status column (e.g. "Next Up", "In Progress").
  --help, -h                  Show this help.

Output (stdout):
  JSON: { ok: true, item: { itemId, issueNumber, prNumber, previousColumn, newColumn } }

Exit codes:
  0 — success
  1 — usage or argument error
  2 — GitHub API error
  3 — project, field, column, or item not found
`.trim();

function parseCliArgs(argv) {
  const parseError = (message) => Object.assign(new Error(message), { usage: USAGE });
  const requireValue = (token, message) => {
    const v = token.value;
    if (typeof v !== "string" || v.length === 0 || v.startsWith("-")) {
      throw parseError(message);
    }
    return v;
  };

  const args = {};
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      repo: { type: "string" },
      project: { type: "string" },
      item: { type: "string" },
      "to-column": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });

  for (const token of tokens) {
    if (token.kind === "positional") {
      throw parseError(`Unexpected argument: ${token.value}`);
    }
    if (token.kind !== "option") {
      continue;
    }
    switch (token.name) {
      case "help":
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
      case "to-column":
        args.toColumn = requireValue(token, "--to-column requires a value");
        break;
      default:
        throw parseError(`Unknown flag: ${token.rawName}`);
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

function parseProjectRef(raw) {
  if (!raw || typeof raw !== "string" || raw.trim().length === 0) {
    throw Object.assign(new Error("--project is required"), { code: "INVALID_PROJECT" });
  }
  const trimmed = raw.trim();
  const asNum = Number(trimmed);
  if (Number.isInteger(asNum) && asNum > 0 && String(asNum) === trimmed) {
    return { kind: "number", value: asNum };
  }
  if (trimmed === "0") {
    throw Object.assign(new Error(`--project must be a positive integer or a node ID, got "${raw}"`), { code: "INVALID_PROJECT" });
  }
  if (GLOBAL_NODE_ID_RE.test(trimmed)) {
    return { kind: "id", value: trimmed };
  }
  throw Object.assign(new Error(`--project must be a positive integer or a node ID, got "${raw}"`), { code: "INVALID_PROJECT" });
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
  "            ... on Issue { number repository { nameWithOwner } }",
  "            ... on PullRequest { number repository { nameWithOwner } }",
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
  "          ... on Issue { number title url }",
  "          ... on PullRequest { number title url }",
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

// ── Exit code classification ────────────────────────────────────────────

function classifyExitCode(err) {
  if (err.code === "INVALID_REPO" || err.code === "INVALID_PROJECT" || err.code === "INVALID_ITEM" ||
      err.code === "INVALID_COLUMN" || err.code === "INVALID_ARGS") return 1;
  if (err.code === "PROJECT_NOT_FOUND" || err.code === "FIELD_NOT_FOUND" || err.code === "COLUMN_NOT_FOUND" ||
      err.code === "ITEM_NOT_FOUND") return 3;
  return 2;
}

// ── Main logic ──────────────────────────────────────────────────────────

async function main(args, { env = process.env, runChild } = {}) {
  const child = runChild ?? _runChild;
  const repo = validateRepo(args.repo);
  const [owner, repoName] = repo.split("/");
  const projectRef = parseProjectRef(args.project);
  const itemRef = parseItemRef(args.item);
  const toColumn = (args.toColumn ?? "").trim();
  if (!toColumn) {
    throw Object.assign(new Error("--to-column is required"), { code: "INVALID_COLUMN" });
  }

  // 1. Resolve owner
  const { id: ownerId, kind: ownerKind } = await resolveOwner(owner, env, child);

  // 2. Resolve project
  const projects = await listAllProjects(owner, ownerKind, env, child);
  let project;
  if (projectRef.kind === "id") {
    project = projects.find((p) => p.id === projectRef.value);
  } else {
    project = projects.find((p) => p.number === projectRef.value);
  }
  if (!project) {
    throw Object.assign(
      new Error(`Project ${projectRef.kind === "id" ? `"${projectRef.value}"` : `number ${projectRef.value}`} not found under owner "${owner}"`),
      { code: "PROJECT_NOT_FOUND" },
    );
  }

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

  // 4. Find the item
  let itemId;
  let previousColumn = null;
  let issueNumber = null;
  let prNumber = null;

  if (itemRef.kind === "id") {
    // Direct item node ID lookup
    const itemPayload = await ghGraphql(GET_PROJECT_ITEM, {
      projectId: project.id,
      itemId: itemRef.value,
    }, env, child);
    const item = itemPayload?.data?.node?.item;
    if (!item) {
      throw Object.assign(
        new Error(`Item "${itemRef.value}" not found in project "${project.title}"`),
        { code: "ITEM_NOT_FOUND" },
      );
    }
    itemId = item.id;
    const fvs = item.fieldValues?.nodes ?? [];
    for (const fv of fvs) {
      if (fv && fv.field && fv.field.name === "Status") {
        previousColumn = fv.name;
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
    // Look up by issue/PR number in the project
    const itemsPayload = await ghGraphql(GET_PROJECT_ITEMS_BY_CONTENT, {
      projectId: project.id,
    }, env, child);
    const items = itemsPayload?.data?.node?.items?.nodes ?? [];

    // Filter by matching repo exactly and item number (when known)
    const matchingItems = items.filter((it) => {
      if (!it.content) return false;
      const repoMatch = it.content.repository?.nameWithOwner === repo;
      if (itemRef.kind === "number") {
        return repoMatch && it.content.number === itemRef.value;
      }
      return repoMatch;
    });

    if (matchingItems.length === 0) {
      throw Object.assign(
        new Error(`Item #${itemRef.value} not found in project "${project.title}" for repo "${repo}"`),
        { code: "ITEM_NOT_FOUND" },
      );
    }

    // Use the first match (by position order)
    const match = matchingItems[0];
    itemId = match.id;
    const fvs = match.fieldValues?.nodes ?? [];
    for (const fv of fvs) {
      if (fv && fv.field && fv.field.name === "Status") {
        previousColumn = fv.name;
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
  };
}

// ── CLI entrypoint ──────────────────────────────────────────────────────

async function runCli(argv, { stdout = process.stdout, stderr = process.stderr, env = process.env } = {}) {
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
  try {
    const result = await main(args, { env });
    stdout.write(JSON.stringify(result) + "\n");
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
