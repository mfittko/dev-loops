import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { DebtSignalSchema } from "../src/debt/debt-signal.mjs";
import {
  extractDeepPersonaSignals,
  getDeepPersonaFlagPhrases,
  verifyPromptStability,
} from "../src/debt/deep-persona-signals.mjs";
import { parseReviewThreads, parseJsonText } from "../src/github/review-threads.mjs";
import {
  parseArgs,
  outputFilename as cliOutputFilename,
} from "../bin/capture-deep-persona-signals.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, "fixtures", "github", "review-threads", "deep-persona-threads.json");

const PR_META = { prNumber: "412", prUrl: "https://github.com/mfittko/dev-loops/pull/412" };

// ============================================================================
// Helpers
// ============================================================================

async function loadAndParseFixture() {
  const raw = await readFile(FIXTURE_PATH, "utf8");
  const json = parseJsonText(raw);
  return parseReviewThreads(json);
}

// ============================================================================
// Tests
// ============================================================================

describe("deep-persona signal extraction", () => {
  describe("mixed-thread identification", () => {
    test("only bot-authored comments with deep-persona patterns are extracted", async () => {
      const parsed = await loadAndParseFixture();
      const signals = extractDeepPersonaSignals(parsed, PR_META);

      assert.equal(signals.length, 6, "Expected 6 deep-persona signals");
    });

    test("human comments are never extracted", async () => {
      const parsed = await loadAndParseFixture();
      const signals = extractDeepPersonaSignals(parsed, PR_META);

      const humanSignals = signals.filter(
        (s) => s.rawPayload?.metadata?.commentId === "c-human-a",
      );
      assert.equal(humanSignals.length, 0, "Human comment should not be extracted");
    });

    test("non-deep bot comments without matching patterns are not extracted", async () => {
      const parsed = await loadAndParseFixture();
      const signals = extractDeepPersonaSignals(parsed, PR_META);

      const nonDeepSignals = signals.filter(
        (s) => s.rawPayload?.metadata?.commentId === "c-bot-nondeep",
      );
      assert.equal(nonDeepSignals.length, 0, "Non-deep bot comment should not be extracted");
    });

    test("resolved thread comments are still extracted", async () => {
      const parsed = await loadAndParseFixture();
      const signals = extractDeepPersonaSignals(parsed, PR_META);

      const resolvedSignal = signals.find(
        (s) => s.rawPayload?.metadata?.commentId === "c-deep-d",
      );
      assert.ok(resolvedSignal, "Resolved thread comment should be extracted");
      assert.equal(resolvedSignal.rawPayload.metadata.isResolved, true);
    });
  });

  describe("category mapping", () => {
    test("file_size: crossing 1000 lines pattern", async () => {
      const parsed = await loadAndParseFixture();
      const signals = extractDeepPersonaSignals(parsed, PR_META);

      const fileSizeSignal = signals.find(
        (s) => s.rawPayload?.metadata?.commentId === "c-deep-a",
      );
      assert.ok(fileSizeSignal, "file_size signal should be found");
      assert.equal(fileSizeSignal.signalKind, "file_size");
      assert.equal(fileSizeSignal.severityHint, "high");
      assert.equal(fileSizeSignal.confidence, 0.9);
    });

    test("spaghetti_branching: conditionals bolted onto unrelated paths", async () => {
      const parsed = await loadAndParseFixture();
      const signals = extractDeepPersonaSignals(parsed, PR_META);

      const spaghettiSignal = signals.find(
        (s) => s.rawPayload?.metadata?.commentId === "c-deep-b",
      );
      assert.ok(spaghettiSignal, "spaghetti_branching signal should be found");
      assert.equal(spaghettiSignal.signalKind, "spaghetti_branching");
      assert.equal(spaghettiSignal.severityHint, "high");
    });

    test("thin_wrapper: thin wrapper pattern", async () => {
      const parsed = await loadAndParseFixture();
      const signals = extractDeepPersonaSignals(parsed, PR_META);

      const thinSignal = signals.find(
        (s) => s.rawPayload?.metadata?.commentId === "c-deep-c",
      );
      assert.ok(thinSignal, "thin_wrapper signal should be found");
      assert.equal(thinSignal.signalKind, "thin_wrapper");
      assert.equal(thinSignal.severityHint, "medium");
    });

    test("leaky_feature_logic: leaking into shared pattern", async () => {
      const parsed = await loadAndParseFixture();
      const signals = extractDeepPersonaSignals(parsed, PR_META);

      const leakySignal = signals.find(
        (s) => s.rawPayload?.metadata?.commentId === "c-deep-d",
      );
      assert.ok(leakySignal, "leaky_feature_logic signal should be found");
      assert.equal(leakySignal.signalKind, "leaky_feature_logic");
      assert.equal(leakySignal.severityHint, "high");
    });

    test("weak_contract: cast-heavy and any-typed contracts", async () => {
      const parsed = await loadAndParseFixture();
      const signals = extractDeepPersonaSignals(parsed, PR_META);

      const weakSignal = signals.find(
        (s) => s.rawPayload?.metadata?.commentId === "c-deep-e",
      );
      assert.ok(weakSignal, "weak_contract signal should be found");
      assert.equal(weakSignal.signalKind, "weak_contract");
      assert.equal(weakSignal.severityHint, "medium");
    });

    test("simplification_opportunity: code judo and prefer deletion", async () => {
      const parsed = await loadAndParseFixture();
      const signals = extractDeepPersonaSignals(parsed, PR_META);

      const simplificationSignal = signals.find(
        (s) => s.rawPayload?.metadata?.commentId === "c-deep-f",
      );
      assert.ok(simplificationSignal, "simplification_opportunity signal should be found");
      assert.equal(simplificationSignal.signalKind, "simplification_opportunity");
      assert.equal(simplificationSignal.severityHint, "medium");
    });
  });

  describe("location extraction", () => {
    test("file path extracted from comment body", async () => {
      const parsed = await loadAndParseFixture();
      const signals = extractDeepPersonaSignals(parsed, PR_META);

      const fileSizeSignal = signals.find(
        (s) => s.rawPayload?.metadata?.commentId === "c-deep-a",
      );
      assert.ok(fileSizeSignal);
      assert.equal(
        fileSizeSignal.location.filePath,
        "packages/core/src/loop/conductor.mjs",
      );
    });

    test("empty location when no file path in comment", async () => {
      const parsed = await loadAndParseFixture();
      const signals = extractDeepPersonaSignals(parsed, PR_META);

      const spaghettiSignal = signals.find(
        (s) => s.rawPayload?.metadata?.commentId === "c-deep-b",
      );
      assert.ok(spaghettiSignal);
      assert.deepEqual(spaghettiSignal.location, {});
    });
  });

  describe("schema compatibility", () => {
    test("generated signals validate against DebtSignalSchema", async () => {
      const parsed = await loadAndParseFixture();
      const signals = extractDeepPersonaSignals(parsed, PR_META);

      assert.ok(signals.length > 0, "Should have at least one signal");
      for (const signal of signals) {
        // parse() is used now — throws on failure, so reaching here is validation
        DebtSignalSchema.parse(signal);
      }
    });

    test("all required fields are present in generated signals", async () => {
      const parsed = await loadAndParseFixture();
      const signals = extractDeepPersonaSignals(parsed, PR_META);

      const firstSignal = signals[0];
      assert.ok(typeof firstSignal.id === "string" && firstSignal.id.length > 0, "id required");
      assert.equal(firstSignal.sourceType, "pr_review_deep_persona", "sourceType required");
      assert.ok(typeof firstSignal.signalKind === "string" && firstSignal.signalKind.length > 0, "signalKind required");
      assert.ok(typeof firstSignal.location === "object" && firstSignal.location !== null, "location required");
      assert.ok(["info", "low", "medium", "high", "critical"].includes(firstSignal.severityHint), "severityHint required and valid");
      assert.ok(typeof firstSignal.timestamp === "string", "timestamp required");
    });

    test("metadata includes prNumber, prUrl, commentId, threadId, isResolved, category, matchedPhrase", async () => {
      const parsed = await loadAndParseFixture();
      const signals = extractDeepPersonaSignals(parsed, PR_META);

      const firstSignal = signals[0];
      const meta = firstSignal.rawPayload?.metadata;
      assert.ok(meta, "metadata should exist in rawPayload");
      assert.equal(meta.prNumber, "412");
      assert.equal(meta.prUrl, "https://github.com/mfittko/dev-loops/pull/412");
      assert.ok(typeof meta.commentId === "string");
      assert.ok(typeof meta.threadId === "string");
      assert.ok(typeof meta.isResolved === "boolean");
      assert.ok(typeof meta.category === "string");
      assert.ok(meta.matchedPhrase !== null && meta.matchedPhrase !== undefined);
    });

    test("schema rejects signal with missing required field", () => {
      const badSignal = {
        sourceType: "pr_review_deep_persona",
        signalKind: "file_size",
        location: {},
        severityHint: "high",
        timestamp: "2026-06-03T12:00:00Z",
      };
      const result = DebtSignalSchema.safeParse(badSignal);
      assert.equal(result.success, false);
      if (!result.success) {
        assert.ok(
          result.error.issues.some((i) => i.path.includes("id")),
          "Should flag missing id",
        );
      }
    });
  });

  describe("CLI args parsing", () => {
    test("valid flags parse correctly", () => {
      const opts = parseArgs([
        "--input", "test.json",
        "--pr-number", "42",
        "--pr-url", "https://github.com/owner/repo/pull/42",
      ]);
      assert.equal(opts.inputPath, "test.json");
      assert.equal(opts.prNumber, "42");
      assert.equal(opts.prUrl, "https://github.com/owner/repo/pull/42");
      assert.equal(opts.outputDir, ".pi/debt/signals");
    });

    test("valid flags with custom output-dir parse correctly", () => {
      const opts = parseArgs([
        "--input", "test.json",
        "--pr-number", "42",
        "--pr-url", "https://github.com/owner/repo/pull/42",
        "--output-dir", "custom/path",
      ]);
      assert.equal(opts.inputPath, "test.json");
      assert.equal(opts.prNumber, "42");
      assert.equal(opts.prUrl, "https://github.com/owner/repo/pull/42");
      assert.equal(opts.outputDir, "custom/path");
    });

    test("missing required --input throws", () => {
      assert.throws(
        () => parseArgs(["--pr-number", "42", "--pr-url", "https://example.com"]),
        /--input is required/,
      );
    });

    test("missing required --pr-number throws", () => {
      assert.throws(
        () => parseArgs(["--input", "test.json", "--pr-url", "https://example.com"]),
        /--pr-number is required/,
      );
    });

    test("missing required --pr-url throws", () => {
      assert.throws(
        () => parseArgs(["--input", "test.json", "--pr-number", "42"]),
        /--pr-url is required/,
      );
    });

    test("unknown flag throws", () => {
      assert.throws(
        () => parseArgs(["--input", "test.json", "--pr-number", "42", "--pr-url", "https://example.com", "--unknown"]),
        /Unknown argument/,
      );
    });

    test("missing value for flagged option throws", () => {
      assert.throws(
        () => parseArgs(["--input", "--pr-number", "42", "--pr-url", "https://example.com"]),
        /Missing value for --input/,
      );
    });

    test("non-numeric pr-number throws", () => {
      assert.throws(
        () => parseArgs(["--input", "test.json", "--pr-number", "abc", "--pr-url", "https://example.com"]),
        /--pr-number must be a positive integer/,
      );
    });
  });

  describe("output path generation", () => {
    test("outputFilename includes prNumber", () => {
      const filename = cliOutputFilename("42");
      assert.ok(filename.startsWith("deep-persona-signals-42-"));
      assert.ok(filename.endsWith(".json"));
    });

    test("outputFilename has stable structure (prefix, prNumber, timestamp, .json)", () => {
      const filename = cliOutputFilename("42");
      const parts = filename.split("-");
      assert.ok(parts.length >= 5);
      assert.equal(parts[0], "deep");
      assert.equal(parts[1], "persona");
      assert.equal(parts[2], "signals");
      assert.equal(parts[3], "42");
    });
  });

  describe("end-to-end fixture flow", () => {
    test("fixture → parse → extract → validate completes without error", async () => {
      const parsed = await loadAndParseFixture();
      const signals = extractDeepPersonaSignals(parsed, PR_META);

      assert.equal(signals.length, 6, "Should extract 6 signals from fixture");

      for (const signal of signals) {
        DebtSignalSchema.parse(signal);
      }

      const kinds = new Set(signals.map((s) => s.signalKind));
      assert.ok(kinds.size >= 5, "Should cover at least 5 distinct categories");
    });
  });

  describe("persona prompt stability guard", () => {
    test("getDeepPersonaFlagPhrases returns known phrase sources", () => {
      const phrases = getDeepPersonaFlagPhrases();
      assert.ok(Array.isArray(phrases));
      assert.ok(phrases.length >= 13, "Should have at least 13 known flag phrases");
      for (const phrase of phrases) {
        assert.ok(typeof phrase === "string" && phrase.length > 0);
      }
    });

    test("verifyPromptStability: all flag phrase regex patterns match the deep persona prompt", async () => {
      const missing = await verifyPromptStability();
      assert.deepEqual(
        missing,
        [],
        "All flag phrase regex patterns must match the deep persona prompt. " +
        "Missing (prompt drift): " + JSON.stringify(missing) +
        ". Update FLAG_PATTERNS or the deep persona prompt to realign."
      );
    });
  });

  describe("edge cases", () => {
    test("empty comments array returns empty signals", () => {
      const signals = extractDeepPersonaSignals({ comments: [] }, PR_META);
      assert.deepEqual(signals, []);
    });

    test("empty body in comment is handled", () => {
      const parsed = {
        comments: [
          {
            id: "c-1",
            threadId: "t-1",
            author: { login: "copilot-pull-request-reviewer[bot]", type: "Bot", isBot: true },
            body: "",
            isActionable: true,
          },
        ],
      };
      const signals = extractDeepPersonaSignals(parsed, PR_META);
      assert.deepEqual(signals, []);
    });

    test("invalid parsed output throws", () => {
      assert.throws(
        () => extractDeepPersonaSignals(null, PR_META),
        /Invalid parsed output/,
      );
      assert.throws(
        () => extractDeepPersonaSignals({}, PR_META),
        /Invalid parsed output/,
      );
    });

    test("spaghetti keyword matches without full phrase", () => {
      const parsed = {
        comments: [
          {
            id: "c-spaghetti",
            threadId: "t-1",
            author: { login: "copilot-pull-request-reviewer[bot]", type: "Bot", isBot: true },
            body: "This module has spaghetti code that needs refactoring.",
            isActionable: true,
          },
        ],
      };
      const signals = extractDeepPersonaSignals(parsed, PR_META);
      assert.equal(signals.length, 1);
      assert.equal(signals[0].signalKind, "spaghetti_branching");
    });
  });
});
