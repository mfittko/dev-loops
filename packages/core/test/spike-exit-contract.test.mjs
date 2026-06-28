import assert from "node:assert/strict";
import test, { describe } from "node:test";

import {
  evaluateSpikeExit,
  buildGraduatedPlanBody,
  SPIKE_EXIT_DISPOSITION,
  SPIKE_EXIT_ACTION,
} from "../src/loop/spike-exit-contract.mjs";
import { SPIKE_INTAKE_STATE } from "../src/loop/spike-intake-contract.mjs";
import { validatePlanFile } from "../../../scripts/refine/validate-plan-file.mjs";

const READY = SPIKE_INTAKE_STATE.SPIKE_READY_FOR_EXIT;

describe("evaluateSpikeExit (pure)", () => {
  test("discard from ready state is eligible with the discard action", () => {
    const result = evaluateSpikeExit({
      spikeIntakeState: READY,
      disposition: SPIKE_EXIT_DISPOSITION.DISCARD,
    });
    assert.equal(result.ok, true);
    assert.equal(result.action, SPIKE_EXIT_ACTION.DISCARD);
  });

  test("graduate from ready state is eligible with the graduate action", () => {
    const result = evaluateSpikeExit({
      spikeIntakeState: READY,
      disposition: SPIKE_EXIT_DISPOSITION.GRADUATE,
    });
    assert.equal(result.ok, true);
    assert.equal(result.action, SPIKE_EXIT_ACTION.GRADUATE);
  });

  test("fail closed on an unknown disposition", () => {
    const result = evaluateSpikeExit({
      spikeIntakeState: READY,
      disposition: "promote-to-prod",
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "unknown_disposition");
  });

  test("fail closed on a missing disposition", () => {
    const result = evaluateSpikeExit({ spikeIntakeState: READY });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "unknown_disposition");
  });

  test("fail closed when the spike is not ready for exit (in progress)", () => {
    const result = evaluateSpikeExit({
      spikeIntakeState: SPIKE_INTAKE_STATE.SPIKE_IN_PROGRESS,
      disposition: SPIKE_EXIT_DISPOSITION.GRADUATE,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "not_ready_for_exit");
    assert.equal(result.spikeIntakeState, SPIKE_INTAKE_STATE.SPIKE_IN_PROGRESS);
  });

  test("fail closed when the spike artifact is ambiguous", () => {
    const result = evaluateSpikeExit({
      spikeIntakeState: SPIKE_INTAKE_STATE.AMBIGUOUS_FAIL_CLOSED,
      disposition: SPIKE_EXIT_DISPOSITION.DISCARD,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "not_ready_for_exit");
  });

  test("fail closed on a missing state", () => {
    const result = evaluateSpikeExit({ disposition: SPIKE_EXIT_DISPOSITION.DISCARD });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "not_ready_for_exit");
  });
});

describe("buildGraduatedPlanBody (pure)", () => {
  const SECTIONS = {
    question: "Can we cache the slow API responses to cut p95 latency?",
    approach: "Prototyped an in-process LRU in front of the fetch path.",
    findings: "An LRU(1000) cut p95 by 60% with no correctness regressions.",
    recommendation: "Adopt the in-process LRU on the fetch path behind a config flag.",
  };

  test("emitted body passes validatePlanFile (base sections present)", () => {
    const body = buildGraduatedPlanBody(SECTIONS);
    const result = validatePlanFile(body);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
  });

  test("emitted body carries the spike content (question/findings/recommendation)", () => {
    const body = buildGraduatedPlanBody(SECTIONS);
    assert.match(body, /## Status/u);
    assert.match(body, /## Objective/u);
    assert.match(body, /## In scope/u);
    assert.match(body, /## Explicit non-goals/u);
    assert.match(body, /cache the slow API responses/u);
    assert.match(body, /cut p95 by 60%/u);
    assert.match(body, /Adopt the in-process LRU/u);
  });

  test("idempotent: same input yields identical output", () => {
    assert.equal(buildGraduatedPlanBody(SECTIONS), buildGraduatedPlanBody(SECTIONS));
  });

  test("fail closed: throws when the Recommendation is empty", () => {
    assert.throws(
      () => buildGraduatedPlanBody({ ...SECTIONS, recommendation: "  " }),
      /recommendation/iu,
    );
  });

  test("fail closed: throws when the Question is empty", () => {
    assert.throws(
      () => buildGraduatedPlanBody({ ...SECTIONS, question: "" }),
      /question/iu,
    );
  });
});
