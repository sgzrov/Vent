"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/status-badge";
import { MetricCards } from "@/components/metric-cards";
import { AudioTestResults } from "@/components/audio-test-results";
import { ConversationTestResults } from "@/components/conversation-test-results";
import { TestConfigSection } from "@/components/test-config-section";
import type { RunDetail, RunAggregateV2, RunEventRow } from "@/lib/types";
import { truncateId, formatTimestamp } from "@/lib/format";
import { RunTimeline } from "@/components/run-timeline";

function redactErrorText(text: string): string {
  const replacements: Array<[RegExp, string]> = [
    [/\bBearer\s+[A-Za-z0-9._-]+\b/gi, "Bearer [REDACTED]"],
    [/\b(sk|rk|pk)_[A-Za-z0-9_-]+\b/g, "[REDACTED_KEY]"],
    [/\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*["']?[^"'\s]+/gi, "$1=[REDACTED]"],
  ];

  let sanitized = text;
  for (const [pattern, replacement] of replacements) {
    sanitized = sanitized.replace(pattern, replacement);
  }

  const MAX_ERROR_LENGTH = 600;
  if (sanitized.length > MAX_ERROR_LENGTH) {
    return `${sanitized.slice(0, MAX_ERROR_LENGTH)}... [truncated]`;
  }
  return sanitized;
}

interface RunDetailViewProps {
  run: RunDetail;
  events?: RunEventRow[];
  isStreaming?: boolean;
  onSetBaseline?: () => void;
  isDemo?: boolean;
}

export function RunDetailView({
  run,
  events,
  isStreaming = false,
  onSetBaseline,
  isDemo,
}: RunDetailViewProps) {
  const aggregate = run.aggregate_json as RunAggregateV2 | null;
  const timelineEvents = events ?? run.events ?? [];
  const audioScenarios = run.scenarios.filter(
    (s) => s.test_type === "audio"
  );
  const conversationScenarios = run.scenarios.filter(
    (s) => s.test_type === "conversation"
  );

  return (
    <div className="space-y-6">
      {/* Demo banner */}
      {isDemo && (
        <div className="rounded-md bg-amber-50 border border-amber-200 px-4 py-2.5">
          <p className="text-sm text-amber-700">
            This is a demo run with example data. Trigger a real test from your
            code editor via the VoiceCI MCP server.
          </p>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <StatusBadge status={run.status} size="lg" />
          <div>
            <h1 className="text-xl font-bold font-mono">
              {truncateId(run.id, 12)}
              {!isDemo && "..."}
            </h1>
            <p className="text-sm text-muted-foreground">
              {formatTimestamp(run.created_at)}
              {run.bundle_hash && (
                <span className="ml-2 font-mono opacity-60">
                  {truncateId(run.bundle_hash)}
                </span>
              )}
            </p>
          </div>
        </div>
        {!isDemo && (
          <div className="flex gap-2">
            {run.is_baseline ? (
              <Button variant="outline" size="sm" disabled>
                Baseline
              </Button>
            ) : (run.status === "pass" || run.status === "fail") &&
              onSetBaseline ? (
              <Button variant="outline" size="sm" onClick={onSetBaseline}>
                Set as Baseline
              </Button>
            ) : null}
          </div>
        )}
      </div>

      {/* Error */}
      {run.error_text && (
        <Card className="border-destructive">
          <CardContent className="py-4">
            <p className="text-sm text-destructive font-mono">
              {redactErrorText(run.error_text)}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Timeline */}
      {(timelineEvents.length > 0 || isStreaming) && (
        <Card>
          <CardContent className="py-4">
            <h3 className="text-sm font-semibold mb-3">Timeline</h3>
            <RunTimeline events={timelineEvents} isStreaming={isStreaming} />
          </CardContent>
        </Card>
      )}

      {/* Aggregate Metrics */}
      {aggregate && <MetricCards aggregate={aggregate} />}

      {/* Test Configuration */}
      {run.test_spec_json && <TestConfigSection testSpec={run.test_spec_json} />}

      {/* Tabs */}
      <Tabs defaultValue="results">
        <TabsList>
          <TabsTrigger value="results">
            Results
            {run.scenarios.length > 0 && (
              <span className="ml-1.5 text-xs text-muted-foreground">
                ({run.scenarios.length})
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="artifacts">
            Artifacts
            {run.artifacts.length > 0 && (
              <span className="ml-1.5 text-xs text-muted-foreground">
                ({run.artifacts.length})
              </span>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="results" className="mt-4 space-y-6">
          {run.scenarios.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {run.status === "running" || run.status === "queued"
                ? "Waiting for test results..."
                : "No test results."}
            </p>
          ) : (
            <>
              {audioScenarios.length > 0 && (
                <AudioTestResults scenarios={audioScenarios} />
              )}
              {conversationScenarios.length > 0 && (
                <ConversationTestResults
                  scenarios={conversationScenarios}
                />
              )}
            </>
          )}
        </TabsContent>

        <TabsContent value="artifacts" className="mt-4">
          {run.artifacts.length === 0 ? (
            <p className="text-muted-foreground text-sm">No artifacts.</p>
          ) : (
            <div className="space-y-2">
              {run.artifacts.map((a) => (
                <Card key={a.id}>
                  <CardContent className="flex items-center justify-between py-3">
                    <div>
                      <p className="text-sm font-mono">{a.key}</p>
                      <p className="text-xs text-muted-foreground">
                        {a.kind} &middot; {a.content_type} &middot;{" "}
                        {(a.byte_size / 1024).toFixed(1)}KB
                      </p>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
