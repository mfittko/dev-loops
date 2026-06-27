// Bounded slides content & storytelling reviewer mode behind `dev-loop`.
// Sibling of scripts/loop/ui-designer-review-contract.mjs: this one judges a
// deck's narrative, not its pixels. Pure module, no I/O.

export const STORY_REVIEW_OUTCOMES = Object.freeze([
  'story_review_satisfied',
  'needs_iteration',
]);

export const STORY_REVIEW_SEVERITIES = Object.freeze(['high', 'medium', 'low']);

export function validateSlidesStoryReviewInput(input = {}) {
  // Coerce a null / non-object argument to {} so this validator always returns
  // its structured status rather than throwing (the module's contract is a
  // structured result, never an exception).
  if (!input || typeof input !== 'object') input = {};
  if (input.workType !== 'slides' || input.storyReviewRequested !== true) {
    return {
      ok: true,
      status: 'skip_non_slides',
      reason: 'non_slides_or_not_requested',
      missing: [],
    };
  }
  const missing = [];
  const acceptanceCriteria = Array.isArray(input.acceptanceCriteria)
    ? input.acceptanceCriteria.filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
    : [];
  if (acceptanceCriteria.length === 0) {
    missing.push('acceptanceCriteria');
  }
  if (typeof input.storytellingBrief !== 'string' || input.storytellingBrief.trim().length === 0) {
    missing.push('storytellingBrief');
  }
  const deckBundle = input.deckBundle ?? {};
  if (typeof deckBundle.deckSourcePath !== 'string' || deckBundle.deckSourcePath.trim().length === 0) {
    missing.push('deckBundle.deckSourcePath');
  }
  if (missing.length > 0) {
    return {
      ok: false,
      status: 'blocked_missing_required_inputs',
      reason: 'required_inputs_missing',
      missing,
    };
  }
  // Captured slide screenshots are optional, but if present each entry must be complete.
  const incompleteArtifacts = [];
  const slideScreenshots = Array.isArray(deckBundle.slideScreenshots) ? deckBundle.slideScreenshots : [];
  slideScreenshots.forEach((rawShot, index) => {
    const shot = rawShot && typeof rawShot === 'object' ? rawShot : {};
    if (typeof shot.slideId !== 'string' || shot.slideId.trim().length === 0) {
      incompleteArtifacts.push(`deckBundle.slideScreenshots[${index}].slideId`);
    }
    if (typeof shot.screenshotPath !== 'string' || shot.screenshotPath.trim().length === 0) {
      incompleteArtifacts.push(`deckBundle.slideScreenshots[${index}].screenshotPath`);
    }
  });
  if (incompleteArtifacts.length > 0) {
    return {
      ok: false,
      status: 'blocked_incomplete_deck_bundle',
      reason: 'deck_bundle_incomplete',
      missing: incompleteArtifacts,
    };
  }
  return {
    ok: true,
    status: 'ready_for_story_review',
    reason: 'deck_bundle_complete',
    missing: [],
  };
}

export function validateSlidesStoryReviewResult(result = {}) {
  // Coerce a null / non-object argument to {} so this validator returns its
  // structured `invalid` result rather than throwing.
  if (!result || typeof result !== 'object') result = {};
  const invalid = [];
  if (!STORY_REVIEW_OUTCOMES.includes(result.outcome)) {
    invalid.push('outcome');
  }
  if (typeof result.summary !== 'string' || result.summary.trim().length === 0) {
    invalid.push('summary');
  }
  const findings = Array.isArray(result.findings) ? result.findings : null;
  if (findings === null) {
    invalid.push('findings');
  } else {
    findings.forEach((rawFinding, index) => {
      const finding = rawFinding && typeof rawFinding === 'object' ? rawFinding : {};
      if (!STORY_REVIEW_SEVERITIES.includes(finding.severity)) {
        invalid.push(`findings[${index}].severity`);
      }
      if (typeof finding.slideId !== 'string' || finding.slideId.trim().length === 0) {
        invalid.push(`findings[${index}].slideId`);
      }
      if (typeof finding.problem !== 'string' || finding.problem.trim().length === 0) {
        invalid.push(`findings[${index}].problem`);
      }
      if (typeof finding.correctiveAction !== 'string' || finding.correctiveAction.trim().length === 0) {
        invalid.push(`findings[${index}].correctiveAction`);
      }
    });
  }
  if (result.outcome === 'needs_iteration' && findings !== null && findings.length === 0) {
    invalid.push('findings');
  }
  if (invalid.length > 0) {
    return {
      ok: false,
      status: 'invalid_result_shape',
      reason: 'result_shape_invalid',
      invalid,
    };
  }
  return {
    ok: true,
    status: 'valid_result_shape',
    reason: 'result_shape_valid',
    invalid: [],
  };
}
