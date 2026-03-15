import {
  DEFAULT_HEALTH_TIMEOUT_MS,
  DEFAULT_HEALTH_INTERVAL_MS,
} from "@vent/shared";

export async function waitForHealth(
  url: string,
  timeoutMs: number = DEFAULT_HEALTH_TIMEOUT_MS,
  intervalMs: number = DEFAULT_HEALTH_INTERVAL_MS
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) {
        return;
      }
    } catch {
      // Agent not ready yet
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Agent health check timed out after ${timeoutMs}ms at ${url}`);
}
