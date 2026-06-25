import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  USAGE,
} from "./constants.mjs";
import { parseArgs } from "node:util";
import { requireTokenValue } from "../../_cli-primitives.mjs";
import { normalizeInspectionTarget } from "../_inspect-run-viewer-adapter.mjs";

export function parseInspectRunViewerCliError(message) {
  return Object.assign(new Error(message), { usage: USAGE });
}

function parsePort(rawPort) {
  if (!/^\d+$/.test(rawPort)) {
    throw parseInspectRunViewerCliError("--port must be a positive integer");
  }
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw parseInspectRunViewerCliError("--port must be between 1 and 65535");
  }
  return port;
}

function parseHost(rawHost) {
  const host = rawHost.trim();
  if (host.length === 0) {
    throw parseInspectRunViewerCliError("--host must not be empty");
  }
  if (/^\[[^\]]+\]$/.test(host)) {
    return host.slice(1, -1);
  }
  return host;
}

function isLoopbackHost(host) {
  return host === "localhost"
    || host === "::1"
    || /^127(?:\.\d{1,3}){3}$/.test(host);
}

export function normalizeCliRepoOption(rawRepo) {
  try {
    return normalizeInspectionTarget({ repo: rawRepo, pr: 1 }).repo;
  } catch (error) {
    throw parseInspectRunViewerCliError(error instanceof Error ? error.message : String(error));
  }
}

export function parseInspectRunViewerCliArgs(argv) {
  const options = {
    help: false,
    repo: undefined,
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    steeringStateFile: undefined,
    copilotInputPath: undefined,
    reviewerInputPath: undefined,
    allowNonLocalhost: false,
    restart: false,
  };

  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      pr: { type: "boolean" },
      host: { type: "string" },
      port: { type: "string" },
      "allow-non-localhost": { type: "boolean" },
      restart: { type: "boolean" },
      "steering-state-file": { type: "string" },
      "copilot-input": { type: "string" },
      "reviewer-input": { type: "string" },
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  for (const token of tokens) {
    if (token.kind === "positional") {
      throw parseInspectRunViewerCliError(`Unknown argument: ${token.value}`);
    }
    if (token.kind !== "option") {
      continue;
    }
    if (token.name === "help") {
      options.help = true;
      return options;
    }
    if (token.name === "repo") {
      options.repo = requireTokenValue(token, parseInspectRunViewerCliError);
      continue;
    }
    if (token.name === "pr") {
      throw parseInspectRunViewerCliError("--pr is no longer supported on the CLI; choose a PR with ?pr=<number> in the viewer URL");
    }
    if (token.name === "host") {
      options.host = parseHost(requireTokenValue(token, parseInspectRunViewerCliError));
      continue;
    }
    if (token.name === "port") {
      options.port = parsePort(requireTokenValue(token, parseInspectRunViewerCliError));
      continue;
    }
    if (token.name === "allow-non-localhost") {
      options.allowNonLocalhost = true;
      continue;
    }
    if (token.name === "restart") {
      options.restart = true;
      continue;
    }
    if (token.name === "steering-state-file") {
      options.steeringStateFile = requireTokenValue(token, parseInspectRunViewerCliError);
      continue;
    }
    if (token.name === "copilot-input") {
      options.copilotInputPath = requireTokenValue(token, parseInspectRunViewerCliError);
      continue;
    }
    if (token.name === "reviewer-input") {
      options.reviewerInputPath = requireTokenValue(token, parseInspectRunViewerCliError);
      continue;
    }
    throw parseInspectRunViewerCliError(`Unknown argument: ${token.rawName}`);
  }

  if (!options.help) {
    options.repo = options.repo === undefined ? undefined : normalizeCliRepoOption(options.repo);
    if (!options.allowNonLocalhost && !isLoopbackHost(options.host)) {
      throw parseInspectRunViewerCliError("--host must stay on localhost/loopback unless --allow-non-localhost is set");
    }
  }

  return options;
}

export { USAGE };
