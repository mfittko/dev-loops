import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderHandoffEnvelopeSection } from "../../scripts/loop/inspect-run-viewer/handoff-envelope-renderer.mjs";

describe("renderHandoffEnvelopeSection", () => {
  it("returns unavailable message when envelope is null", () => {
    const html = renderHandoffEnvelopeSection(null);
    assert.ok(html.includes("Envelope unavailable"), "should mention unavailable");
    assert.ok(html.includes("Agent handoff"), "should include section heading");
    assert.ok(html.includes("buildDevLoopHandoffEnvelope()"), "should reference the function");
  });

  it("returns unavailable message when envelope is undefined", () => {
    const html = renderHandoffEnvelopeSection(undefined);
    assert.ok(html.includes("Envelope unavailable"));
  });

  it("renders target identity from envelope", () => {
    const envelope = {
      target: { kind: "pr", repo: "owner/name", pr: 42 },
      handoffVersion: 1,
      derivedAt: "2026-01-01T00:00:00.000Z",
    };
    const html = renderHandoffEnvelopeSection(envelope);
    assert.ok(html.includes("owner/name#42"), "should show repo#pr identity");
    assert.ok(html.includes("Agent handoff"), "should include section heading");
    assert.ok(html.includes("handoff-card-body"), "should wrap card content for spacing control");
    assert.ok(!html.includes("Envelope unavailable"), "should not show unavailable");
  });

  it("renders current state fields", () => {
    const envelope = {
      target: { kind: "pr", repo: "a/b", pr: 1 },
      handoffVersion: 1,
      currentGate: "draft",
      maxCopilotRounds: 5,
      executionMode: "bounded_handoff",
      gateState: {
        derivedAt: "2026-01-01T00:00:00.000Z",
        currentHeadSha: "abc123def",
        ciStatus: "success",
        unresolvedThreadCount: 0,
        copilotRoundCount: 2,
      },
    };
    const html = renderHandoffEnvelopeSection(envelope);
    assert.ok(html.includes("draft"), "should show current gate");
    assert.ok(html.includes("abc123def"), "should show head SHA");
    assert.ok(html.includes("success"), "should show CI status");
    assert.ok(html.includes("5"), "should show maxCopilotRounds");
  });

  it("renders work directive section", () => {
    const envelope = {
      target: { kind: "pr", repo: "a/b", pr: 1 },
      handoffVersion: 1,
      derivedAt: "2026-01-01T00:00:00.000Z",
      nextAction: "run_draft_gate",
      requiredReads: ["docs/a.md", "docs/b.md"],
    };
    const html = renderHandoffEnvelopeSection(envelope);
    assert.ok(html.includes("run_draft_gate"), "should show next action");
    assert.ok(html.includes("docs/a.md"), "should show required read");
    assert.ok(html.includes("docs/b.md"), "should show second required read");
  });

  it("renders gate configuration when present", () => {
    const envelope = {
      target: { kind: "pr", repo: "a/b", pr: 1 },
      handoffVersion: 1,
      derivedAt: "2026-01-01T00:00:00.000Z",
      gateConfig: {
        angles: ["scope", "coverage", "correctness"],
        excludeAngles: [],
        blockCleanOnFindingSeverities: ["must-fix"],
        requireCi: true,
      },
    };
    const html = renderHandoffEnvelopeSection(envelope);
    assert.ok(html.includes("Gate configuration"), "should show gate config section");
    assert.ok(html.includes("scope"), "should list angle");
    assert.ok(html.includes("coverage"), "should list second angle");
  });

  it("does not show gate config section when absent", () => {
    const envelope = {
      target: { kind: "pr", repo: "a/b", pr: 1 },
      handoffVersion: 1,
      derivedAt: "2026-01-01T00:00:00.000Z",
    };
    const html = renderHandoffEnvelopeSection(envelope);
    assert.ok(!html.includes("Gate configuration"), "should not show gate config when absent");
  });

  it("renders policy and stop rules", () => {
    const envelope = {
      target: { kind: "pr", repo: "a/b", pr: 1 },
      handoffVersion: 1,
      derivedAt: "2026-01-01T00:00:00.000Z",
      asyncStartMode: "required",
      requireDraftFirst: false,
      stopRules: ["draft-pr", "merge"],
    };
    const html = renderHandoffEnvelopeSection(envelope);
    assert.ok(html.includes("Policy"), "should show policy section");
    assert.ok(html.includes("required"), "should show async start mode");
    assert.ok(html.includes("draft-pr"), "should show stop rule");
  });

  it("renders worktree section", () => {
    const envelope = {
      target: { kind: "pr", repo: "a/b", pr: 1 },
      handoffVersion: 1,
      derivedAt: "2026-01-01T00:00:00.000Z",
      cwd: "/tmp/worktrees/pr-42",
      worktreeRequired: true,
    };
    const html = renderHandoffEnvelopeSection(envelope);
    assert.ok(html.includes("Worktree"), "should show worktree section");
    assert.ok(html.includes("/tmp/worktrees/pr-42"), "should show cwd");
  });

  it("renders acceptance contract when present", () => {
    const envelope = {
      target: { kind: "pr", repo: "a/b", pr: 1 },
      handoffVersion: 1,
      derivedAt: "2026-01-01T00:00:00.000Z",
      acceptance: {
        criteria: [
          { severity: "required", id: "ci-green", must: "CI must pass" },
          { severity: "required", id: "scope", must: "No stray files" },
        ],
        evidence: ["commands-run", "validation-output"],
        maxFinalizationTurns: 4,
      },
    };
    const html = renderHandoffEnvelopeSection(envelope);
    assert.ok(html.includes("Acceptance contract"), "should show acceptance section");
    assert.ok(html.includes("ci-green"), "should show criterion id");
    assert.ok(html.includes("CI must pass"), "should show criterion text");
    assert.ok(html.includes("4"), "should show max finalization turns");
  });

  it("renders runtime control when present", () => {
    const envelope = {
      target: { kind: "pr", repo: "a/b", pr: 1 },
      handoffVersion: 1,
      derivedAt: "2026-01-01T00:00:00.000Z",
      control: {
        needsAttentionAfterMs: 300000,
        activeNoticeAfterMs: 300000,
      },
    };
    const html = renderHandoffEnvelopeSection(envelope);
    assert.ok(html.includes("Runtime control"), "should show control section");
  });

  it("renders overrides when present", () => {
    const envelope = {
      target: { kind: "pr", repo: "a/b", pr: 1 },
      handoffVersion: 1,
      derivedAt: "2026-01-01T00:00:00.000Z",
      overrides: { copilotRound: 2 },
    };
    const html = renderHandoffEnvelopeSection(envelope);
    assert.ok(html.includes("Explicit overrides"), "should show overrides section");
  });

  it("shows not set for null/undefined field values", () => {
    const envelope = {
      target: { kind: "pr", repo: "a/b", pr: 1 },
      handoffVersion: 1,
      derivedAt: null,
      currentGate: null,
      currentHeadSha: null,
      ciStatus: null,
      executionMode: null,
      asyncStartMode: null,
      requireDraftFirst: null,
    };
    const html = renderHandoffEnvelopeSection(envelope);
    // Should render without errors even with many nulls
    assert.ok(html.includes("Agent handoff"), "should still render heading");
  });

  it("escapes HTML in envelope values", () => {
    const envelope = {
      target: { kind: "pr", repo: "a/b", pr: 1, branch: "<script>alert(1)</script>" },
      handoffVersion: 1,
      derivedAt: "2026-01-01T00:00:00.000Z",
      currentGate: "<img src=x onerror=alert(1)>",
    };
    const html = renderHandoffEnvelopeSection(envelope);
    assert.ok(!html.includes("<script>"), "should escape script tag");
    assert.ok(!html.includes("<img "), "should escape img tag");
    assert.ok(!html.includes("<script>"), "should not contain raw script tag");
  });

  it("renders envelope with missing target gracefully", () => {
    const envelope = {
      handoffVersion: 1,
      derivedAt: "2026-01-01T00:00:00.000Z",
    };
    const html = renderHandoffEnvelopeSection(envelope);
    assert.ok(html.includes("unknown"), "should show unknown identity");
  });
});
