"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/status-badge";
import { MetricCards } from "@/components/metric-cards";
import { AudioTestResults } from "@/components/audio-test-results";
import { AudioMetricConclusions } from "@/components/audio-metric-conclusions";
import { ConversationTestResults } from "@/components/conversation-test-results";
import { RedTeamResults } from "@/components/red-team-results";
import { LoadTestResults } from "@/components/load-test-results";
import { TestConfigSection } from "@/components/test-config-section";
import { TestDocumentation } from "@/components/test-documentation";
import type { RunDetail, RunAggregateV2, RunEventRow } from "@/lib/types";
import { formatTimestamp } from "@/lib/format";
import { RunTimeline } from "@/components/run-timeline";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

function describeRunDetail(run: RunDetail): string {
  const spec = run.test_spec_json;
  if (spec) {
    const parts: string[] = [];
    if (spec.audio_tests?.length)
      parts.push(
        `${spec.audio_tests.length} audio test${spec.audio_tests.length > 1 ? "s" : ""}`
      );
    if (spec.conversation_tests?.length)
      parts.push(
        `${spec.conversation_tests.length} conversation${spec.conversation_tests.length > 1 ? "s" : ""}`
      );
    if (spec.red_team?.length)
      parts.push(`${spec.red_team.length} red-team`);
    if (spec.load_test)
      parts.push(`load test (${spec.load_test.pattern})`);
    if (parts.length > 0) return parts.join(", ");
  }
  const agg = run.aggregate_json as RunAggregateV2 | null;
  if (agg) {
    const parts: string[] = [];
    if (agg.audio_tests.total > 0)
      parts.push(
        `${agg.audio_tests.total} audio test${agg.audio_tests.total > 1 ? "s" : ""}`
      );
    if (agg.conversation_tests.total > 0)
      parts.push(
        `${agg.conversation_tests.total} conversation${agg.conversation_tests.total > 1 ? "s" : ""}`
      );
    if (agg.load_tests && agg.load_tests.total > 0)
      parts.push(`${agg.load_tests.total} load test${agg.load_tests.total > 1 ? "s" : ""}`);
    if (parts.length > 0) return parts.join(", ");
  }
  return "Test run";
}

// ---------------------------------------------------------------------------
// Tab types
// ---------------------------------------------------------------------------

type TabId = "overview" | "conversations" | "audio" | "security" | "load_test" | "artifacts";

interface TabDef {
  id: TabId;
  label: string;
  count?: number;
  status?: "pass" | "fail" | "mixed";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

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

  // Split scenarios into groups
  const audioScenarios = run.scenarios.filter(
    (s) => s.test_type === "audio"
  );
  const redTeamScenarios = run.scenarios.filter(
    (s) =>
      s.test_type === "conversation" &&
      s.name.toLowerCase().startsWith("red-team")
  );
  const conversationScenarios = run.scenarios.filter(
    (s) =>
      s.test_type === "conversation" &&
      !s.name.toLowerCase().startsWith("red-team")
  );
  const loadTestScenarios = run.scenarios.filter(
    (s) => s.test_type === "load_test"
  );

  // Build tabs — only show tabs with content
  const tabs: TabDef[] = [{ id: "overview", label: "Overview" }];

  if (conversationScenarios.length > 0) {
    const allPassed = conversationScenarios.every(
      (s) => s.status === "pass"
    );
    const allFailed = conversationScenarios.every(
      (s) => s.status === "fail"
    );
    tabs.push({
      id: "conversations",
      label: "Conversations",
      count: conversationScenarios.length,
      status: allPassed ? "pass" : allFailed ? "fail" : "mixed",
    });
  }

  if (audioScenarios.length > 0) {
    const allPassed = audioScenarios.every((s) => s.status === "pass");
    const allFailed = audioScenarios.every((s) => s.status === "fail");
    tabs.push({
      id: "audio",
      label: "Audio",
      count: audioScenarios.length,
      status: allPassed ? "pass" : allFailed ? "fail" : "mixed",
    });
  }

  if (redTeamScenarios.length > 0) {
    const allPassed = redTeamScenarios.every((s) => s.status === "pass");
    const allFailed = redTeamScenarios.every((s) => s.status === "fail");
    tabs.push({
      id: "security",
      label: "Security",
      count: redTeamScenarios.length,
      status: allPassed ? "pass" : allFailed ? "fail" : "mixed",
    });
  }

  if (loadTestScenarios.length > 0) {
    tabs.push({
      id: "load_test",
      label: "Load Test",
      count: loadTestScenarios.length,
      status: loadTestScenarios.every((s) => s.status === "pass") ? "pass" : "fail",
    });
  }

  if (run.artifacts.length > 0) {
    tabs.push({
      id: "artifacts",
      label: "Artifacts",
      count: run.artifacts.length,
    });
  }

  const [activeTab, setActiveTab] = useState<TabId>("overview");

  const isWaiting = run.status === "running" || run.status === "queued";

  return (
    <div>
      {/* Demo banner */}
      {isDemo && (
        <div className="rounded-md bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20 px-4 py-2.5 mt-4">
          <p className="text-sm text-amber-700 dark:text-amber-400">
            This is a demo run with example data. Trigger a real test from your
            code editor via the VoiceCI MCP server.
          </p>
        </div>
      )}

      {/* Header */}
      <div className="h-16 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <StatusBadge status={run.status} size="lg" />
          <div>
            <h1 className="text-[1.125rem] leading-none font-medium tracking-[-0.01em]">
              {describeRunDetail(run)}
            </h1>
            <p className="text-[13px] text-muted-foreground mt-1">
              {formatTimestamp(run.created_at)}
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
        <Card className="border-destructive mt-4">
          <CardContent className="py-4">
            <p className="text-sm text-destructive font-mono">
              {redactErrorText(run.error_text)}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Tab bar — full-bleed divider touches sidebar border */}
      <nav className="-mx-7 px-7 flex gap-6 border-b mt-1">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              "relative pb-3 text-[14px] transition-colors",
              activeTab === tab.id
                ? "text-foreground font-medium"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <span className="flex items-center gap-1.5">
              {tab.label}
              {tab.count != null && (
                <span className="text-muted-foreground/50 tabular-nums">
                  {tab.count}
                </span>
              )}
              {tab.status && (
                <span
                  className={cn(
                    "h-1.5 w-1.5 rounded-full",
                    tab.status === "pass" && "bg-emerald-500",
                    tab.status === "fail" && "bg-red-500",
                    tab.status === "mixed" && "bg-amber-500"
                  )}
                />
              )}
            </span>
            {activeTab === tab.id && (
              <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-foreground rounded-full" />
            )}
          </button>
        ))}
      </nav>

      {/* Tab content */}
      <div className="mt-7">
        {activeTab === "overview" && (
          <div className="space-y-8">
            {/* Aggregate Metrics */}
            {aggregate && (
              <MetricCards aggregate={aggregate} testSpec={run.test_spec_json} />
            )}

            {/* Audio metric conclusions */}
            {audioScenarios.length > 0 && (
              <AudioMetricConclusions scenarios={audioScenarios} />
            )}

            {/* Timeline */}
            {(timelineEvents.length > 0 || isStreaming) && (
              <Card>
                <CardContent className="py-4">
                  <h3 className="text-xs text-muted-foreground/60 uppercase tracking-wider mb-3">
                    Timeline
                  </h3>
                  <RunTimeline
                    events={timelineEvents}
                    isStreaming={isStreaming}
                  />
                </CardContent>
              </Card>
            )}

            {/* Test Configuration */}
            {run.test_spec_json && (
              <TestConfigSection testSpec={run.test_spec_json} />
            )}

            {/* Waiting state */}
            {run.scenarios.length === 0 && isWaiting && (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground animate-pulse">
                  Waiting for test results...
                </p>
                <div className="space-y-2">
                  {[1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-14 w-full" />
                  ))}
                </div>
              </div>
            )}

            {/* No results */}
            {run.scenarios.length === 0 && !isWaiting && (
              <p className="text-muted-foreground text-sm">
                No test results.
              </p>
            )}

            {/* Documentation */}
            <TestDocumentation />
          </div>
        )}

        {activeTab === "conversations" && (
          <ConversationTestResults scenarios={conversationScenarios} />
        )}

        {activeTab === "audio" && (
          <AudioTestResults scenarios={audioScenarios} />
        )}

        {activeTab === "security" && (
          <RedTeamResults scenarios={redTeamScenarios} />
        )}

        {activeTab === "load_test" && loadTestScenarios.length > 0 && (
          <LoadTestResults scenario={loadTestScenarios[0]!} />
        )}

        {activeTab === "artifacts" && (
          <section className="space-y-2">
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
          </section>
        )}
      </div>
    </div>
  );
}
