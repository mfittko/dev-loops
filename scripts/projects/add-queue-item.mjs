#!/usr/bin/env node
import { formatCliError, isDirectCliRun, parseJsonText } from "../_core-helpers.mjs";
import { runChild as _runChild } from "../_cli-primitives.mjs";
import { resolveProjectSelector, findProject, applyDevloopsBoard } from "./_resolve-project.mjs";
import { parseArgs } from "node:util";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";

const USAGE = `Usage: dev-loops queue add --repo <owner/name> [--project <number|id>] --item <number>
       dev-loops project add … (back-compat alias for "queue add")

Add an existing issue or PR to a GitHub Projects V2 board.

Options:
  --repo <owner/name>         Required. Repository containing the issue/PR.
  --project <number|id>       Project number (integer) or node ID. When omitted,
                              resolved from .devloops queue.projectNumber /
                              queue.boardTitle.
  --item <number>             Required. Issue or PR number to add.
  --column <name>             Initial Status column (default: "Backlog").
  --status <name>             Back-compat alias for --column.
  --next-up                   Land the item directly in the "Next Up" column
                              (the normative pickup queue). Sugar for
                              --column "Next Up"; cannot be combined with a
                              conflicting --column/--status.
  --help, -h                  Show this help.

Output (stdout):
  JSON: { ok: true, item: { itemId, issueNumber, prNumber, status, alreadyPresent } }

${JQ_OUTPUT_USAGE}

Exit codes:
  0 — success (or no-op when already present)
  1 — usage or argument error
  2 — GitHub API error / invalid --jq filter
  3 — project, field, column, or issue/PR not found
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
      column: { type: "string" },
      status: { type: "string" },
      "next-up": { type: "boolean" },
      help: { type: "boolean", short: "h" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });

  for (const token of tokens) {
    if (token.kind === "positional") {
      throw Object.assign(new Error(`Unexpected argument: ${token.value}`), { code: "INVALID_ARGS", usage: USAGE });
    }
    if (token.kind !== "option") {
      continue;
    }
    switch (token.name) {
      case "help":
        if (token.value !== undefined) {
          throw Object.assign(new Error(`Unknown flag: ${token.rawName}=${token.value}`), { code: "INVALID_ARGS", usage: USAGE });
        }
        args.help = true;
        break;
      case "repo":
        args.repo = requireValue(token, "--repo requires a value (owner/name)");
        break;
      case "project":
        args.project = requireValue(token, "--project requires a value (number or node ID)");
        break;
      case "item": {
        const raw = requireValue(token, "--item requires a value (number)");
        const val = Number(raw);
        if (!Number.isInteger(val) || val < 1) {
          throw Object.assign(
            new Error(`--item must be a positive integer, got "${raw}"`),
            { code: "INVALID_ITEM" },
          );
        }
        args.item = val;
        break;
      }
      case "column":
        args.column = requireValue(token, "--column requires a value");
        break;
      case "status":
        // Back-compat alias for --column (issue #912). Kept separate so a
        // conflicting `--column X --status Y` is rejected rather than silently
        // resolved by argv order.
        args.status = requireValue(token, "--status requires a value");
        break;
      case "next-up":
        if (token.value !== undefined) {
          throw Object.assign(new Error(`Unknown flag: ${token.rawName}=${token.value}`), { code: "INVALID_ARGS", usage: USAGE });
        }
        args.nextUp = true;
        break;
      default: {
        if (matchJqOutputToken(token, args, (t) => requireValue(t, "--jq requires a filter"))) break;
        throw Object.assign(new Error(`Unknown flag: ${token.rawName}`), { code: "INVALID_ARGS", usage: USAGE });
      }
    }
  }
  return args;
}

// ── Validation ───────────────────────────────────────────────────────────

const OWNER_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/;
const REPO_NAME_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9_.-]*[a-zA-Z0-9])?$/;

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

// ── API helpers ──────────────────────────────────────────────────────────

async function ghGraphql(query, vars, env, runChild = _runChild, { allowErrors = false } = {}) {
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
  if (!allowErrors && payload.errors && payload.errors.length > 0) {
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

// Resolve an issue or PR's GraphQL node ID by number
const RESOLVE_CONTENT_NODE_ID = [
  "query($owner:String!, $repo:String!, $number:Int!) {",
  "  repository(owner:$owner, name:$repo) {",
  "    issueOrPullRequest(number:$number) {",
  "      ... on Issue { id __typename }",
  "      ... on PullRequest { id __typename }",
  "    }",
  "  }",
  "}"
].join("\n");

const ADD_PROJECT_ITEM = [
  "mutation($projectId:ID!, $contentId:ID!) {",
  "  addProjectV2ItemById(input:{projectId:$projectId, contentId:$contentId}) {",
  "    item {",
  "      id",
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

// Check if an item already exists in the project by content ID
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
      err.code === "INVALID_STATUS" || err.code === "INVALID_ARGS") return 1;
  if (err.code === "PROJECT_NOT_FOUND" || err.code === "FIELD_NOT_FOUND" || err.code === "COLUMN_NOT_FOUND" ||
      err.code === "ITEM_NOT_FOUND" || err.code === "CONTENT_NOT_FOUND") return 3;
  return 2;
}

// ── Main logic ──────────────────────────────────────────────────────────

async function main(args, { env = process.env, runChild } = {}) {
  const child = runChild ?? _runChild;
  const repo = validateRepo(args.repo);
  const [owner, repoName] = repo.split("/");
  const selector = resolveProjectSelector(args);
  const itemNumber = args.item;
  if (!Number.isInteger(itemNumber) || itemNumber < 1) {
    throw Object.assign(new Error("--item is required and must be a positive integer"), { code: "INVALID_ITEM" });
  }
  if (args.column != null && args.status != null && args.column.trim() !== args.status.trim()) {
    throw Object.assign(
      new Error(`Conflicting --column ("${args.column}") and --status ("${args.status}") — pass only one (prefer --column).`),
      { code: "INVALID_ARGS", usage: USAGE },
    );
  }
  // --next-up is sugar for --column "Next Up" (the normative pickup queue, #1091).
  // Reject combining it with a conflicting explicit column/status.
  const explicitColumn = args.column ?? args.status ?? null;
  if (args.nextUp && explicitColumn != null && explicitColumn.trim() !== "Next Up") {
    throw Object.assign(
      new Error(`Conflicting --next-up and --column/--status ("${explicitColumn}") — pass only one.`),
      { code: "INVALID_ARGS", usage: USAGE },
    );
  }
  const targetStatus = (args.nextUp ? "Next Up" : (explicitColumn ?? "Backlog")).trim();
  if (!targetStatus) {
    throw Object.assign(new Error("--column must not be empty"), { code: "INVALID_STATUS" });
  }

  // 1. Resolve owner
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

  const targetOption = statusField.options.find((o) => o.name === targetStatus);
  if (!targetOption) {
    const available = statusField.options.map((o) => o.name).join(", ");
    throw Object.assign(
      new Error(`Column "${targetStatus}" not found in Status field. Available: ${available}`),
      { code: "COLUMN_NOT_FOUND" },
    );
  }

  // 4. Check if item already exists in the project
  const existingItemsPayload = await ghGraphql(GET_PROJECT_ITEMS_BY_CONTENT, {
    projectId: project.id,
  }, env, child);
  const existingItems = existingItemsPayload?.data?.node?.items?.nodes ?? [];

  const alreadyPresent = existingItems.filter((it) => {
    if (!it.content) return false;
    return it.content.repository?.nameWithOwner === repo && it.content.number === itemNumber;
  });

  if (alreadyPresent.length > 0) {
    const existing = alreadyPresent[0];
    let existingStatus = null;
    const fvs = existing.fieldValues?.nodes ?? [];
    for (const fv of fvs) {
      if (fv && fv.field && fv.field.name === "Status") {
        existingStatus = fv.name;
        break;
      }
    }
    let issueNumber = null;
    let prNumber = null;
    if (existing.content) {
      if (existing.content.__typename === "Issue") issueNumber = existing.content.number;
      else prNumber = existing.content.number;
    }
    return {
      ok: true,
      item: {
        itemId: existing.id,
        issueNumber,
        prNumber,
        status: existingStatus,
        alreadyPresent: true,
      },
    };
  }

  // 5. Resolve content node ID (issue or PR)
  const contentPayload = await ghGraphql(RESOLVE_CONTENT_NODE_ID, {
    owner,
    repo: repoName,
    number: itemNumber,
  }, env, child, { allowErrors: true });
  const repoData = contentPayload?.data?.repository;
  const fullResult = repoData?.issueOrPullRequest;
  if (!fullResult) {
    throw Object.assign(
      new Error(`Issue or PR #${itemNumber} not found in "${repo}"`),
      { code: "CONTENT_NOT_FOUND" },
    );
  }

  let contentId = fullResult.id;
  let issueNumber = fullResult.__typename === "Issue" ? itemNumber : null;
  let prNumber = fullResult.__typename === "PullRequest" ? itemNumber : null;

  // 6. Add item to project
  const addPayload = await ghGraphql(ADD_PROJECT_ITEM, {
    projectId: project.id,
    contentId,
  }, env, child);

  const newItem = addPayload?.data?.addProjectV2ItemById?.item;
  if (!newItem) {
    throw Object.assign(new Error("Failed to add item to project"), { code: "MUTATION_FAILED" });
  }

  // 7. Set initial Status
  const updatePayload = await ghGraphql(UPDATE_ITEM_FIELD, {
    projectId: project.id,
    itemId: newItem.id,
    fieldId: statusField.id,
    optionId: targetOption.id,
  }, env, child);

  const updated = updatePayload?.data?.updateProjectV2ItemFieldValue?.projectV2Item;
  if (!updated) {
    throw Object.assign(new Error("Failed to set initial Status on new item"), { code: "MUTATION_FAILED" });
  }

  return {
    ok: true,
    item: {
      itemId: newItem.id,
      issueNumber,
      prNumber,
      status: targetStatus,
      alreadyPresent: false,
    },
  };
}

// ── CLI entrypoint ──────────────────────────────────────────────────────

async function runCli(argv, { stdout = process.stdout, stderr = process.stderr, env = process.env, cwd = process.cwd(), runChild } = {}) {
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
    const result = await main(args, { env, runChild });
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

export { main, parseCliArgs, runCli };
