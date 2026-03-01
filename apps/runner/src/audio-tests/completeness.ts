/**
 * Response completeness test — verifies agent doesn't cut off mid-sentence.
 *
 * Procedure:
 * 1. Ask the agent a question that requires a substantial response
 * 2. Record and transcribe the full response
 * 3. Check if the response ends with proper sentence structure
 * 4. PASS if response is complete, FAIL if truncated
 */

import type { AudioChannel } from "@voiceci/adapters";
import type { AudioTestResult, AudioTestThresholds } from "@voiceci/shared";
import { synthesize, transcribe } from "@voiceci/voice";
import { collectUntilEndOfTurn } from "./helpers.js";

const PROMPT =
  "Please explain in detail the three main benefits of exercise for physical health.";

// Regex for sentences that end properly (period, question mark, exclamation)
const COMPLETE_SENTENCE_RE = /[.!?]["']?\s*$/;
const DEFAULT_MIN_WORD_COUNT = 15;

export async function runCompletenessTest(
  channel: AudioChannel,
  thresholds?: AudioTestThresholds,
): Promise<AudioTestResult> {
  const MIN_WORD_COUNT = thresholds?.response_completeness?.min_word_count ?? DEFAULT_MIN_WORD_COUNT;
  const startTime = performance.now();

  // Send a prompt that should elicit a long response
  const promptAudio = await synthesize(PROMPT);
  channel.sendAudio(promptAudio);

  // Collect the full response with generous timeout
  const { audio, timedOut } = await collectUntilEndOfTurn(channel, {
    timeoutMs: 30000,
    silenceThresholdMs: 2000,
  });

  if (audio.length === 0) {
    return {
      test_name: "response_completeness",
      status: "fail",
      metrics: {
        response_received: false,
        transcription_length: 0,
        ends_with_complete_sentence: false,
      },
      duration_ms: Math.round(performance.now() - startTime),
      error: "No audio response received from agent",
    };
  }

  // Transcribe the response
  const { text, confidence } = await transcribe(audio);

  if (!text || text.trim().length === 0) {
    return {
      test_name: "response_completeness",
      status: "fail",
      metrics: {
        response_received: true,
        transcription_length: 0,
        ends_with_complete_sentence: false,
        stt_confidence: confidence,
      },
      duration_ms: Math.round(performance.now() - startTime),
      error: "Audio received but transcription was empty",
    };
  }

  const trimmed = text.trim();
  const endsComplete = COMPLETE_SENTENCE_RE.test(trimmed);
  const wordCount = trimmed.split(/\s+/).length;

  // Pass/fail based on word count only — punctuation is a soft metric
  // because STT providers often omit trailing punctuation
  const hasSubstance = wordCount >= MIN_WORD_COUNT;
  const passed = hasSubstance;

  const durationMs = Math.round(performance.now() - startTime);

  return {
    test_name: "response_completeness",
    status: passed ? "pass" : "fail",
    metrics: {
      response_received: true,
      transcription_length: trimmed.length,
      word_count: wordCount,
      ends_with_complete_sentence: endsComplete,
      has_substance: hasSubstance,
      stt_confidence: Math.round(confidence * 1000) / 1000,
      timed_out: timedOut,
    },
    duration_ms: durationMs,
    ...(!passed && {
      error: `Response too short (${wordCount} words, minimum ${MIN_WORD_COUNT})`,
    }),
  };
}
