"use client";

import { cn } from "@/lib/utils";
import { AUDIO_TEST_REGISTRY } from "@/lib/audio-test-registry";
import type { RunEventRow, AudioTestName } from "@/lib/types";

interface RunTimelineProps {
  events: RunEventRow[];
  isStreaming: boolean;
}

interface TestProgress {
  completed: number;
  total: number;
  currentTest: string | null;
}

function getTestProgress(events: RunEventRow[]): TestProgress {
  const completedEvents = events.filter(
    (e) => e.event_type === "test_completed"
  );
  const lastMeta = completedEvents[completedEvents.length - 1]?.metadata_json;
  return {
    completed:
      typeof lastMeta?.completed === "number"
        ? lastMeta.completed
        : completedEvents.length,
    total: typeof lastMeta?.total === "number" ? lastMeta.total : 0,
    currentTest:
      typeof lastMeta?.test_name === "string" ? lastMeta.test_name : null,
  };
}

function dotColor(event: RunEventRow): string {
  const meta = event.metadata_json;

  if (event.event_type === "error") return "bg-red-500";
  if (event.event_type === "run_complete") {
    return meta?.status === "fail" ? "bg-red-500" : "bg-emerald-500";
  }
  if (event.event_type === "test_completed") {
    return meta?.status === "fail" ? "bg-red-500" : "bg-emerald-500";
  }
  if (event.event_type === "health_check_passed") return "bg-emerald-500";
  return "bg-blue-500";
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function getTestLabel(testName: string): string {
  const meta = AUDIO_TEST_REGISTRY[testName as AudioTestName];
  return meta?.label ?? testName.replace(/_/g, " ");
}

function clampWords(text: string, maxWords = 5): string {
  const words = text.trim().split(/\s+/);
  if (words.length <= maxWords) return text;
  return `${words.slice(0, maxWords).join(" ")}...`;
}

function getEventLabel(event: RunEventRow): string {
  if (event.event_type === "test_completed") {
    const testName = event.metadata_json?.test_name;
    if (typeof testName === "string") return getTestLabel(testName);
  }
  return event.message;
}

export function RunTimeline({ events, isStreaming }: RunTimelineProps) {
  if (events.length === 0 && !isStreaming) return null;

  const progress = getTestProgress(events);
  const showProgress = progress.total > 0 || isStreaming;

  return (
    <div className="space-y-3">
      {/* Progress bar */}
      {showProgress && progress.total > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">
              {progress.completed}/{progress.total} tests completed
            </span>
            {isStreaming && progress.currentTest && (
              <span className="text-blue-600 dark:text-blue-400 font-mono animate-pulse">
                Running: {getTestLabel(progress.currentTest)}
              </span>
            )}
          </div>
          <div className="h-1.5 rounded-full bg-muted overflow-hidden">
            <div
              className={cn(
                "h-full rounded-full transition-all duration-500 ease-out",
                progress.completed === progress.total
                  ? "bg-emerald-500"
                  : "bg-blue-500"
              )}
              style={{
                width: `${(progress.completed / progress.total) * 100}%`,
              }}
            />
          </div>
        </div>
      )}

      {/* Horizontal event list */}
      <div className="overflow-x-auto pb-1">
        <div className="flex items-start min-w-max">
          {events.map((event, i) => {
            const isLast = i === events.length - 1;
            const nodeLabel = clampWords(getEventLabel(event), 5);

            return (
              <div
                key={event.id ?? i}
                className="relative w-44 shrink-0 pr-12 animate-fade-in"
                style={{
                  animationDelay: `${Math.min(i * 30, 300)}ms`,
                }}
              >
                <div className="h-4 relative flex items-center">
                  {/* Dot */}
                  <div
                    className={cn("h-2.5 w-2.5 rounded-full", dotColor(event))}
                  />
                  {/* Connector line to next node */}
                  {(!isLast || isStreaming) && (
                    <div
                      className="timeline-dotted-line absolute left-3 top-1/2 -translate-y-1/2 w-[calc(100%+2.5rem)]"
                    />
                  )}
                </div>
                <p className="text-sm font-mono leading-tight mt-1">
                  {nodeLabel}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {formatTime(event.created_at)}
                </p>
              </div>
            );
          })}

          {/* Pulsing indicator when streaming */}
          {isStreaming && (
            <div className="w-44 shrink-0">
              <div className="h-4 flex items-center">
                <div className="h-2.5 w-2.5 rounded-full bg-blue-500 animate-pulse" />
              </div>
              <p className="text-sm text-muted-foreground animate-pulse leading-tight mt-1">
                Waiting for next event
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
