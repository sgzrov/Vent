"use client";

import { Card, CardContent } from "@/components/ui/card";
import { AUDIO_TEST_REGISTRY, LEGACY_AUDIO_TEST_LABELS } from "@/lib/audio-test-registry";
import { cn } from "@/lib/utils";
import type { ScenarioResultRow, AudioTestResult, AudioTestName } from "@/lib/types";

interface AudioMetricConclusionsProps {
  scenarios: ScenarioResultRow[];
}

const CURRENT_TEST_NAMES = new Set<string>(["audio_quality", "latency", "echo"]);

function getTestLabel(testName: string): string {
  if (CURRENT_TEST_NAMES.has(testName)) {
    return AUDIO_TEST_REGISTRY[testName as AudioTestName]?.label ?? testName;
  }
  return LEGACY_AUDIO_TEST_LABELS[testName] ?? testName;
}

function formatMetricKey(key: string): string {
  return key
    .replace(/_ms$/, "")
    .replace(/_/g, " ")
    .replace(/\b(ttfb)\b/gi, "TTFB");
}

function formatMetricValue(key: string, value: number | boolean): string {
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (key.endsWith("_ms")) return `${Math.round(value)}ms`;
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(2);
}

function pickHighlightMetrics(
  result: AudioTestResult
): [string, number | boolean][] {
  const entries = Object.entries(result.metrics);
  const sorted = entries.sort(([a], [b]) => {
    const aScore = a.endsWith("_ms") ? 2 : typeof result.metrics[a] === "boolean" ? 1 : 0;
    const bScore = b.endsWith("_ms") ? 2 : typeof result.metrics[b] === "boolean" ? 1 : 0;
    return bScore - aScore;
  });
  return sorted.slice(0, 2);
}

export function AudioMetricConclusions({
  scenarios,
}: AudioMetricConclusionsProps) {
  if (scenarios.length === 0) return null;

  return (
    <Card>
      <CardContent className="py-4">
        <div className="mb-3">
          <p className="text-[11px] text-muted-foreground uppercase tracking-wider">
            Infrastructure Probe Results
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            Key metric outcomes from each infrastructure probe.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {scenarios.map((scenario) => {
            const result = scenario.metrics_json as AudioTestResult;
            const label = getTestLabel(result.test_name);
            const highlights = pickHighlightMetrics(result);
            const isCompleted = result.status === "completed" ||
              (result.status as string) === "pass";
            const isLegacy = !CURRENT_TEST_NAMES.has(result.test_name);

            return (
              <div
                key={scenario.id}
                className={cn(
                  "rounded-md border bg-background px-3 py-2.5",
                  isLegacy && "opacity-80"
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <p className="text-sm">{label}</p>
                    {isLegacy && (
                      <span className="text-[9px] text-muted-foreground/50 bg-muted rounded px-1 py-0.5">
                        legacy
                      </span>
                    )}
                  </div>
                  <span
                    className={cn(
                      "text-[11px] font-medium px-1.5 py-0.5 rounded",
                      isCompleted
                        ? "text-emerald-700 dark:text-emerald-400 bg-emerald-500/10"
                        : "text-red-700 dark:text-red-400 bg-red-500/10"
                    )}
                  >
                    {isLegacy
                      ? isCompleted ? "Pass" : "Fail"
                      : isCompleted ? "Completed" : "Error"}
                  </span>
                </div>

                <div className="flex flex-wrap gap-1.5 mt-2">
                  {highlights.map(([key, value]) => (
                    <span
                      key={key}
                      className="inline-flex items-center rounded-md bg-muted px-2 py-0.5 text-xs font-mono"
                    >
                      {formatMetricKey(key)}: {formatMetricValue(key, value)}
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
