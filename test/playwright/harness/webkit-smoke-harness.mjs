/**
 * Playwright-suite harness. The named-state capture surface it re-exports lives
 * in `scripts/loop/ui-review-capture.mjs` — the shipped adapter layer — because
 * the ui-review stages import it at runtime and a shipped entrypoint must not
 * import from the test tree. Only the fixture-server helpers below are genuinely
 * test-only and stay here.
 */
import { once } from 'node:events';

export {
  buildNamedUiStateArtifactPaths,
  captureNamedUiState,
  launchWebkit,
  normalizeInteractionSegment,
  normalizeUiStateSegment,
  normalizeViewportSegment,
  PLAYWRIGHT_MISSING_MESSAGE,
  WEBKIT_MISSING_MESSAGE,
} from '../../../scripts/loop/ui-review-capture.mjs';

export async function startFixtureServer(createServer) {
  const server = await createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
  };
}

export async function stopFixtureServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
