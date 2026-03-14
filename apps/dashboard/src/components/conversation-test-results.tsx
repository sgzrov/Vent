"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { TraceViewer } from "@/components/trace-viewer";
import { ConversationMetricsPanel } from "@/components/conversation-metrics-panel";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import type {
  ScenarioResultRow,
  ConversationTestResult,
  ObservedToolCall,
} from "@/lib/types";
import { formatDuration } from "@/lib/format";

interface ConversationTestResultsProps {
  scenarios: ScenarioResultRow[];
}

export function ConversationTestResults({
  scenarios,
}: ConversationTestResultsProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selectedScenario = selectedId
    ? scenarios.find((s) => s.id === selectedId)
    : null;

  return (
    <div>
      {/* Grid of summary cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {scenarios.map((scenario) => {
          const result = scenario.metrics_json as ConversationTestResult;
          const isCompleted = result.status === "completed";
          const isSelected = selectedId === scenario.id;

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
                {/* Name */}
                <div className="flex items-center justify-between mb-3">
                  <p className="text-[13px] truncate mr-2">
                    {result.name ?? scenario.name}
                  </p>
                  <span
                    className={cn(
                      "text-[11px] font-medium px-1.5 py-0.5 rounded shrink-0",
                      isCompleted
                        ? "text-emerald-700 dark:text-emerald-400 bg-emerald-500/10"
                        : "text-red-700 dark:text-red-400 bg-red-500/10"
                    )}
                  >
                    {isCompleted ? "Completed" : "Error"}
                  </span>
                </div>

                {/* Key metrics in a 2-col grid */}
                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">TTFB</span>
                    <span className="font-mono tabular-nums">
                      {Math.round(result.metrics.mean_ttfb_ms)}ms
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Turns</span>
                    <span className="font-mono tabular-nums">
                      {result.transcript.length}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Duration</span>
                    <span className="font-mono tabular-nums">
                      {formatDuration(result.duration_ms)}
                    </span>
                  </div>
                </div>

                {/* Error preview */}
                {!isCompleted && result.error && (
                  <div className="mt-3 pt-2.5 border-t">
                    <p className="text-[11px] text-red-600 dark:text-red-400 truncate">
                      {result.error}
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Detail panel — appears below the grid */}
      {selectedScenario && (
        <div className="mt-5 animate-fade-in">
          <ConversationDetailPanel scenario={selectedScenario} />
        </div>
      )}
    </div>
  );
}

function ToolCallsList({ calls }: { calls: ObservedToolCall[] }) {
  return (
    <div className="space-y-2">
      {calls.map((call, i) => (
        <div key={i} className="rounded-md border p-3">
          <div className="flex items-center gap-2 mb-2">
            <span
              className={cn(
                "h-2 w-2 rounded-full shrink-0",
                call.successful === false ? "bg-red-500" : "bg-emerald-500"
              )}
            />
            <span className="text-sm font-mono">{call.name}</span>
            {call.latency_ms != null && (
              <span className="text-xs text-muted-foreground font-mono ml-auto">
                {Math.round(call.latency_ms)}ms
              </span>
            )}
          </div>
          <pre className="text-xs font-mono text-muted-foreground bg-muted/50 rounded-md p-2 overflow-x-auto">
            {JSON.stringify(call.arguments, null, 2)}
          </pre>
          {call.result != null && (
            <pre className="text-xs font-mono text-muted-foreground bg-muted/50 rounded-md p-2 overflow-x-auto mt-1.5">
              {JSON.stringify(call.result, null, 2)}
            </pre>
          )}
        </div>
      ))}
    </div>
  );
}

function ConversationDetailPanel({
  scenario,
}: {
  scenario: ScenarioResultRow;
}) {
  const result = scenario.metrics_json as ConversationTestResult;

  return (
    <Card>
      <CardContent className="py-5">
        <div className="flex items-center justify-between mb-4">
          <p className="text-sm font-semibold">
            {result.name ?? scenario.name}
          </p>
          <span className="text-xs text-muted-foreground tabular-nums">
            {formatDuration(result.duration_ms)}
          </span>
        </div>

        <Tabs defaultValue="transcript">
          <TabsList>
            <TabsTrigger value="transcript">Transcript</TabsTrigger>
            <TabsTrigger value="metrics">Metrics</TabsTrigger>
            {result.observed_tool_calls &&
              result.observed_tool_calls.length > 0 && (
                <TabsTrigger value="tools">
                  Tools ({result.observed_tool_calls.length})
                </TabsTrigger>
              )}
          </TabsList>
          <TabsContent value="transcript" className="mt-3">
            <TraceViewer trace={result.transcript} />
          </TabsContent>
          <TabsContent value="metrics" className="mt-3">
            <ConversationMetricsPanel metrics={result.metrics} transcriptLength={result.transcript.length} durationMs={result.duration_ms} />
          </TabsContent>
          {result.observed_tool_calls && (
            <TabsContent value="tools" className="mt-3">
              <ToolCallsList calls={result.observed_tool_calls} />
            </TabsContent>
          )}
        </Tabs>

      </CardContent>
    </Card>
  );
}
