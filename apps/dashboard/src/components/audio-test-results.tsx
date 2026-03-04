"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { AudioTestEvidence } from "@/components/audio-evidence";
import { DiagnosticsPanel } from "@/components/diagnostics-panel";
import { AUDIO_TEST_REGISTRY, LEGACY_AUDIO_TEST_LABELS } from "@/lib/audio-test-registry";
import { cn } from "@/lib/utils";
import type { ScenarioResultRow, AudioTestResult, AudioTestName } from "@/lib/types";
import { formatDuration } from "@/lib/format";

interface AudioTestResultsProps {
  scenarios: ScenarioResultRow[];
}

const CURRENT_TEST_NAMES = new Set<string>(["audio_quality", "latency", "echo"]);

function isLegacyTest(testName: string): boolean {
  return !CURRENT_TEST_NAMES.has(testName);
}

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
  // Prefer metrics that have _ms suffix (latency) or boolean (pass/fail checks)
  const sorted = entries.sort(([a], [b]) => {
    const aScore = a.endsWith("_ms") ? 2 : typeof result.metrics[a] === "boolean" ? 1 : 0;
    const bScore = b.endsWith("_ms") ? 2 : typeof result.metrics[b] === "boolean" ? 1 : 0;
    return bScore - aScore;
  });
  return sorted.slice(0, 3);
}

export function AudioTestResults({ scenarios }: AudioTestResultsProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selectedScenario = selectedId
    ? scenarios.find((s) => s.id === selectedId)
    : null;

  // Separate current vs legacy
  const currentScenarios = scenarios.filter(
    (s) => !isLegacyTest((s.metrics_json as AudioTestResult).test_name)
  );
  const legacyScenarios = scenarios.filter(
    (s) => isLegacyTest((s.metrics_json as AudioTestResult).test_name)
  );

  return (
    <div>
      {/* Current probes */}
      {currentScenarios.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {currentScenarios.map((scenario) => {
            const result = scenario.metrics_json as AudioTestResult;
            const label = getTestLabel(result.test_name);
            const isCompleted = result.status === "completed" ||
              (result.status as string) === "pass";
            const isSelected = selectedId === scenario.id;
            const highlights = pickHighlightMetrics(result);

            return (
              <Card
                key={scenario.id}
                className={cn(
                  "border-l-[3px] cursor-pointer transition-all",
                  isCompleted ? "border-l-emerald-500" : "border-l-red-500",
                  isSelected
                    ? "ring-2 ring-ring bg-accent/30"
                    : "hover:bg-accent/20"
                )}
                onClick={() =>
                  setSelectedId(isSelected ? null : scenario.id)
                }
              >
                <CardContent className="py-4">
                  {/* Header */}
                  <div className="flex items-center justify-between mb-3">
                    <p className="text-[13px]">{label}</p>
                    <span
                      className={cn(
                        "text-[11px] font-medium px-1.5 py-0.5 rounded",
                        isCompleted
                          ? "text-emerald-700 dark:text-emerald-400 bg-emerald-500/10"
                          : "text-red-700 dark:text-red-400 bg-red-500/10"
                      )}
                    >
                      {isCompleted ? "Completed" : "Error"}
                    </span>
                  </div>

                  {/* Key metrics */}
                  <div className="space-y-1.5">
                    {highlights.map(([key, value]) => (
                      <div
                        key={key}
                        className="flex items-center justify-between text-xs"
                      >
                        <span className="text-muted-foreground capitalize">
                          {formatMetricKey(key)}
                        </span>
                        <span className="font-mono tabular-nums">
                          {formatMetricValue(key, value)}
                        </span>
                      </div>
                    ))}
                  </div>

                  {/* Duration */}
                  <p className="text-[11px] text-muted-foreground mt-3 tabular-nums">
                    {formatDuration(result.duration_ms)}
                  </p>

                  {/* Error indicator */}
                  {result.error && (
                    <p className="text-[11px] text-red-600 dark:text-red-400 mt-1.5 truncate">
                      {result.error}
                    </p>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Legacy test results (historical runs) */}
      {legacyScenarios.length > 0 && (
        <div className="mt-6">
          <div className="flex items-center gap-2 mb-3">
            <p className="text-xs text-muted-foreground uppercase tracking-wider font-medium">
              Legacy Tests
            </p>
            <span className="text-[10px] text-muted-foreground/60 bg-muted rounded px-1.5 py-0.5">
              historical run
            </span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {legacyScenarios.map((scenario) => {
              const result = scenario.metrics_json as AudioTestResult;
              const label = getTestLabel(result.test_name);
              const isPassed = (result.status as string) === "pass" || result.status === "completed";
              const isSelected = selectedId === scenario.id;
              const highlights = pickHighlightMetrics(result);

              return (
                <Card
                  key={scenario.id}
                  className={cn(
                    "border-l-[3px] cursor-pointer transition-all opacity-80",
                    isPassed ? "border-l-emerald-500" : "border-l-red-500",
                    isSelected
                      ? "ring-2 ring-ring bg-accent/30"
                      : "hover:bg-accent/20"
                  )}
                  onClick={() =>
                    setSelectedId(isSelected ? null : scenario.id)
                  }
                >
                  <CardContent className="py-4">
                    <div className="flex items-center justify-between mb-3">
                      <p className="text-[13px]">{label}</p>
                      <span
                        className={cn(
                          "text-[11px] font-medium px-1.5 py-0.5 rounded",
                          isPassed
                            ? "text-emerald-700 dark:text-emerald-400 bg-emerald-500/10"
                            : "text-red-700 dark:text-red-400 bg-red-500/10"
                        )}
                      >
                        {isPassed ? "Pass" : "Fail"}
                      </span>
                    </div>

                    <div className="space-y-1.5">
                      {highlights.map(([key, value]) => (
                        <div
                          key={key}
                          className="flex items-center justify-between text-xs"
                        >
                          <span className="text-muted-foreground capitalize">
                            {formatMetricKey(key)}
                          </span>
                          <span className="font-mono tabular-nums">
                            {formatMetricValue(key, value)}
                          </span>
                        </div>
                      ))}
                    </div>

                    <p className="text-[11px] text-muted-foreground mt-3 tabular-nums">
                      {formatDuration(result.duration_ms)}
                    </p>

                    {result.error && (
                      <p className="text-[11px] text-red-600 dark:text-red-400 mt-1.5 truncate">
                        {result.error}
                      </p>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>
      )}

      {/* Detail panel -- appears below the grid when a card is selected */}
      {selectedScenario && (
        <div className="mt-5 animate-fade-in">
          <AudioTestDetailPanel scenario={selectedScenario} />
        </div>
      )}
    </div>
  );
}

function AudioTestDetailPanel({
  scenario,
}: {
  scenario: ScenarioResultRow;
}) {
  const result = scenario.metrics_json as AudioTestResult;
  const label = getTestLabel(result.test_name);
  const isLegacy = isLegacyTest(result.test_name);
  const meta = !isLegacy
    ? AUDIO_TEST_REGISTRY[result.test_name as AudioTestName]
    : null;

  return (
    <Card>
      <CardContent className="py-5 space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2">
              <p className="text-sm font-semibold">{label}</p>
              {isLegacy && (
                <span className="text-[10px] text-muted-foreground/60 bg-muted rounded px-1.5 py-0.5">
                  legacy
                </span>
              )}
            </div>
            {meta?.description && (
              <p className="text-xs text-muted-foreground mt-0.5">
                {meta.description}
              </p>
            )}
          </div>
          <span className="text-xs text-muted-foreground tabular-nums">
            {formatDuration(result.duration_ms)}
          </span>
        </div>

        {/* Error */}
        {result.error && (
          <div className="rounded-md bg-red-500/5 border border-red-500/20 px-3 py-2">
            <p className="text-sm text-red-600 dark:text-red-400 font-mono">
              {result.error}
            </p>
          </div>
        )}

        {/* Transcriptions */}
        {result.transcriptions && Object.keys(result.transcriptions).length > 0 && (
          <div>
            <p className="text-[11px] text-muted-foreground uppercase tracking-wider mb-2">
              Transcriptions
            </p>
            <div className="space-y-2">
              {Object.entries(result.transcriptions).map(([key, value]) => (
                <div key={key} className="rounded-md bg-muted/30 px-3 py-2">
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">
                    {key.replace(/_/g, " ")}
                  </p>
                  <p className="text-sm font-mono">
                    {value === null
                      ? "--"
                      : Array.isArray(value)
                        ? value.join(" | ")
                        : value}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Evidence visualization */}
        <AudioTestEvidence result={result} />

        {/* All metrics */}
        {Object.keys(result.metrics).length > 0 && (
          <div>
            <p className="text-[11px] text-muted-foreground uppercase tracking-wider mb-2">
              All Metrics
            </p>
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(result.metrics).map(([key, value]) => (
                <span
                  key={key}
                  className="inline-flex items-center rounded-md bg-muted px-2 py-0.5 text-xs font-mono"
                >
                  {formatMetricKey(key)}: {formatMetricValue(key, value)}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Diagnostics */}
        {result.diagnostics && (
          <DiagnosticsPanel diagnostics={result.diagnostics} />
        )}
      </CardContent>
    </Card>
  );
}
