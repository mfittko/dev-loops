import { runChild as _runChild } from "../cli/primitives.mjs";
import { resolveProjectSelector, findProject } from "./resolve-project.mjs";
import { resolveOwner } from "../github/gh.mjs";
import { validateProjectsRepo, discoverProjects, listProjectFields, paginateNodes, extractStatus } from "./projects-access.mjs";

// ── Validation ───────────────────────────────────────────────────────────

const validateRepo = validateProjectsRepo;

// ── GraphQL fragments ────────────────────────────────────────────────────

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

// ── Paginated project + field listing (shared via projects-access) ────────

const listAllProjects = discoverProjects;
const listAllFields = listProjectFields;

// ── Paginated item listing ───────────────────────────────────────────────

function listAllItems(projectId, env, runChild) {
  return paginateNodes({
    query: GET_PROJECT_ITEMS,
    variables: { projectId },
    selectConnection: (payload) => payload?.data?.node?.items,
    env,
    runChild,
    entity: "items",
  });
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

  // 1. Resolve owner (user or org).
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
    const status = extractStatus(item);

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

export { main, classifyExitCode };
