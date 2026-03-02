"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/status-badge";
import type { RunRow, RunAggregateV2 } from "@/lib/types";
import { formatDuration, truncateId, relativeTime } from "@/lib/format";

const API_URL = "/backend";

function renderAggregate(agg: RunAggregateV2) {
  const parts: string[] = [];
  if (agg.audio_tests.total > 0) {
    parts.push(`Audio ${agg.audio_tests.passed}/${agg.audio_tests.total}`);
  }
  if (agg.conversation_tests.total > 0) {
    parts.push(`Conv ${agg.conversation_tests.passed}/${agg.conversation_tests.total}`);
  }
  return parts.join("  ·  ");
}

export default function RunsPage() {
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [filter, setFilter] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchRuns = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (filter) params.set("status", filter);
      const res = await fetch(`${API_URL}/runs?${params}`, {
        credentials: "include",
        cache: "no-store",
      });
      if (res.status === 401) {
        window.location.reload();
        return;
      }
      const data = await res.json();
      if (!res.ok || !Array.isArray(data)) {
        setError(`Unable to load runs (HTTP ${res.status}).`);
      } else {
        setRuns(data);
        setError(null);
      }
      setLoading(false);
    } catch (e) {
      console.error("Failed to fetch runs:", e);
      setError("Unable to load runs. Please retry.");
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    fetchRuns();
    const hasActive = runs.some(
      (r) => r.status === "running" || r.status === "queued"
    );
    const interval = setInterval(fetchRuns, hasActive ? 3000 : 10000);
    return () => clearInterval(interval);
  }, [fetchRuns, runs.length > 0 && runs.some((r) => r.status === "running" || r.status === "queued")]);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Runs</h1>
        <div className="flex gap-2">
          {["", "queued", "running", "pass", "fail"].map((s) => (
            <Button
              key={s}
              variant={filter === s ? "default" : "outline"}
              size="sm"
              onClick={() => setFilter(s)}
            >
              {s || "All"}
            </Button>
          ))}
        </div>
      </div>

      {error ? (
        <p className="text-red-600 font-mono text-sm">{error}</p>
      ) : loading ? (
        <p className="text-muted-foreground">Loading...</p>
      ) : runs.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-muted-foreground">No runs found.</p>
          <p className="text-sm text-muted-foreground mt-1">
            Trigger a test from your code editor via the VoiceCI MCP server.
          </p>
          <Link href="/runs/demo">
            <Card className="mt-6 max-w-md mx-auto hover:bg-accent/50 transition-colors cursor-pointer">
              <CardContent className="py-4 text-center">
                <p className="text-sm font-medium">View demo run</p>
                <p className="text-xs text-muted-foreground mt-1">
                  See what a completed test run looks like
                </p>
              </CardContent>
            </Card>
          </Link>
        </div>
      ) : (
        <div className="space-y-2">
          {runs.map((run) => (
            <Link key={run.id} href={`/runs/${run.id}`}>
              <Card className="hover:bg-accent/50 transition-colors cursor-pointer">
                <CardContent className="flex items-center justify-between py-4">
                  <div className="flex items-center gap-4">
                    <StatusBadge status={run.status} />
                    <div>
                      <p className="font-mono text-sm">
                        {truncateId(run.id)}...
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {relativeTime(run.created_at)}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-4 text-sm text-muted-foreground">
                    {run.aggregate_json && (
                      <span className="font-mono text-xs">
                        {renderAggregate(run.aggregate_json)}
                      </span>
                    )}
                    {run.status === "running" && !run.aggregate_json && (
                      <span className="text-xs text-blue-600 animate-pulse">
                        Running...
                      </span>
                    )}
                    {run.duration_ms != null && (
                      <span>{formatDuration(run.duration_ms)}</span>
                    )}
                    {run.bundle_hash && (
                      <span className="font-mono text-xs opacity-60">
                        {truncateId(run.bundle_hash)}
                      </span>
                    )}
                    <Badge
                      variant="outline"
                      className="text-[10px] px-1.5 py-0 opacity-60"
                    >
                      {run.source_type}
                    </Badge>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
