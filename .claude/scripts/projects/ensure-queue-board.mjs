#!/usr/bin/env node
import { parseArgs } from "node:util";
import { formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { runChild as _runChild } from "../_cli-primitives.mjs";
import { resolveSettings } from "./_resolve-project.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
import { ghGraphql, resolveOwner } from "@dev-loops/core/github/gh";
import { validateProjectsRepo, discoverProjects, paginateNodes } from "@dev-loops/core/projects/projects-access";

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
tracker.board.number or tracker.board.title.

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

// Strict owner/name validation is shared (validateProjectsRepo); ensure keeps
// its caller-specific error presentation by re-attaching its own `usage` to the
// INVALID_REPO error. Same message and code as the shared owner, plus usage.
function validateRepo(repo) {
  try {
    return validateProjectsRepo(repo);
  } catch (err) {
    if (err && err.code === "INVALID_REPO" && err.usage === undefined) err.usage = USAGE;
    throw err;
  }
}

// ── Query/mutation fragments ────────────────────────────────────────────

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

// ── Paginated project listing (shared discovery) ──────────────────────────

const listAllProjects = discoverProjects;

// ── Paginated field listing ──────────────────────────────────────────────
// ensure reads a WIDER option projection (color/description) than the shared
// listProjectFields for its repair path, so it supplies its own field query to
// the shared cursor traversal.

function listAllFields(projectId, env, runChild) {
  return paginateNodes({
    query: GET_PROJECT_FIELDS,
    variables: { projectId },
    selectConnection: (payload) => payload?.data?.node?.fields,
    env,
    runChild,
    entity: "fields",
  });
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
  // QUEUE-BOARD-LINKED: default linkRepo to the given repo so every board
  // created/ensured through this wrapper is linked to its repo (a guard present
  // at one entry point but not its siblings). `repo` is already validated above
  // and has exactly owner/name form, so it is safe to reuse here.
  const linkRepo = args.linkRepo || repo;
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
