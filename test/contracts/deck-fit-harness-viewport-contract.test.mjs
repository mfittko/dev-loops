import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Source-level pin for the deck-fit CALLER change: the harness is exercised only
// by live-browser playwright specs (outside `npm run verify`), so this asserts
// the shape here. A revert re-introducing the `(mobile 390)` name-hack (or
// dropping `viewport: MOBILE`) would otherwise pass verify green.
test('deck-fit harness slugs the mobile viewport via `viewport:`, not a name-hacked stateName', async () => {
  const source = await readFile(new URL('../../test/playwright/harness/deck-fit-harness.mjs', import.meta.url), 'utf8');

  // Both mobile captures (deck + article) carry the viewport, so the slug — not
  // the state name — distinguishes the responsive render.
  const viewportCalls = source.match(/viewport:\s*MOBILE\b/g) ?? [];
  assert.ok(viewportCalls.length >= 2, 'deck and article mobile captures must pass `viewport: MOBILE`');

  // No stateName may embed a viewport in the name string (the dropped hack).
  assert.doesNotMatch(
    source,
    /stateName:\s*`[^`]*\b(?:mobile|390)\b/i,
    'stateName must not encode a viewport — the slug carries it',
  );
});
