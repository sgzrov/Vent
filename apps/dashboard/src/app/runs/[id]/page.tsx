"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { RunDetailView } from "@/components/run-detail-view";
import { RunsTopChrome } from "@/components/runs-top-chrome";
import { useRunEvents } from "@/hooks/use-run-events";
import type { RunDetail } from "@/lib/types";

const API_URL = "/backend";

export default function RunDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const [run, setRun] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isActive = run?.status === "running" || run?.status === "queued";

  // SSE-driven events for active runs, static for completed
  const { events, isStreaming } = useRunEvents(
    id,
    run?.events ?? [],
    !!isActive,
  );

  useEffect(() => {
    let cancelled = false;
    const fetchRun = async () => {
      try {
        const res = await fetch(`${API_URL}/runs/${id}`, {
          credentials: "include",
        });
        if (res.status === 401) {
          window.location.reload();
          return;
        }
        if (!res.ok) {
          if (!cancelled) setError(`API ${res.status}`);
          return;
        }
        const data = await res.json();
        if (!cancelled) {
          setRun(data);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    };

    fetchRun();

    // SSE handles live events — keep a slower poll as fallback for
    // run status, scenarios, and aggregate updates
    const pollInterval = isActive ? 5000 : 10000;
    const interval = setInterval(fetchRun, pollInterval);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [id, run?.status]);

  const handleSetBaseline = async () => {
    await fetch(`${API_URL}/runs/${id}/baseline`, {
      method: "POST",
      credentials: "include",
    });
    const res = await fetch(`${API_URL}/runs/${id}`, {
      credentials: "include",
    });
    setRun(await res.json());
  };

  if (error) {
    return (
      <div>
        <RunsTopChrome />
        <p className="text-red-600 font-mono text-sm">{error}</p>
      </div>
    );
  }
  if (!run) {
    return (
      <div>
        <RunsTopChrome />
        <div className="space-y-6 animate-pulse">
          <div className="flex items-center gap-4">
            <div className="h-8 w-16 rounded-md bg-muted" />
            <div className="space-y-2">
              <div className="h-6 w-32 rounded bg-muted" />
              <div className="h-4 w-48 rounded bg-muted" />
            </div>
          </div>
          <div className="h-32 rounded-lg bg-muted" />
          <div className="grid grid-cols-4 gap-3">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-20 rounded-lg bg-muted" />
            ))}
          </div>
          <div className="space-y-2">
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="h-14 rounded-lg bg-muted" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <RunsTopChrome />
      <RunDetailView
        run={run}
        events={events}
        isStreaming={isStreaming}
        onSetBaseline={handleSetBaseline}
      />
    </div>
  );
}
