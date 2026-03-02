"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import Link from "next/link";
import { Search } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import type { RunRow, RunAggregateV2, TestSpec } from "@/lib/types";
import { formatDuration, relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

const API_URL = "/backend";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type DisplayStatus = "queued" | "running" | "all-pass" | "partial" | "all-fail";

function getDisplayStatus(run: RunRow): DisplayStatus {
  if (run.status === "queued") return "queued";
  if (run.status === "running") return "running";

  const agg = run.aggregate_json;
  if (agg) {
    const totalFailed = agg.audio_tests.failed + agg.conversation_tests.failed;
    const totalPassed = agg.audio_tests.passed + agg.conversation_tests.passed;
    if (totalFailed === 0) return "all-pass";
    if (totalPassed === 0) return "all-fail";
    return "partial";
  }
  return run.status === "pass" ? "all-pass" : "all-fail";
}

const statusConfig: Record<
  DisplayStatus,
  { dot: string; label: string; text: string }
> = {
  queued: {
    dot: "bg-zinc-400",
    label: "Queued",
    text: "text-muted-foreground",
  },
  running: {
    dot: "bg-blue-500 animate-pulse",
    label: "Running",
    text: "text-blue-600 dark:text-blue-400",
  },
  "all-pass": {
    dot: "bg-emerald-500",
    label: "Passed",
    text: "text-emerald-600 dark:text-emerald-400",
  },
  partial: {
    dot: "bg-amber-500",
    label: "Partial",
    text: "text-amber-600 dark:text-amber-400",
  },
  "all-fail": {
    dot: "bg-red-500",
    label: "Failed",
    text: "text-red-600 dark:text-red-400",
  },
};

function describeRun(run: RunRow): string {
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
    if (parts.length > 0) return parts.join(", ");
  }
  if (run.aggregate_json) {
    const agg = run.aggregate_json;
    const parts: string[] = [];
    if (agg.audio_tests.total > 0)
      parts.push(
        `${agg.audio_tests.total} audio test${agg.audio_tests.total > 1 ? "s" : ""}`
      );
    if (agg.conversation_tests.total > 0)
      parts.push(
        `${agg.conversation_tests.total} conversation${agg.conversation_tests.total > 1 ? "s" : ""}`
      );
    if (parts.length > 0) return parts.join(", ");
  }
  return "Test run";
}

function getIssues(agg: RunAggregateV2 | null): string | null {
  if (!agg) return null;
  const parts: string[] = [];
  if (agg.audio_tests.failed > 0)
    parts.push(
      `${agg.audio_tests.failed} audio test${agg.audio_tests.failed > 1 ? "s" : ""}`
    );
  if (agg.conversation_tests.failed > 0)
    parts.push(
      `${agg.conversation_tests.failed} conversation${agg.conversation_tests.failed > 1 ? "s" : ""}`
    );
  return parts.length > 0 ? parts.join(", ") + " failed" : null;
}

/** Extract voice-specific metadata tags from the test spec */
function getMetaTags(spec: TestSpec | null): string[] {
  if (!spec) return [];
  const tags: string[] = [];

  if (spec.conversation_tests?.length) {
    const evalCount = spec.conversation_tests.reduce(
      (sum, t) =>
        sum + t.eval.length + (t.tool_call_eval?.length ?? 0),
      0
    );
    if (evalCount > 0) tags.push(`${evalCount} evals`);

    const personaTrait = getDominantPersonaTrait(spec.conversation_tests);
    if (personaTrait) tags.push(personaTrait);

    const turns = spec.conversation_tests.map((t) => t.max_turns);
    const maxTurn = Math.max(...turns);
    if (maxTurn > 0) tags.push(`${maxTurn} max turns`);
  }

  if (spec.red_team?.length) {
    tags.push(`${spec.red_team.length} attack vectors`);
  }

  return tags;
}

function getDominantPersonaTrait(
  tests: NonNullable<TestSpec["conversation_tests"]>
): string | null {
  for (const t of tests) {
    const p = t.persona;
    if (!p) continue;
    if (p.emotion && p.emotion !== "neutral") return `${p.emotion} caller`;
    if (p.cooperation && p.cooperation !== "cooperative")
      return `${p.cooperation} caller`;
    if (p.pace && p.pace !== "normal") return `${p.pace} pace`;
    if (p.interruption_style && p.interruption_style !== "none")
      return `${p.interruption_style} interruptions`;
    if (p.clarity && p.clarity !== "clear") return `${p.clarity} speech`;
  }
  return null;
}

function RunMeta({ spec }: { spec: TestSpec | null }) {
  const tags = getMetaTags(spec);
  if (tags.length === 0) return null;

  return (
    <p className="text-[12px] text-muted-foreground/65 mt-1 truncate">
      {tags.join(" · ")}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

type TestTypeFilter = "all" | "audio" | "conversation" | "security";

function hasTestType(run: RunRow, type: TestTypeFilter): boolean {
  if (type === "all") return true;

  const spec = run.test_spec_json;
  const agg = run.aggregate_json;

  if (type === "audio") {
    return (
      (spec?.audio_tests?.length ?? 0) > 0 ||
      (agg?.audio_tests.total ?? 0) > 0
    );
  }
  if (type === "conversation") {
    return (
      (spec?.conversation_tests?.length ?? 0) > 0 ||
      (agg?.conversation_tests.total ?? 0) > 0
    );
  }
  if (type === "security") {
    return (spec?.red_team?.length ?? 0) > 0;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function CategoryResult({
  passed,
  total,
}: {
  passed: number;
  total: number;
}) {
  if (total === 0) return <span className="text-muted-foreground/40">&mdash;</span>;
  const allPassed = passed === total;
  const pct = (passed / total) * 100;

  return (
    <div className="flex items-center gap-2">
      <div className="w-11 h-1.5 bg-muted rounded-full overflow-hidden">
        <div
          className={cn(
            "h-full rounded-full",
            allPassed ? "bg-emerald-500" : "bg-red-500"
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span
        className={cn(
          "text-[12px] font-mono tabular-nums",
          allPassed
            ? "text-emerald-600 dark:text-emerald-400"
            : "text-red-600 dark:text-red-400"
        )}
      >
        {passed}/{total}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

const typeFilters: { value: TestTypeFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "audio", label: "Audio" },
  { value: "conversation", label: "Conversations" },
  { value: "security", label: "Security" },
];

export default function RunsPage() {
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<TestTypeFilter>("all");

  const fetchRuns = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/runs`, {
        credentials: "include",
        cache: "no-store",
      });
      if (res.status === 401) {
        window.location.reload();
        return;
      }
      const data = await res.json();
      if (!res.ok || !Array.isArray(data)) {
        setError(`API ${res.status}: ${JSON.stringify(data)}`);
      } else {
        setRuns(data);
        setError(null);
      }
      setLoading(false);
    } catch (e) {
      setError(String(e));
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRuns();
    const hasActive = runs.some(
      (r) => r.status === "running" || r.status === "queued"
    );
    const interval = setInterval(fetchRuns, hasActive ? 3000 : 10000);
    return () => clearInterval(interval);
  }, [fetchRuns, runs.length > 0 && runs.some((r) => r.status === "running" || r.status === "queued")]);

  const filteredRuns = useMemo(() => {
    let result = runs;

    if (typeFilter !== "all") {
      result = result.filter((r) => hasTestType(r, typeFilter));
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((r) => {
        const desc = describeRun(r).toLowerCase();
        const tags = getMetaTags(r.test_spec_json).join(" ").toLowerCase();
        const status = getDisplayStatus(r);
        return desc.includes(q) || tags.includes(q) || status.includes(q);
      });
    }

    return result;
  }, [runs, search, typeFilter]);

  return (
    <div>
      <div className="h-16 flex items-center">
        <h1 className="text-[1.125rem] leading-none font-medium tracking-[-0.01em]">
          Runs
        </h1>
      </div>
      <div className="-mx-7 border-b mb-7" />

      {/* Search + filters */}
      <div className="flex items-center gap-3 mb-6">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/45" />
          <input
            type="text"
            placeholder="Search runs..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full h-10 pl-10 pr-4 text-[14px] bg-background border border-border/80 rounded-xl placeholder:text-muted-foreground/45 focus:outline-none focus:ring-2 focus:ring-ring/20"
          />
        </div>
        <div className="flex gap-1.5">
          {typeFilters.map((f) => (
            <button
              key={f.value}
              onClick={() =>
                setTypeFilter(f.value === typeFilter ? "all" : f.value)
              }
                className={cn(
                  "text-[13px] font-medium h-9 px-3.5 rounded-xl transition-colors",
                  typeFilter === f.value
                    ? "text-foreground bg-muted"
                    : "text-muted-foreground/80 hover:text-foreground hover:bg-muted"
                )}
              >
                {f.label}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <p className="text-red-600 font-mono text-sm">{error}</p>
      ) : loading ? (
        <div className="border rounded-xl overflow-hidden">
          {[1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="h-16 bg-muted/20 animate-pulse border-b last:border-b-0"
            />
          ))}
        </div>
      ) : runs.length === 0 ? (
        <div className="text-center py-20">
          <p className="text-muted-foreground">No runs yet</p>
          <p className="text-sm text-muted-foreground mt-1">
            Trigger a test from your code editor via the VoiceCI MCP server.
          </p>
          <Link href="/runs/demo">
            <Card className="mt-8 max-w-sm mx-auto hover:bg-accent/50 transition-colors cursor-pointer rounded-xl">
              <CardContent className="py-4 text-center">
                <p className="text-sm font-medium">View demo run</p>
                <p className="text-xs text-muted-foreground mt-1">
                  See what a completed test run looks like
                </p>
              </CardContent>
            </Card>
          </Link>
        </div>
      ) : filteredRuns.length === 0 ? (
        <p className="text-sm text-muted-foreground py-12 text-center">
          No runs match your search.
        </p>
      ) : (
        <div className="border rounded-xl bg-background overflow-hidden">
          {/* Table header */}
          <div className="hidden md:grid grid-cols-[6.5rem_1fr_5rem_5rem_1fr_6.5rem] gap-x-4 items-center px-5 py-3 text-[10px] font-medium text-muted-foreground/55 uppercase tracking-[0.12em] border-b bg-muted">
            <span>Status</span>
            <span>Run</span>
            <span>Audio</span>
            <span>Conv</span>
            <span>Issues</span>
            <span className="text-right">When</span>
          </div>

          {/* Rows */}
          {filteredRuns.map((run) => {
            const ds = getDisplayStatus(run);
            const cfg = statusConfig[ds];
            const agg = run.aggregate_json;
            const issues = getIssues(agg);

            return (
              <Link key={run.id} href={`/runs/${run.id}`} className="block">
                {/* Desktop row */}
                <div className="hidden md:grid grid-cols-[6.5rem_1fr_5rem_5rem_1fr_6.5rem] gap-x-4 items-center px-5 py-3.5 hover:bg-muted transition-colors cursor-pointer border-b last:border-b-0">
                  {/* Status */}
                  <span className="flex items-center gap-2.5">
                    <span
                      className={cn(
                        "block h-2 w-2 rounded-full shrink-0",
                        cfg.dot
                      )}
                    />
                    <span className={cn("text-[12px]", cfg.text)}>
                      {cfg.label}
                    </span>
                  </span>

                  {/* Run description + metadata */}
                  <div className="min-w-0">
                    <p className="text-[14px] leading-5 truncate">
                      {describeRun(run)}
                    </p>
                    <RunMeta spec={run.test_spec_json} />
                  </div>

                  {/* Audio results */}
                  <CategoryResult
                    passed={agg?.audio_tests.passed ?? 0}
                    total={agg?.audio_tests.total ?? 0}
                  />

                  {/* Conversation results */}
                  <CategoryResult
                    passed={agg?.conversation_tests.passed ?? 0}
                    total={agg?.conversation_tests.total ?? 0}
                  />

                  {/* Issues */}
                  <div className="min-w-0">
                    {issues ? (
                      <p className="text-[12px] text-red-600 dark:text-red-400 truncate">
                        {issues}
                      </p>
                    ) : ds === "all-pass" ? (
                      <p className="text-[12px] text-emerald-600/60 dark:text-emerald-400/60">
                        All clear
                      </p>
                    ) : ds === "running" ? (
                      <p className="text-[12px] text-blue-600 dark:text-blue-400 animate-pulse">
                        In progress...
                      </p>
                    ) : ds === "queued" ? (
                      <p className="text-[12px] text-muted-foreground">
                        Waiting
                      </p>
                    ) : null}
                  </div>

                  {/* When */}
                  <div className="text-right">
                    <p className="text-[12px] text-muted-foreground">
                      {relativeTime(run.created_at)}
                    </p>
                    {run.duration_ms != null && (
                      <p className="text-[10px] text-muted-foreground/55 tabular-nums mt-1">
                        {formatDuration(run.duration_ms)}
                      </p>
                    )}
                  </div>
                </div>

                {/* Mobile row — stacked layout */}
                <div className="md:hidden px-5 py-4 hover:bg-muted transition-colors cursor-pointer border-b last:border-b-0">
                  <div className="flex items-center justify-between mb-2">
                    <span className="flex items-center gap-2.5">
                      <span
                        className={cn(
                          "block h-2 w-2 rounded-full shrink-0",
                          cfg.dot
                        )}
                      />
                      <span className={cn("text-[13px]", cfg.text)}>
                        {cfg.label}
                      </span>
                    </span>
                    <span className="text-[13px] text-muted-foreground">
                      {relativeTime(run.created_at)}
                    </span>
                  </div>
                  <p className="text-[15px] leading-5 truncate">
                    {describeRun(run)}
                  </p>
                  <RunMeta spec={run.test_spec_json} />
                  <div className="flex items-center gap-5 mt-2">
                    {agg && agg.audio_tests.total > 0 && (
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">
                          Audio
                        </span>
                        <CategoryResult
                          passed={agg.audio_tests.passed}
                          total={agg.audio_tests.total}
                        />
                      </div>
                    )}
                    {agg && agg.conversation_tests.total > 0 && (
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">
                          Conv
                        </span>
                        <CategoryResult
                          passed={agg.conversation_tests.passed}
                          total={agg.conversation_tests.total}
                        />
                      </div>
                    )}
                  </div>
                  {issues && (
                    <p className="text-[12px] text-red-600 dark:text-red-400 mt-2">
                      {issues}
                    </p>
                  )}
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
