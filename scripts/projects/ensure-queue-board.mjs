#!/usr/bin/env node
import { parseArgs } from "node:util";
import { formatCliError, isDirectCliRun, parseJsonText } from "../_core-helpers.mjs";
import { runChild as _runChild } from "../_cli-primitives.mjs";
import { resolveSettings } from "./_resolve-project.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";

const USAGE = `Usage: dev-loops queue ensure --repo <owner/name> [--project <number>] [--title <title>] [--link-repo <owner/name>] [--repair-rename]
       (dev-loops project ensure … is a back-compat alias)

--repair-rename    Rename semantically equivalent Status columns to the standard names
                   (e.g. "Ready" -> "Next Up"). Without this flag the helper only
                   reports rename candidates and leaves existing columns untouched.

Idempotent bootstrap for a GitHub Projects V2 board used as the dev-loop queue.

Creates the project board if it doesn't exist, ensures a Status field with
standard columns (Backlog, Next Up, In Progress, Done). Exits clean if the
board and Status field already exist.

When --link-repo is provided, links the project to the given repository after creation.

When --project is not provided, resolves from .devloops at repo root
queue.projectNumber or queue.boardTitle.

Output (stdout):
  JSON: { ok: true, project: { id, number, title, url, statusFieldId, linkedRepo } }

${JQ_OUTPUT_USAGE}

Exit codes:
  0 — board exists or was created successfully (idempotent)
  1 — usage or argument error
  2 — GitHub API error / invalid --jq filter
  3 — board schema/config mismatch (manual reconciliation needed)
`;

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
      title: { type: "string" },
      "link-repo": { type: "string" },
      "repair-rename": { type: "boolean" },
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
      case "project": {
        const raw = requireValue(token, "--project requires a numeric value");
        const num = Number(raw);
        if (!Number.isInteger(num) || num <= 0) {
          throw parseError(`--project must be a positive integer, got "${raw}"`);
        }
        args.project = num;
        break;
      }
      case "title":
        args.title = requireValue(token, "--title requires a value");
        break;
      case "link-repo":
        args.linkRepo = requireValue(token, "--link-repo requires a value (owner/name)");
        break;
      case "repair-rename":
        if (token.value !== undefined) {
          throw parseError(`Unknown flag: ${token.rawName}=${token.value}`);
        }
        args.repairRename = true;
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

// GitHub slug rules: owner 1-39 chars (alnum/dash, no leading/trailing dash,
// no consecutive dashes); repo name similar but also allows dots/underscores.
const OWNER_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/;
const REPO_NAME_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9_.-]*[a-zA-Z0-9])?$/;

function validateRepo(repo) {
  if (!repo || typeof repo !== "string") {
    throw Object.assign(new Error("--repo is required"), { code: "INVALID_REPO", usage: USAGE });
  }
  const trimmed = repo.trim();
  if (trimmed !== repo) {
    throw Object.assign(
      new Error(`--repo must not have leading/trailing whitespace, got "${repo}"`),
      { code: "INVALID_REPO", usage: USAGE },
    );
  }
  const slashIdx = repo.indexOf("/");
  if (slashIdx === -1) {
    throw Object.assign(
      new Error(`--repo must be exactly owner/name, got "${repo}"`),
      { code: "INVALID_REPO", usage: USAGE },
    );
  }
  const owner = repo.slice(0, slashIdx);
  const name = repo.slice(slashIdx + 1);
  if (!owner || !name) {
    throw Object.assign(
      new Error(`--repo must be exactly owner/name, got "${repo}"`),
      { code: "INVALID_REPO", usage: USAGE },
    );
  }
  if (!OWNER_RE.test(owner) || !REPO_NAME_RE.test(name)) {
    throw Object.assign(
      new Error(`--repo must be exactly owner/name, got "${repo}"`),
      { code: "INVALID_REPO", usage: USAGE },
    );
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

// ── Query/mutation fragments ────────────────────────────────────────────

const GET_USER_ID = [
  "query($login:String!) {",
  "  user(login:$login) {",
  "    id",
  "  }",
  "}"
].join("\n");

const GET_ORG_ID = [
  "query($login:String!) {",
  "  organization(login:$login) {",
  "    id",
  "  }",
  "}"
].join("\n");

const LIST_USER_PROJECTS = [
  "query($login:String!, $after:String) {",
  "  user(login:$login) {",
  "    projectsV2(first:50, after:$after) {",
  "      pageInfo {",
  "        hasNextPage",
  "        endCursor",
  "      }",
  "      nodes {",
  "        id",
  "        number",
  "        title",
  "        url",
  "      }",
  "    }",
  "  }",
  "}"
].join("\n");

const LIST_ORG_PROJECTS = [
  "query($login:String!, $after:String) {",
  "  organization(login:$login) {",
  "    projectsV2(first:50, after:$after) {",
  "      pageInfo {",
  "        hasNextPage",
  "        endCursor",
  "      }",
  "      nodes {",
  "        id",
  "        number",
  "        title",
  "        url",
  "      }",
  "    }",
  "  }",
  "}"
].join("\n");

const CREATE_PROJECT = [
  "mutation($ownerId:ID!, $title:String!) {",
  "  createProjectV2(input:{ownerId:$ownerId, title:$title}) {",
  "    projectV2 {",
  "      id",
  "      number",
  "      title",
  "      url",
  "    }",
  "  }",
  "}"
].join("\n");

const GET_PROJECT_FIELDS = [
  "query($projectId:ID!, $after:String) {",
  "  node(id:$projectId) {",
  "    ... on ProjectV2 {",
  "      fields(first:50, after:$after) {",
  "        pageInfo {",
  "          hasNextPage",
  "          endCursor",
  "        }",
  "        nodes {",
  "          ... on ProjectV2SingleSelectField {",
  "            id",
  "            name",
  "            options {",
  "              id",
  "              name",
  "              color",
  "              description",
  "            }",
  "          }",
  "        }",
  "      }",
  "    }",
  "  }",
  "}"
].join("\n");

const CREATE_SINGLE_SELECT_FIELD = [
  "mutation($projectId:ID!) {",
  "  createProjectV2Field(input:{projectId:$projectId, dataType:SINGLE_SELECT, name:\"Status\", singleSelectOptions:[",
  "    {name:\"Backlog\",color:GRAY,description:\"\"},",
  "    {name:\"Next Up\",color:BLUE,description:\"\"},",
  "    {name:\"In Progress\",color:YELLOW,description:\"\"},",
  "    {name:\"Done\",color:GREEN,description:\"\"}",
  "  ]}) {",
  "    projectV2Field {",
  "      ... on ProjectV2SingleSelectField {",
  "        id",
  "        name",
  "      }",
  "    }",
  "  }",
  "}"
].join("\n");

const LINK_PROJECT_TO_REPO = [
  "mutation($projectId:ID!, $repositoryId:ID!) {",
  "  linkProjectV2ToRepository(input:{projectId:$projectId, repositoryId:$repositoryId}) {",
  "    clientMutationId",
  "  }",
  "}"
].join("\n");

const UPDATE_PROJECT_FIELD = [
  "mutation($fieldId:ID!, $options: [ProjectV2SingleSelectFieldOptionInput!]!) {",
  "  updateProjectV2Field(input:{fieldId:$fieldId, singleSelectOptions:$options}) {",
  "    projectV2Field {",
  "      ... on ProjectV2SingleSelectField {",
  "        id",
  "        name",
  "        options {",
  "          id",
  "          name",
  "        }",
  "      }",
  "    }",
  "  }",
  "}"
].join("\n");

const GET_REPO_ID = [
  "query($owner:String!, $name:String!) {",
  "  repository(owner:$owner, name:$name) {",
  "    id",
  "  }",
  "}"
].join("\n");

// ── Owner resolution ────────────────────────────────────────────────────

async function resolveOwner(login, env, runChild) {
  // Try user first
  const userPayload = await ghGraphql(GET_USER_ID, { login }, env, runChild);
  if (userPayload?.data?.user?.id) {
    return { id: userPayload.data.user.id, kind: "user" };
  }
  // Try organization (only if user returned null — not for API errors)
  const orgPayload = await ghGraphql(GET_ORG_ID, { login }, env, runChild);
  if (orgPayload?.data?.organization?.id) {
    return { id: orgPayload.data.organization.id, kind: "org" };
  }
  throw Object.assign(
    new Error(`Could not resolve owner ID for "${login}" (not a user or organization)`),
    { code: "NO_USER_ID" },
  );
}

// ── Repository ID resolution ─────────────────────────────────────────────

async function resolveRepoId(slug, env, runChild) {
  const [owner, name] = slug.split("/");
  const payload = await ghGraphql(GET_REPO_ID, { owner, name }, env, runChild);
  if (!payload?.data?.repository?.id) {
    throw Object.assign(
      new Error(`Could not resolve repository ID for "${slug}"`),
      { code: "NO_REPO_ID" },
    );
  }
  return payload.data.repository.id;
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


// ── Column rename/reconcile helpers ──────────────────────────────────────

const RENAME_EQUIVALENTS = {
  "Backlog": ["Backlog", "Todo", "To do", "Pending"],
  "Next Up": ["Next Up", "Ready", "Next", "Up next"],
  "In Progress": ["In Progress", "Doing", "In progress", "InProgress"],
  "Done": ["Done", "Complete", "Completed"],
};

function normalizeOptionName(name) {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

const EQUIVALENT_TO_STANDARD = new Map();
for (const [standard, synonyms] of Object.entries(RENAME_EQUIVALENTS)) {
  for (const synonym of synonyms) {
    EQUIVALENT_TO_STANDARD.set(normalizeOptionName(synonym), standard);
  }
}

function buildOptionInput(option) {
  const standard = STANDARD_COLUMNS.find((c) => c.name === option.name);
  return {
    name: option.name,
    color: option.color ?? standard?.color ?? "GRAY",
    description: option.description ?? "",
  };
}

function classifyOptions(existingOptions, repairRename) {
  const exactPresent = new Set(existingOptions.map((o) => o.name));
  const candidates = [];
  const conflicts = [];
  const seenCandidateStandard = new Map(); // standard -> option name

  for (const option of existingOptions) {
    const standard = EQUIVALENT_TO_STANDARD.get(normalizeOptionName(option.name));
    if (!standard) continue;

    // Exact standard columns are not drift; skip them.
    if (option.name === standard) continue;

    if (exactPresent.has(standard)) {
      conflicts.push({
        option: option.name,
        reason: `Equivalent "${option.name}" maps to "${standard}", but the exact standard column already exists.`,
      });
      continue;
    }

    if (seenCandidateStandard.has(standard)) {
      conflicts.push({
        option: option.name,
        reason: `Multiple columns map to "${standard}": "${seenCandidateStandard.get(standard)}" and "${option.name}".`,
      });
      continue;
    }

    seenCandidateStandard.set(standard, option.name);
    candidates.push({
      optionId: option.id,
      from: option.name,
      to: standard,
    });
  }

  const candidateTargets = new Set(candidates.map((c) => c.to));

  if (repairRename && conflicts.length === 0) {
    const appliedRenames = [];
    const renamedOptions = existingOptions.map((option) => {
      const candidate = candidates.find((c) => c.optionId === option.id);
      if (!candidate) return buildOptionInput(option);
      appliedRenames.push({ from: candidate.from, to: candidate.to });
      return {
        name: candidate.to,
        color: STANDARD_COLUMNS.find((c) => c.name === candidate.to)?.color ?? "GRAY",
        description: option.description ?? "",
      };
    });

    const coveredStandards = new Set([...exactPresent, ...appliedRenames.map((r) => r.to)]);
    const additiveMissing = STANDARD_COLUMNS.filter((c) => !coveredStandards.has(c.name));

    return {
      options: [...renamedOptions, ...additiveMissing],
      repairs: {
        additive: additiveMissing.map((c) => c.name),
        renameCandidates: [],
        renamesApplied: appliedRenames,
        conflicts: [],
      },
    };
  }

  const coveredStandards = new Set([...exactPresent, ...candidateTargets]);
  const additiveMissing = STANDARD_COLUMNS.filter((c) => !coveredStandards.has(c.name));

  return {
    options: [
      ...existingOptions.map(buildOptionInput),
      ...additiveMissing,
    ],
    repairs: {
      additive: additiveMissing.map((c) => c.name),
      renameCandidates: candidates.map((c) => ({ from: c.from, to: c.to })),
      renamesApplied: [],
      conflicts,
    },
  };
}

async function classifyAndRepairColumns(
  fieldId,
  existingOptions,
  repairRename,
  env,
  runChild,
) {
  const classification = classifyOptions(existingOptions, repairRename);

  const willRename = classification.repairs.renamesApplied.length > 0;
  const willAdd = classification.repairs.additive.length > 0;

  if (!willRename && !willAdd) {
    return { options: existingOptions, repairs: classification.repairs };
  }

  // When conflicts are present, do not mutate the field; surface the conflict.
  if (classification.repairs.conflicts.length > 0) {
    return { options: existingOptions, repairs: classification.repairs };
  }

  const payload = await ghGraphql(UPDATE_PROJECT_FIELD, {
    fieldId,
    options: JSON.stringify(classification.options),
  }, env, runChild);

  const updatedField = payload?.data?.updateProjectV2Field?.projectV2Field;
  if (!updatedField) {
    throw Object.assign(
      new Error("Failed to update Status field with column repairs"),
      { code: "UPDATE_FIELD_FAILED" },
    );
  }

  return { options: updatedField.options ?? classification.options, repairs: classification.repairs };
}

// ── Column auto-repair ───────────────────────────────────────────────────

const STANDARD_COLUMNS = [
  { name: "Backlog", color: "GRAY", description: "" },
  { name: "Next Up", color: "BLUE", description: "" },
  { name: "In Progress", color: "YELLOW", description: "" },
  { name: "Done", color: "GREEN", description: "" },
];

const STANDARD_COLUMN_NAMES = STANDARD_COLUMNS.map((c) => c.name);

const EMPTY_REPAIRS = Object.freeze({ additive: [], renameCandidates: [], renamesApplied: [], conflicts: [] });

/**
 * Auto-repair a Status field that is missing standard columns.
 *
 * Calls updateProjectV2Field to add missing columns while preserving
 * any existing (non-standard) columns in their current order.
 *
 * Returns the updated field options (with IDs from the mutation response).
 */
async function autoRepairColumns(
  fieldId,
  existingOptions,
  env,
  runChild,
) {
  const existingNames = new Set(existingOptions.map((o) => o.name));
  const missingColumns = STANDARD_COLUMNS.filter(
    (c) => !existingNames.has(c.name),
  );

  if (missingColumns.length === 0) {
    // Nothing to repair — should not be called in this case
    return existingOptions;
  }

  // Build full option list: existing options + missing standard columns appended
  const fullOptions = [
    ...existingOptions.map((o) => ({ name: o.name, color: o.color ?? "GRAY", description: o.description ?? "" })),
    ...missingColumns,
  ];

  const payload = await ghGraphql(UPDATE_PROJECT_FIELD, {
    fieldId,
    options: JSON.stringify(fullOptions),
  }, env, runChild);

  const updatedField = payload?.data?.updateProjectV2Field?.projectV2Field;
  if (!updatedField) {
    throw Object.assign(
      new Error("Failed to update Status field with missing columns"),
      { code: "UPDATE_FIELD_FAILED" },
    );
  }

  return updatedField.options ?? fullOptions;
}

// ── Exit code classification ────────────────────────────────────────────

function classifyExitCode(err) {
  if (err.code === "INVALID_REPO" || err.code === "INVALID_PROJECT") return 1;
  return 2;
}

// ── Main logic ──────────────────────────────────────────────────────────

async function main(args, { env = process.env, runChild } = {}) {
  const child = runChild ?? _runChild;
  const repo = validateRepo(args.repo);
  const [owner] = repo.split("/");
  const title = args.title || "Dev Loop Queue"; // explicit default after settings fallback in runCli
  const linkRepo = args.linkRepo || null;
  if (linkRepo) validateRepo(linkRepo); // validate format early

  // 1. Resolve owner (user or org)
  const { id: ownerId, kind: ownerKind } = await resolveOwner(owner, env, child);

  // 2. Look for existing project
  const projects = await listAllProjects(owner, ownerKind, env, child);
  let project;
  if (args.project) {
    project = projects.find((p) => p.number === args.project);
    if (!project) {
      throw Object.assign(
        new Error(`Project #${args.project} not found under "${owner}". Use --title to create a new board.`),
        { code: "PROJECT_NOT_FOUND" },
      );
    }
  } else {
    project = projects.find((p) => p.title === title);
  }

  if (project) {
    // Project exists — verify Status field (paginated)
    const fieldNodes = await listAllFields(project.id, env, child);
    const statusField = fieldNodes.find(
      (f) => f.name === "Status" && f.options,
    );

    if (statusField) {
      // Always classify drift for the repairs object, then mutate only when authorized.
      const { repairs } = await classifyAndRepairColumns(
        statusField.id,
        statusField.options,
        args.repairRename ?? false,
        env,
        child,
      );

      let linkedRepo = null;
      if (linkRepo) {
        const repoId = await resolveRepoId(linkRepo, env, child);
        await ghGraphql(LINK_PROJECT_TO_REPO, {
          projectId: project.id,
          repositoryId: repoId,
        }, env, child);
        linkedRepo = linkRepo;
      }
      return {
        ok: true,
        project: {
          id: project.id,
          number: project.number,
          title: project.title,
          url: project.url,
          statusFieldId: statusField.id,
          ...(linkedRepo ? { linkedRepo } : {}),
        },
        repairs,
      };
    }

    // No Status field — create it
    const createFieldPayload = await ghGraphql(CREATE_SINGLE_SELECT_FIELD, {
      projectId: project.id,
    }, env, child);
    const newField = createFieldPayload?.data?.createProjectV2Field?.projectV2Field;
    if (!newField) {
      throw Object.assign(new Error("Failed to create Status field"), { code: "CREATE_FIELD_FAILED" });
    }

    let linkedRepo = null;
    if (linkRepo) {
      const repoId = await resolveRepoId(linkRepo, env, child);
      await ghGraphql(LINK_PROJECT_TO_REPO, {
        projectId: project.id,
        repositoryId: repoId,
      }, env, child);
      linkedRepo = linkRepo;
    }
    return {
      ok: true,
      project: {
        id: project.id,
        number: project.number,
        title: project.title,
        url: project.url,
        statusFieldId: newField.id,
        ...(linkedRepo ? { linkedRepo } : {}),
      },
      repairs: EMPTY_REPAIRS,
    };
  }

  // 3. Create project
  const createPayload = await ghGraphql(CREATE_PROJECT, {
    ownerId,
    title,
  }, env, child);
  project = createPayload?.data?.createProjectV2?.projectV2;
  if (!project) {
    throw Object.assign(new Error("Failed to create project board"), { code: "CREATE_PROJECT_FAILED" });
  }

  // 4. Link to repo if --link-repo provided
  let linkedRepo = null;
  if (linkRepo) {
    const repoId = await resolveRepoId(linkRepo, env, child);
    await ghGraphql(LINK_PROJECT_TO_REPO, {
      projectId: project.id,
      repositoryId: repoId,
    }, env, child);
    linkedRepo = linkRepo;
  }

  // 5. Create Status field on new project
  const createFieldPayload = await ghGraphql(CREATE_SINGLE_SELECT_FIELD, {
    projectId: project.id,
  }, env, child);
  const newField = createFieldPayload?.data?.createProjectV2Field?.projectV2Field;
  if (!newField) {
    throw Object.assign(new Error("Failed to create Status field on new project"), { code: "CREATE_FIELD_FAILED" });
  }

  return {
    ok: true,
    project: {
      id: project.id,
      number: project.number,
      title: project.title,
      url: project.url,
      statusFieldId: newField.id,
      ...(linkedRepo ? { linkedRepo } : {}),
    },
    repairs: EMPTY_REPAIRS,
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

  // Settings-based fallback for --project and --title
  const settings = resolveSettings(cwd);
  if (args.project === undefined && settings?.project) {
    args.project = settings.project;
  }
  if (args.title === undefined && settings?.title) {
    args.title = settings.title;
  }

  try {
    const result = await main(args, { env });
    process.exitCode = emitResult(result, { jq: args.jq, silent: args.silent, stdout, stderr });
  } catch (err) {
    stderr.write(`${formatCliError(err)}\n`);
    process.exitCode = classifyExitCode(err);
  }
}

if (isDirectCliRun(import.meta.url)) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 2;
  });
}

export { main, autoRepairColumns, resolveSettings, STANDARD_COLUMNS, STANDARD_COLUMN_NAMES };
