"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ConversationTurn, EvalResult } from "@/lib/types";

interface TraceViewerProps {
  trace: ConversationTurn[];
  evalResults?: EvalResult[];
}

export function TraceViewer({ trace, evalResults }: TraceViewerProps) {
  const [showRaw, setShowRaw] = useState(false);

  if (trace.length === 0) {
    return <p className="text-sm text-muted-foreground">No transcript data.</p>;
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowRaw(!showRaw)}
        >
          {showRaw ? "Chat View" : "Raw JSON"}
        </Button>
      </div>

      {showRaw ? (
        <Card>
          <CardContent className="py-4">
            <ScrollArea className="h-96">
              <pre className="text-xs font-mono whitespace-pre-wrap">
                {JSON.stringify(trace, null, 2)}
              </pre>
            </ScrollArea>
          </CardContent>
        </Card>
      ) : (
        <ScrollArea className="h-[500px]">
          <div className="space-y-3 pr-4">
            {trace.map((entry, i) => {
              const isCaller = entry.role === "caller";
              return (
                <div
                  key={i}
                  className={cn(
                    "flex",
                    isCaller ? "justify-end" : "justify-start"
                  )}
                >
                  <div className="max-w-[80%] space-y-1">
                    <p
                      className={cn(
                        "text-[10px] uppercase tracking-wider font-medium text-muted-foreground",
                        isCaller ? "text-right" : ""
                      )}
                    >
                      {entry.role}
                    </p>
                    <div
                      className={cn(
                        "rounded-lg px-4 py-2",
                        isCaller
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted"
                      )}
                    >
                      <p className="text-sm leading-relaxed">
                        {entry.text || "(silence)"}
                      </p>
                    </div>
                    <div
                      className={cn(
                        "flex flex-wrap gap-2",
                        isCaller ? "justify-end" : "justify-start"
                      )}
                    >
                      <span className="text-[10px] text-muted-foreground tabular-nums">
                        {entry.timestamp_ms}ms
                      </span>
                      {entry.ttfb_ms != null && (
                        <span className="text-[10px] text-blue-600 tabular-nums">
                          TTFB {Math.round(entry.ttfb_ms)}ms
                        </span>
                      )}
                      {entry.stt_confidence != null && (
                        <span className="text-[10px] text-muted-foreground tabular-nums">
                          STT {(entry.stt_confidence * 100).toFixed(0)}%
                        </span>
                      )}
                      {entry.audio_duration_ms != null && (
                        <span className="text-[10px] text-muted-foreground tabular-nums">
                          audio {(entry.audio_duration_ms / 1000).toFixed(1)}s
                        </span>
                      )}
                      {entry.tts_ms != null && (
                        <span className="text-[10px] text-muted-foreground/50 tabular-nums">
                          tts {Math.round(entry.tts_ms)}ms
                        </span>
                      )}
                      {entry.stt_ms != null && (
                        <span className="text-[10px] text-muted-foreground/50 tabular-nums">
                          stt {Math.round(entry.stt_ms)}ms
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}

            {/* Inline eval annotations */}
            {evalResults && evalResults.length > 0 && (
              <div className="border-t pt-3 mt-1">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-2">
                  Eval Results
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {evalResults.map((e, i) => (
                      <span
                        key={i}
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs",
                          e.passed
                            ? "bg-emerald-50 text-emerald-700"
                            : "bg-red-50 text-red-700"
                        )}
                        title={e.reasoning}
                      >
                        <span
                          className={cn(
                            "h-1.5 w-1.5 rounded-full",
                            e.passed ? "bg-emerald-500" : "bg-red-500"
                          )}
                        />
                        {e.question.length > 50
                          ? e.question.slice(0, 50) + "..."
                          : e.question}
                      </span>
                    ))}
                </div>
              </div>
            )}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
