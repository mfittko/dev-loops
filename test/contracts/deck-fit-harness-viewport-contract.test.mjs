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

  // No capture may re-encode a viewport into the state NAME (the dropped hack was
  // `(mobile 390)`). Anchor on the `stateName:` assignment and forbid a viewport
  // word on that line, in ANY string form — backtick, quote, or concatenation all
  // put `mobile`/`desktop`/`tablet` on the `stateName:` line, so a regression can't
  // slip back under a different quote style. Variable refs like `mobileCapture`
  // are unaffected (no word boundary after `mobile`), and the check is scoped to
  // `stateName:` lines so unrelated comments/test-names don't trip it.
  assert.doesNotMatch(
    source,
    /stateName:[^\n]*\b(?:mobile|desktop|tablet)\b/i,
    'stateName must not encode a viewport label — the slug carries it',
  );
});
