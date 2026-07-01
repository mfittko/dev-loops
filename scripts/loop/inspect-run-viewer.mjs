#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatCliError } from "../_core-helpers.mjs";
import { parseInspectRunViewerCliArgs, parseInspectRunViewerCliError, USAGE } from "./inspect-run-viewer/cli.mjs";
import {
  createInspectRunViewerServer,
  formatInspectRunViewerUrl,
  listListeningPidsForPort,
  restartExistingPortListener,
} from "./inspect-run-viewer/server.mjs";
import {
  buildInspectionMermaidGraph,
  loadMermaidBrowserScript,
  renderInspectRunViewerHtml,
  resetMermaidBrowserScriptCache,
} from "./inspect-run-viewer/rendering.mjs";
function normalizeRestartCapabilityError(error) {
  const missingLsof = error?.code === "ENOENT"
    && (error?.path === "lsof" || /(^|\b)lsof(\b|$)/i.test(String(error?.message ?? "")));
  if (!missingLsof) {
    return error;
  }
  const parseFriendlyError = parseInspectRunViewerCliError(
    "--restart requires lsof/POSIX support; install lsof or rerun without --restart",
  );
  parseFriendlyError.cause = error;
  return parseFriendlyError;
}
export {
  buildInspectionMermaidGraph,
  createInspectRunViewerServer,
  formatInspectRunViewerUrl,
  listListeningPidsForPort,
  loadMermaidBrowserScript,
  parseInspectRunViewerCliArgs,
  renderInspectRunViewerHtml,
  resetMermaidBrowserScriptCache,
  restartExistingPortListener,
};
// ponytail: lifetime timeout defaults to 8h; long-running viewer sessions can raise it via --lifetime-ms.
export const DEFAULT_SERVER_LIFETIME_MS = 8 * 60 * 60 * 1000;

// Wires signal handlers + a lifetime timeout so a directly-run viewer server is
// always torn down instead of leaking across sessions. Returns an idempotent
// teardown() that closes the server and detaches every handler it installed.
export function installServerTeardown(
  server,
  {
    signals = ["SIGINT", "SIGTERM"],
    lifetimeMs = DEFAULT_SERVER_LIFETIME_MS,
    onTeardown = () => {},
    processImpl = process,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
  } = {},
) {
  let closed = false;
  let lifetimeTimer = null;

  const teardown = (reason = "teardown") => {
    if (closed) {
      return;
    }
    closed = true;
    if (lifetimeTimer !== null) {
      clearTimeoutImpl(lifetimeTimer);
      lifetimeTimer = null;
    }
    for (const signal of signals) {
      processImpl.removeListener(signal, signalHandler);
    }
    try {
      onTeardown(reason);
    } finally {
      server.close();
    }
  };

  function signalHandler(signal) {
    teardown(signal);
  }

  for (const signal of signals) {
    processImpl.on(signal, signalHandler);
  }

  if (Number.isFinite(lifetimeMs) && lifetimeMs > 0) {
    lifetimeTimer = setTimeoutImpl(() => teardown("lifetime-timeout"), lifetimeMs);
    // Do not let the teardown timer itself keep the event loop alive.
    if (typeof lifetimeTimer?.unref === "function") {
      lifetimeTimer.unref();
    }
  }

  return teardown;
}
export async function runCli(
  argv = process.argv.slice(2),
  {
    stdout = process.stdout,
    restartExistingPortListenerImpl = restartExistingPortListener,
  } = {},
) {
  const options = parseInspectRunViewerCliArgs(argv);
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return null;
  }
  if (options.restart) {
    try {
      await restartExistingPortListenerImpl(options.port);
    } catch (error) {
      throw normalizeRestartCapabilityError(error);
    }
  }
  const server = createInspectRunViewerServer(options);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, resolve);
  });
  stdout.write(
    `${JSON.stringify({
      ok: true,
      message: "read-only inspect-run dashboard started",
      scope: { repo: options.repo },
      url: formatInspectRunViewerUrl(options.host, options.port),
      reload: "manual",
    })}\n`,
  );
  return server;
}
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  runCli()
    .then((server) => {
      if (server) {
        installServerTeardown(server);
      }
    })
    .catch((error) => {
      process.stderr.write(`${formatCliError(error)}\n`);
      process.exitCode = 1;
    });
}
