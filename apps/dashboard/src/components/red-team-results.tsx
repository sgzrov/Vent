"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { TraceViewer } from "@/components/trace-viewer";
import { EvalResults } from "@/components/eval-results";
import { ConversationMetricsPanel } from "@/components/conversation-metrics-panel";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import type { ScenarioResultRow, ConversationTestResult } from "@/lib/types";
import { formatDuration } from "@/lib/format";

interface RedTeamResultsProps {
  scenarios: ScenarioResultRow[];
}

function parseCategory(name: string): string {
  const cleaned = name.replace(/^red-team:\s*/i, "");
  const dash = cleaned.indexOf(" - ");
  return dash > 0 ? cleaned.slice(0, dash) : cleaned;
}

function capitalizeWords(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

export function RedTeamResults({ scenarios }: RedTeamResultsProps) {
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
          const isPassed = result.status === "pass";
          const isSelected = selectedId === scenario.id;
          const category = capitalizeWords(parseCategory(scenario.name));
          const evalsPassed = result.eval_results.filter(
            (e) => e.passed
          ).length;
          const evalsTotal = result.eval_results.length;

          return (
            <Card
              key={scenario.id}
              className={cn(
                "border-l-[3px] cursor-pointer transition-all",
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
                {/* Category tag */}
                <p className="text-[11px] text-amber-600 dark:text-amber-400 font-medium mb-1">
                  {category}
                </p>

                {/* Name + status */}
                <div className="flex items-center justify-between mb-3">
                  <p className="text-[13px] truncate mr-2">
                    {result.name ?? scenario.name}
                  </p>
                  <span
                    className={cn(
                      "text-[11px] font-medium px-1.5 py-0.5 rounded shrink-0",
                      isPassed
                        ? "text-emerald-700 dark:text-emerald-400 bg-emerald-500/10"
                        : "text-red-700 dark:text-red-400 bg-red-500/10"
                    )}
                  >
                    {isPassed ? "Pass" : "Fail"}
                  </span>
                </div>

                {/* Metrics */}
                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Evals</span>
                    <span
                      className={cn(
                        "font-mono tabular-nums",
                        evalsPassed === evalsTotal
                          ? "text-emerald-600 dark:text-emerald-400"
                          : "text-red-600 dark:text-red-400"
                      )}
                    >
                      {evalsPassed}/{evalsTotal}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Turns</span>
                    <span className="font-mono tabular-nums">
                      {result.transcript.length}
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Detail panel */}
      {selectedScenario && (
        <div className="mt-5 animate-fade-in">
          <RedTeamDetailPanel scenario={selectedScenario} />
        </div>
      )}
    </div>
  );
}

function RedTeamDetailPanel({
  scenario,
}: {
  scenario: ScenarioResultRow;
}) {
  const result = scenario.metrics_json as ConversationTestResult;
  const evalsPassed = result.eval_results.filter((e) => e.passed).length;
  const evalsTotal = result.eval_results.length;

  return (
    <Card className="border-amber-500/20">
      <CardContent className="py-5">
        <div className="flex items-center justify-between mb-4">
          <p className="text-sm font-semibold">
            {result.name ?? scenario.name}
          </p>
          <span className="text-xs text-muted-foreground tabular-nums">
            {formatDuration(result.duration_ms)}
          </span>
        </div>

        <Tabs defaultValue="evals">
          <TabsList>
            <TabsTrigger value="evals">
              Evals ({evalsPassed}/{evalsTotal})
            </TabsTrigger>
            <TabsTrigger value="transcript">Transcript</TabsTrigger>
            <TabsTrigger value="metrics">Metrics</TabsTrigger>
          </TabsList>
          <TabsContent value="evals" className="mt-3">
            <EvalResults evalResults={result.eval_results} />
          </TabsContent>
          <TabsContent value="transcript" className="mt-3">
            <TraceViewer
              trace={result.transcript}
              evalResults={result.eval_results}
            />
          </TabsContent>
          <TabsContent value="metrics" className="mt-3">
            <ConversationMetricsPanel metrics={result.metrics} transcriptLength={result.transcript.length} durationMs={result.duration_ms} />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
