#!/usr/bin/env node
import { formatCliError, isDirectCliRun, parseJsonText } from "../_core-helpers.mjs";
import { runChild as _runChild } from "../_cli-primitives.mjs";
import { resolveProjectSelector, findProject, applyDevloopsBoard } from "./_resolve-project.mjs";
import { parseArgs } from "node:util";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";

const USAGE = `Usage: dev-loops queue list --repo <owner/name> [--project <number|id>] [--column <name>] [--limit <n>]
       dev-loops queue list --repo <owner/name> [--project <number|id>] --summary [--done-limit <n>]
       (dev-loops project list … is a back-compat alias)

List GitHub Projects V2 items filtered by Status column, ordered by position
ascending. Returns machine-readable JSON.

Options:
  --repo <owner/name>     Required. Repository to scope the project search.
  --project <number|id>   Project number (integer) or node ID. When omitted,
                          resolved from .devloops queue.projectNumber /
                          queue.boardTitle.
  --column <name>         Filter items by Status column value (e.g. "Next Up").
  --limit <n>             Return at most <n> items (flat mode only).
  --summary               Whole-board digest grouped by Status column, in board
                          column order. Emits { ok, groups: { <status>: { count, items } } }.
  --group-by status       Alias for --summary. Only "status" is supported.
  --done-limit <n>        With --summary: cap the "Done" group's items array to
                          <n> (or the last/terminal board column if no column is
                          named "Done"). Count stays the true total; use 0 for
                          counts only.
  --help, -h              Show this help.

Grouping / aggregation is done via --summary (this mode). Do NOT pipe flat
output through inline parsers (e.g. \`| python3\`) or reduce/group_by jq filters
to build a per-status digest — the summary mode is the sanctioned one-call path.

--summary is mutually exclusive with --column and --limit (both exit 1).

Output (stdout):
  flat:    { ok: true, items: [{ issueNumber, prNumber, title, url, itemId, contentId, status }, ...] }
  summary: { ok: true, groups: { "<Status>": { count, items: [ <item>, ... ] }, ... } }

${JQ_OUTPUT_USAGE}

Exit codes:
  0 — success
  1 — usage or argument error
  2 — GitHub API error / invalid --jq filter
  3 — project, field, or column not found
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
      column: { type: "string" },
      limit: { type: "string" },
      summary: { type: "boolean" },
      "group-by": { type: "string" },
      "done-limit": { type: "string" },
      help: { type: "boolean", short: "h" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
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
      case "column":
        args.column = requireValue(token, "--column requires a value");
        break;
      case "limit": {
        const raw = requireValue(token, "--limit requires a positive integer");
        const val = Number(raw);
        if (!Number.isInteger(val) || val < 1) {
          throw parseError(`--limit must be a positive integer, got "${raw}"`);
        }
        args.limit = val;
        break;
      }
      case "summary":
        if (token.value !== undefined) {
          throw parseError(`Unknown flag: ${token.rawName}=${token.value}`);
        }
        args.summary = true;
        break;
      case "group-by": {
        const val = requireValue(token, "--group-by requires a value (only \"status\" is supported)");
        if (val !== "status") {
          throw parseError(`--group-by only supports "status", got "${val}"`);
        }
        args.summary = true;
        break;
      }
      case "done-limit": {
        const raw = requireValue(token, "--done-limit requires a non-negative integer");
        const val = Number(raw);
        if (!Number.isInteger(val) || val < 0) {
          throw parseError(`--done-limit must be a non-negative integer, got "${raw}"`);
        }
        args.doneLimit = val;
        break;
      }
      case "jq":
        args.jq = requireValue(token, "--jq requires a filter");
        break;
      case "silent":
        args.silent = true;
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

const GET_PROJECT_ITEMS = [
  "query($projectId:ID!, $after:String) {",
  "  node(id:$projectId) {",
  "    ... on ProjectV2 {",
  "      items(first:100, after:$after) {",
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
  "            ... on Issue { number title url id }",
  "            ... on PullRequest { number title url id }",
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

// ── Paginated item listing ───────────────────────────────────────────────

async function listAllItems(projectId, env, runChild) {
  const items = [];
  let after = null;
  while (true) {
    const vars = { projectId };
    if (after) vars.after = after;
    const payload = await ghGraphql(GET_PROJECT_ITEMS, vars, env, runChild);
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

// ── Exit code classification ────────────────────────────────────────────

function classifyExitCode(err) {
  if (err.code === "INVALID_REPO" || err.code === "INVALID_PROJECT" || err.code === "INVALID_ARGS") return 1;
  if (err.code === "PROJECT_NOT_FOUND" || err.code === "FIELD_NOT_FOUND" || err.code === "COLUMN_NOT_FOUND") return 3;
  return 2;
}

// ── Main logic ──────────────────────────────────────────────────────────

async function main(args, { env = process.env, runChild } = {}) {
  const child = runChild ?? _runChild;
  const repo = validateRepo(args.repo);
  const [owner] = repo.split("/");
  const selector = resolveProjectSelector(args);

  // Mutual exclusion: --summary is the whole-board grouped view; --column/--limit
  // are flat-mode knobs. Combining them is ambiguous.
  if (args.summary && args.column) {
    throw Object.assign(
      new Error("--summary and --column are mutually exclusive (--column filters to one status; --summary groups the whole board)"),
      { code: "INVALID_ARGS" },
    );
  }
  if (args.summary && args.limit) {
    throw Object.assign(
      new Error("--summary and --limit are mutually exclusive; use --done-limit to cap the Done group (or terminal column if no Done column exists)"),
      { code: "INVALID_ARGS" },
    );
  }
  if (args.doneLimit !== undefined && !args.summary) {
    throw Object.assign(
      new Error("--done-limit only applies with --summary"),
      { code: "INVALID_ARGS" },
    );
  }

  // 1. Resolve owner (user or org)
  const { id: ownerId, kind: ownerKind } = await resolveOwner(owner, env, child);

  // 2. Resolve project
  const projects = await listAllProjects(owner, ownerKind, env, child);
  const project = findProject(projects, selector, owner);

  // 3. Resolve Status field and target column
  const fieldNodes = await listAllFields(project.id, env, child);
  const statusField = fieldNodes.find((f) => f.name === "Status" && f.options);
  if (!statusField) {
    throw Object.assign(
      new Error(`Status field not found in project "${project.title}" (number ${project.number})`),
      { code: "FIELD_NOT_FOUND" },
    );
  }

  let targetOption = null;
  if (args.column) {
    targetOption = statusField.options.find(
      (o) => o.name === args.column,
    );
    if (!targetOption) {
      const available = statusField.options.map((o) => o.name).join(", ");
      throw Object.assign(
        new Error(
          `Column "${args.column}" not found in Status field. Available: ${available}`,
        ),
        { code: "COLUMN_NOT_FOUND" },
      );
    }
  }

  // 4. List and filter items (ordered by position ascending, GraphQL default)
  const rawItems = await listAllItems(project.id, env, child);

  const results = [];
  for (const item of rawItems) {
    const content = item.content;
    if (!content) continue;

    // Determine status from field values
    let status = null;
    const fieldValues = item.fieldValues?.nodes ?? [];
    for (const fv of fieldValues) {
      if (fv && fv.field && fv.field.name === "Status") {
        status = fv.name;
        break;
      }
    }

    // Filter by column
    if (args.column && status !== args.column) continue;

    const isPr = content.__typename === "PullRequest";

    results.push({
      issueNumber: isPr ? null : content.number,
      prNumber: isPr ? content.number : null,
      title: content.title ?? null,
      url: content.url ?? null,
      itemId: item.id,
      contentId: content.id ?? null,
      status: status ?? null,
    });
  }

  // 5a. Summary mode: group by Status column in board option order.
  if (args.summary) {
    // Object.create(null): board option names are free text, so a column named
    // "__proto__"/"constructor" must be an own key, not touch Object.prototype.
    const groups = Object.create(null);
    for (const option of statusField.options) {
      groups[option.name] = { count: 0, items: [] };
    }
    for (const r of results) {
      // Items with null status belong to no Status option, so they are excluded here — matches --column filtering behavior.
      if (r.status === null) continue;
      const group = groups[r.status];
      if (!group) continue; // status value not among current board options
      group.count += 1;
      group.items.push(r);
    }
    if (args.doneLimit !== undefined) {
      // Cap "Done" per the issue AC; if no column is literally named "Done",
      // fall back to the last board option (conventionally the terminal column)
      // so --done-limit is honest instead of a silent no-op.
      const doneGroup = groups.Done ?? groups[statusField.options.at(-1)?.name];
      if (doneGroup) {
        doneGroup.items = doneGroup.items.slice(0, args.doneLimit);
      }
    }
    return { ok: true, groups };
  }

  // 5b. Flat mode: items are returned in position order from GraphQL. Apply limit.
  const limited = args.limit ? results.slice(0, args.limit) : results;

  return {
    ok: true,
    items: limited,
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
