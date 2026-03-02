import { Card, CardContent } from "@/components/ui/card";
import { StatusBadge } from "@/components/status-badge";
import type { ScenarioResultRow, AudioTestResult } from "@/lib/types";
import { formatDuration } from "@/lib/format";

interface AudioTestResultsProps {
  scenarios: ScenarioResultRow[];
}

const TEST_LABELS: Record<string, string> = {
  echo: "Echo Detection",
  barge_in: "Barge-in Handling",
  ttfb: "Time to First Byte",
  silence_handling: "Silence Handling",
  connection_stability: "Connection Stability",
  response_completeness: "Response Completeness",
  noise_resilience: "Noise Resilience",
  endpointing: "Endpointing",
  audio_quality: "Audio Quality",
};

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

export function AudioTestResults({ scenarios }: AudioTestResultsProps) {
  return (
    <div>
      <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-3">
        Audio Tests
      </h3>
      <div className="space-y-2">
        {scenarios.map((scenario) => {
          const result = scenario.metrics_json as AudioTestResult;
          return (
            <Card key={scenario.id}>
              <CardContent className="py-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <StatusBadge status={result.status} />
                    <div>
                      <p className="text-sm font-medium">
                        {TEST_LABELS[result.test_name] ?? result.test_name}
                      </p>
                      {result.error && (
                        <p className="text-xs text-destructive mt-0.5">
                          {result.error}
                        </p>
                      )}
                    </div>
                  </div>
                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    {formatDuration(result.duration_ms)}
                  </span>
                </div>
                {Object.keys(result.metrics).length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {Object.entries(result.metrics).map(([key, value]) => (
                      <span
                        key={key}
                        className="inline-flex items-center rounded-md bg-muted px-2 py-0.5 text-xs font-mono"
                      >
                        {formatMetricKey(key)}: {formatMetricValue(key, value)}
                      </span>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
