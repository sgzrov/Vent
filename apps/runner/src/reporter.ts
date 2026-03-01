import { RUNNER_CALLBACK_HEADER, withRetry } from "@voiceci/shared";
import type { AudioTestResult, ConversationTestResult, RunAggregateV2 } from "@voiceci/shared";

export interface RunResults {
  run_id: string;
  status: "pass" | "fail";
  audio_results: AudioTestResult[];
  conversation_results: ConversationTestResult[];
  aggregate: RunAggregateV2;
  error_text?: string;
}

export async function reportResults(results: RunResults): Promise<void> {
  const callbackUrl = process.env["API_CALLBACK_URL"];
  if (!callbackUrl) {
    throw new Error("API_CALLBACK_URL is required");
  }

  const secret = process.env["RUNNER_CALLBACK_SECRET"] ?? "";

  await withRetry(async () => {
    const response = await fetch(callbackUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [RUNNER_CALLBACK_HEADER]: secret,
      },
      body: JSON.stringify(results),
    });

    if (!response.ok) {
      if (response.status === 408 || response.status === 429 || response.status >= 500) {
        throw Object.assign(
          new Error(`Result callback retryable (${response.status})`),
          { retryable: true },
        );
      }
      const text = await response.text();
      throw new Error(`Failed to report results: ${response.status} ${text}`);
    }
  }, { maxRetries: 3, baseDelayMs: 1000 });

  console.log("Results reported successfully");
}

export interface TestProgressPayload {
  run_id: string;
  completed: number;
  total: number;
  test_type: "audio" | "conversation";
  test_name: string;
  status: "pass" | "fail";
  duration_ms: number;
  /** Full test result for incremental DB insertion */
  result?: Record<string, unknown>;
}

export interface RunEventPayload {
  run_id: string;
  event_type: string;
  message: string;
  metadata_json?: Record<string, unknown>;
}

export async function reportRunEvent(payload: RunEventPayload): Promise<void> {
  const callbackUrl = process.env["API_CALLBACK_URL"];
  if (!callbackUrl) return;

  const secret = process.env["RUNNER_CALLBACK_SECRET"] ?? "";
  const eventUrl = callbackUrl.replace(/\/runner-callback$/, "/run-event");

  try {
    await fetch(eventUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [RUNNER_CALLBACK_HEADER]: secret,
      },
      body: JSON.stringify(payload),
    });
  } catch {
    // Best-effort — don't fail the run if event reporting fails
  }
}

export async function reportTestProgress(payload: TestProgressPayload): Promise<void> {
  const callbackUrl = process.env["API_CALLBACK_URL"];
  if (!callbackUrl) return;

  const secret = process.env["RUNNER_CALLBACK_SECRET"] ?? "";
  // Derive the progress endpoint from the callback URL
  const progressUrl = callbackUrl.replace(/\/runner-callback$/, "/test-progress");

  try {
    await fetch(progressUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [RUNNER_CALLBACK_HEADER]: secret,
      },
      body: JSON.stringify(payload),
    });
  } catch {
    // Best-effort — don't fail the run if progress reporting fails
  }
}
