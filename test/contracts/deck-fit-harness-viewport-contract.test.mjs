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

test('deck-fit captures wait for top alignment and current visible chrome', async () => {
  const source = await readFile(new URL('../../test/playwright/harness/deck-fit-harness.mjs', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /scrollIntoViewIfNeeded/, 'conditional scrolling can capture a partially settled slide');
  assert.match(source, /scrollIntoView\(\{ behavior: "auto", block: "start"/, 'capture scrolling must be instant and top-aligned');
  assert.match(source, /captured section must be aligned to the viewport top/, 'capture must assert the target geometry');
  assert.match(source, /visible slide counter must match the section being captured/, 'capture must assert the visible counter');
  assert.match(source, /visible progress must match the section being captured/, 'capture must assert the rendered progress width');
  assert.match(source, /capture-state assertion fails on stale chrome/, 'the shared suite must retain a stale-chrome negative control');
});

test('desktop and mobile deck screenshots are captured only after deterministic chrome alignment', async () => {
  const source = await readFile(new URL('../../test/playwright/harness/deck-fit-harness.mjs', import.meta.url), 'utf8');
  const deckSuite = source.slice(
    source.indexOf('export function defineDeckSuite'),
    source.indexOf('// The deck registry.'),
  );
  const captureCalls = [...deckSuite.matchAll(/await captureNamedUiState\(\{/g)];

  assert.equal(captureCalls.length, 2, 'the deck suite must retain one desktop and one mobile named-state capture flow');
  for (const [index, flow] of ['desktop', 'mobile'].entries()) {
    const captureCall = captureCalls[index];
    const priorCapture = index === 0 ? 0 : captureCalls[index - 1].index + captureCalls[index - 1][0].length;
    const setup = deckSuite.slice(priorCapture, captureCall.index);
    assert.match(
      setup,
      /await alignDeckSectionForCapture\(page, section, [^;]+\);\s*$/,
      `${flow} capture must await alignment and exact chrome assertions immediately before writing screenshot evidence`,
    );
  }

  const alignmentHelper = source.slice(
    source.indexOf('export async function alignDeckSectionForCapture'),
    source.indexOf('// Registry-driven runner:'),
  );
  assert.match(
    alignmentHelper,
    /await assertDeckChromeState\(page, section, index, total\);/,
    'alignment must await the exact counter and proportional progress assertion before returning',
  );
});
