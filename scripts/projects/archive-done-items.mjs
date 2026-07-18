#!/usr/bin/env node
import { formatCliError, isDirectCliRun, parseJsonText } from "../_core-helpers.mjs";
import { runChild as _runChild } from "../_cli-primitives.mjs";
import { resolveSettings, parseProjectRef, findProject } from "./_resolve-project.mjs";
import { parseArgs } from "node:util";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
import { loadStateColumnMap, LOGICAL_COLUMN } from "@dev-loops/core/loop/queue-board-sync";

const USAGE = `Usage: dev-loops queue archive-done --repo <owner/name> [--project <number|id|board-uri>] [--older-than <duration>] [--dry-run]
       (dev-loops project archive-done … is a back-compat alias)

Archive GitHub Projects V2 items whose issue/PR has been closed for at least the
given duration. Operator-triggered (no webhooks). Uses archiveProjectV2Item.

Options:
  --repo <owner/name>                 Required. Repository to scope the project search.
  --project <number|id|board-uri>     Project number, node ID, or board URI
                                      (e.g. https://github.com/users/me/projects/3).
                                      When omitted, resolved from .devloops
                                      queue.board.number / queue.board.title.
  --older-than <duration>             Closed-for threshold. Format: <n><unit> where unit is
                                      h (hours), d (days), or w (weeks). Default resolves
                                      from .devloops queue.archiveOlderThanDays, else 7d.
  --dry-run                           Print the intended archive mutation(s) without executing.
  --help, -h                          Show this help.

Output (stdout):
  JSON: { ok: true, olderThan, scanned, archivable, archived: [{ itemId, issueNumber, prNumber, closedAt }] }
  dry-run: { ok: true, dryRun: true, olderThan, scanned, archivable, mutations: [{ query, variables }] }
  (scanned = all repo board items; archivable = items selected for archival)

${JQ_OUTPUT_USAGE}

Exit codes:
  0 — success
  1 — usage or argument error
  2 — GitHub API error / invalid --jq filter
  3 — project not found
`.trim();

function parseCliArgs(argv) {
  const requireValue = (token, message, code) => {
    const v = token.value;
    if (typeof v !== "string" || v.length === 0 || v.startsWith("-")) {
      throw Object.assign(new Error(message), { code });
    }
    return v;
  };

  const args = {};
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      repo: { type: "string" },
      project: { type: "string" },
      "older-than": { type: "string" },
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
        args.repo = requireValue(token, "--repo requires a value (owner/name)", "INVALID_REPO");
        break;
      case "project":
        args.project = requireValue(token, "--project requires a value (number or node ID)", "INVALID_PROJECT");
        break;
      case "older-than":
        args.olderThan = requireValue(token, "--older-than requires a value (e.g. 30d)", "INVALID_DURATION");
        break;
      case "dry-run":
        if (token.value !== undefined) {
          throw Object.assign(new Error(`Unknown flag: ${token.rawName}=${token.value}`), { code: "INVALID_ARGS", usage: USAGE });
        }
        args.dryRun = true;
        break;
      default: {
        if (matchJqOutputToken(token, args, (t) => requireValue(t, "--jq requires a filter", "INVALID_ARGS"))) break;
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

const DURATION_RE = /^(\d+)(h|d|w)$/;
const UNIT_MS = {
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
};

function parseDuration(raw) {
  if (!raw || typeof raw !== "string") {
    throw Object.assign(new Error(`--older-than must be <n>(h|d|w), got "${raw}"`), { code: "INVALID_DURATION" });
  }
  const m = DURATION_RE.exec(raw.trim());
  if (!m) {
    throw Object.assign(new Error(`--older-than must be <n>(h|d|w), got "${raw}"`), { code: "INVALID_DURATION" });
  }
  const n = Number(m[1]);
  if (!Number.isInteger(n) || n <= 0) {
    throw Object.assign(new Error(`--older-than must be a positive amount, got "${raw}"`), { code: "INVALID_DURATION" });
  }
  return n * UNIT_MS[m[2]];
}

// ── API helpers ──────────────────────────────────────────────────────────

async function ghGraphql(query, vars, env, runChild = _runChild) {
  const fieldArgs = [];
  for (const [key, value] of Object.entries(vars)) {
    fieldArgs.push("--field", `${key}=${value}`);
  }
  const result = await runChild("gh", ["api", "graphql", "--field", `query=${query}`, ...fieldArgs], env);
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

const GET_USER_ID = ["query($login:String!) {", "  user(login:$login) { id }", "}"].join("\n");
const GET_ORG_ID = ["query($login:String!) {", "  organization(login:$login) { id }", "}"].join("\n");

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

const GET_PROJECT_ITEMS = [
  "query($projectId:ID!, $after:String) {",
  "  node(id:$projectId) {",
  "    ... on ProjectV2 {",
  "      items(first:50, after:$after, orderBy:{field:POSITION, direction:ASC}) {",
  "        pageInfo { hasNextPage endCursor }",
  "        nodes {",
  "          id",
  "          isArchived",
  "          fieldValues(first:20) {",
  "            nodes {",
  "              ... on ProjectV2ItemFieldSingleSelectValue {",
  "                field { ... on ProjectV2SingleSelectField { id name } }",
  "                name",
  "              }",
  "            }",
  "          }",
  "          content {",
  "            ... on Issue { __typename number closed closedAt repository { nameWithOwner } }",
  "            ... on PullRequest { __typename number closed closedAt repository { nameWithOwner } }",
  "          }",
  "        }",
  "      }",
  "    }",
  "  }",
  "}",
].join("\n");

const ARCHIVE_ITEM = [
  "mutation($projectId:ID!, $itemId:ID!) {",
  "  archiveProjectV2Item(input:{projectId:$projectId, itemId:$itemId}) {",
  "    item { id }",
  "  }",
  "}",
].join("\n");

// ── Owner / project resolution ─────────────────────────────────────────────

async function resolveOwner(login, env, runChild) {
  const userPayload = await ghGraphql(GET_USER_ID, { login }, env, runChild);
  if (userPayload?.data?.user?.id) return { id: userPayload.data.user.id, kind: "user" };
  const orgPayload = await ghGraphql(GET_ORG_ID, { login }, env, runChild);
  if (orgPayload?.data?.organization?.id) return { id: orgPayload.data.organization.id, kind: "org" };
  throw Object.assign(new Error(`Could not resolve owner ID for "${login}"`), { code: "NO_USER_ID" });
}

async function listAllProjects(login, kind, env, runChild) {
  const query = kind === "org" ? LIST_ORG_PROJECTS : LIST_USER_PROJECTS;
  const projects = [];
  let after = null;
  while (true) {
    const vars = { login };
    if (after) vars.after = after;
    const payload = await ghGraphql(query, vars, env, runChild);
    const connection = kind === "org" ? payload?.data?.organization?.projectsV2 : payload?.data?.user?.projectsV2;
    const nodes = connection?.nodes ?? [];
    projects.push(...nodes);
    const pageInfo = connection?.pageInfo ?? {};
    if (!pageInfo.hasNextPage) break;
    if (!pageInfo.endCursor) {
      throw Object.assign(new Error("Invalid projects list payload: hasNextPage true but endCursor missing"), { code: "GH_API_ERROR" });
    }
    after = pageInfo.endCursor;
  }
  return projects;
}

async function fetchAllItems(projectId, env, runChild) {
  const all = [];
  let after = null;
  while (true) {
    const vars = { projectId };
    if (after) vars.after = after;
    const payload = await ghGraphql(GET_PROJECT_ITEMS, vars, env, runChild);
    const connection = payload?.data?.node?.items;
    const nodes = connection?.nodes ?? [];
    all.push(...nodes);
    const pageInfo = connection?.pageInfo ?? {};
    if (!pageInfo.hasNextPage) break;
    if (!pageInfo.endCursor) {
      throw Object.assign(new Error("Invalid items payload: hasNextPage true but endCursor missing"), { code: "GH_API_ERROR" });
    }
    after = pageInfo.endCursor;
  }
  return all;
}

function statusOf(node) {
  const fvs = node?.fieldValues?.nodes ?? [];
  for (const fv of fvs) {
    if (fv && fv.field && fv.field.name === "Status") return fv.name;
  }
  return null;
}

// Normalize a raw GraphQL item node into the shape selectArchivable expects.
function normalizeItem(node) {
  return {
    id: node.id,
    isArchived: Boolean(node.isArchived),
    status: statusOf(node),
    content: node.content
      ? {
          __typename: node.content.__typename,
          number: node.content.number,
          closed: Boolean(node.content.closed),
          closedAt: node.content.closedAt ?? null,
          repository: node.content.repository,
        }
      : null,
  };
}

// ── Selection logic (pure) ────────────────────────────────────────────────

// Select items whose issue/PR is closed and has been closed for >= olderThanMs.
// `doneColumn` defaults to the literal "Done" for direct/pure-unit callers;
// main() always passes the configured column name (#1098, #1143).
function selectArchivable(items, { now, olderThanMs, doneColumn = "Done" }) {
  return items.filter((it) => {
    if (it.isArchived) return false;
    // Only archive items in the Done column — a closed issue/PR parked in
    // another column (Backlog/Next Up/In Progress) must be left untouched.
    if (it.status !== doneColumn) return false;
    const c = it.content;
    if (!c || !c.closed || !c.closedAt) return false;
    const closedAtMs = Date.parse(c.closedAt);
    if (Number.isNaN(closedAtMs)) return false;
    return now - closedAtMs >= olderThanMs;
  });
}

// ── Exit code classification ────────────────────────────────────────────

function classifyExitCode(err) {
  if (err.code === "INVALID_REPO" || err.code === "INVALID_PROJECT" ||
      err.code === "INVALID_DURATION" || err.code === "INVALID_ARGS") return 1;
  if (err.code === "PROJECT_NOT_FOUND") return 3;
  return 2;
}

// ── Main logic ──────────────────────────────────────────────────────────

async function main(args, { env = process.env, runChild, cwd = process.cwd() } = {}) {
  const child = runChild ?? _runChild;
  const repo = validateRepo(args.repo);
  // Resolve the done column name through the SAME statusColumns mapping
  // board-sync uses (#1098, #1143): a repo that renamed Done gets its
  // configured column matched here, not the literal default. Fail CLOSED on a
  // malformed `.devloops` — never silently archive against the literal "Done"
  // and risk archiving nothing on a renamed/stale column.
  const { columnNames, error: configError } = loadStateColumnMap(cwd);
  if (configError) {
    throw Object.assign(
      new Error(`could not resolve done column (config read/parse error: ${configError})`),
      { code: "CONFIG_ERROR" },
    );
  }
  const doneColumn = columnNames[LOGICAL_COLUMN.DONE];
  const [owner] = repo.split("/");
  // Board: explicit --project ref wins; otherwise resolve by board title from
  // .devloops (passed in as args.projectTitle by runCli). Fail closed if neither.
  const hasProjectRef = typeof args.project === "string" && args.project.trim().length > 0;
  const projectRef = hasProjectRef ? parseProjectRef(args.project) : null;
  const projectTitle = !hasProjectRef && typeof args.projectTitle === "string" && args.projectTitle.trim().length > 0
    ? args.projectTitle.trim()
    : null;
  if (!projectRef && !projectTitle) {
    throw Object.assign(
      new Error("--project is required (or configure queue.board.number / queue.board.title in .devloops)"),
      { code: "INVALID_PROJECT" },
    );
  }
  const olderThanRaw = args.olderThan ?? args.olderThanDefault ?? "7d";
  const olderThanMs = parseDuration(olderThanRaw);
  const now = args.now ?? Date.now();

  // URI refs encode owner+kind directly; skip the API round-trip for owner resolution.
  const projectOwner = projectRef?.kind === "uri" ? projectRef.owner : owner;
  const ownerKind = projectRef?.kind === "uri"
    ? projectRef.ownerKind
    : (await resolveOwner(owner, env, child)).kind;
  const projects = await listAllProjects(projectOwner, ownerKind, env, child);
  const project = findProject(projects, { projectRef, projectTitle }, projectOwner);

  const rawItems = await fetchAllItems(project.id, env, child);
  // Only consider items whose content belongs to the target repo (single-repo scope).
  const repoItems = rawItems
    .filter((n) => n.content && n.content.repository?.nameWithOwner === repo)
    .map(normalizeItem);

  const archivable = selectArchivable(repoItems, { now, olderThanMs, doneColumn });

  const mutations = archivable.map((it) => ({
    query: ARCHIVE_ITEM,
    variables: { projectId: project.id, itemId: it.id },
  }));

  if (args.dryRun) {
    return {
      ok: true,
      dryRun: true,
      olderThan: olderThanRaw,
      scanned: repoItems.length,
      archivable: archivable.length,
      mutations,
    };
  }

  const archived = [];
  for (const it of archivable) {
    const payload = await ghGraphql(ARCHIVE_ITEM, { projectId: project.id, itemId: it.id }, env, child);
    if (!payload?.data?.archiveProjectV2Item?.item) {
      throw Object.assign(new Error(`Failed to archive item ${it.id}`), { code: "MUTATION_FAILED" });
    }
    archived.push({
      itemId: it.id,
      issueNumber: it.content.__typename === "Issue" ? it.content.number : null,
      prNumber: it.content.__typename === "PullRequest" ? it.content.number : null,
      closedAt: it.content.closedAt,
    });
  }

  return {
    ok: true,
    olderThan: olderThanRaw,
    scanned: repoItems.length,
    archivable: archivable.length,
    archived,
  };
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

  // Resolve board + threshold defaults from .devloops when the flags are absent.
  // Precedence: explicit --project flag > queue.board.number/title.
  //             explicit --older-than flag > queue.archiveOlderThanDays > 7d.
  const settings = resolveSettings(cwd);
  if (args.project === undefined && settings) {
    if (settings.project) args.project = String(settings.project);
    else if (settings.title) args.projectTitle = settings.title;
  }
  if (args.olderThan === undefined && settings?.olderThanDays) {
    args.olderThanDefault = `${settings.olderThanDays}d`;
  }

  try {
    const result = await main(args, { env, cwd });
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

export { main, parseCliArgs, parseDuration, selectArchivable, resolveSettings, runCli };
