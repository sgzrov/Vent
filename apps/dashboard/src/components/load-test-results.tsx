"use client";

import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { ScenarioResultRow, LoadTestResult, LoadTestTimepoint } from "@/lib/types";
import { formatDuration } from "@/lib/format";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtMs(v: number): string {
  return `${Math.round(v)}ms`;
}

function fmtPct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

const PATTERN_LABELS: Record<string, string> = {
  ramp: "Ramp",
  spike: "Spike",
  sustained: "Sustained",
  soak: "Soak",
};

// ---------------------------------------------------------------------------
// Summary card
// ---------------------------------------------------------------------------

function SummaryCard({
  label,
  value,
  sub,
  status,
}: {
  label: string;
  value: string;
  sub?: string;
  status?: "pass" | "fail";
}) {
  return (
    <div className="rounded-lg border border-border px-3.5 py-2.5">
      <p className="text-[11px] text-muted-foreground/60 uppercase tracking-wider">
        {label}
      </p>
      <p
        className={cn(
          "text-lg font-semibold font-mono tabular-nums mt-0.5 leading-tight",
          status === "pass" && "text-emerald-600 dark:text-emerald-400",
          status === "fail" && "text-red-600 dark:text-red-400"
        )}
      >
        {value}
      </p>
      {sub && (
        <p className="text-[11px] text-red-500 mt-0.5">{sub}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Timeline chart (pure SVG)
// ---------------------------------------------------------------------------

function LoadTestTimelineChart({
  timeline,
  breakingPoint,
}: {
  timeline: LoadTestTimepoint[];
  breakingPoint?: number;
}) {
  if (timeline.length < 2) return null;

  const width = 700;
  const height = 300;
  const padLeft = 52;
  const padRight = 52;
  const padTop = 20;
  const padBottom = 40;
  const innerW = width - padLeft - padRight;
  const innerH = height - padTop - padBottom;

  const maxElapsed = Math.max(...timeline.map((t) => t.elapsed_s));
  const maxTtfb = Math.max(...timeline.map((t) => t.ttfb_p99_ms), 100);
  const maxConnections = Math.max(...timeline.map((t) => t.active_connections), 1);

  // Scales
  const xScale = (s: number) => padLeft + (s / Math.max(maxElapsed, 1)) * innerW;
  const yTtfb = (v: number) => padTop + innerH - (v / maxTtfb) * innerH;
  const yConn = (v: number) => padTop + innerH - (v / maxConnections) * innerH;

  // Build SVG paths
  const buildPath = (accessor: (tp: LoadTestTimepoint) => number, yFn: (v: number) => number) =>
    timeline
      .map((tp, i) => `${i === 0 ? "M" : "L"} ${xScale(tp.elapsed_s).toFixed(1)} ${yFn(accessor(tp)).toFixed(1)}`)
      .join(" ");

  const connAreaPath =
    buildPath((tp) => tp.active_connections, yConn) +
    ` L ${xScale(timeline[timeline.length - 1]!.elapsed_s).toFixed(1)} ${(padTop + innerH).toFixed(1)}` +
    ` L ${xScale(timeline[0]!.elapsed_s).toFixed(1)} ${(padTop + innerH).toFixed(1)} Z`;

  const p50Path = buildPath((tp) => tp.ttfb_p50_ms, yTtfb);
  const p95Path = buildPath((tp) => tp.ttfb_p95_ms, yTtfb);
  const p99Path = buildPath((tp) => tp.ttfb_p99_ms, yTtfb);

  // Error rate dots (only where > 0)
  const errorPoints = timeline
    .filter((tp) => tp.error_rate > 0)
    .map((tp) => ({
      x: xScale(tp.elapsed_s),
      y: yTtfb(0), // show at bottom
      rate: tp.error_rate,
    }));

  // Axis ticks
  const xTicks: number[] = [];
  const xStep = maxElapsed <= 30 ? 5 : maxElapsed <= 120 ? 15 : maxElapsed <= 600 ? 60 : 300;
  for (let t = 0; t <= maxElapsed; t += xStep) {
    xTicks.push(t);
  }

  const yTtfbTicks: number[] = [];
  const yStep = maxTtfb <= 500 ? 100 : maxTtfb <= 2000 ? 500 : 1000;
  for (let v = 0; v <= maxTtfb; v += yStep) {
    yTtfbTicks.push(v);
  }

  const yConnTicks: number[] = [];
  const cStep = maxConnections <= 10 ? 2 : maxConnections <= 50 ? 10 : maxConnections <= 200 ? 50 : 100;
  for (let v = 0; v <= maxConnections; v += cStep) {
    yConnTicks.push(v);
  }

  // Breaking point x position
  const breakingX = breakingPoint != null
    ? timeline.find((tp) => tp.active_connections >= breakingPoint)
    : undefined;
  const breakingXPos = breakingX ? xScale(breakingX.elapsed_s) : undefined;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto overflow-visible">
      {/* Grid lines */}
      {yTtfbTicks.map((v) => (
        <line
          key={`g-${v}`}
          x1={padLeft}
          y1={yTtfb(v)}
          x2={width - padRight}
          y2={yTtfb(v)}
          stroke="currentColor"
          strokeWidth={0.5}
          className="text-border"
        />
      ))}

      {/* Active connections area */}
      <path
        d={connAreaPath}
        fill="currentColor"
        className="text-blue-500/10 dark:text-blue-400/10"
      />
      <path
        d={buildPath((tp) => tp.active_connections, yConn)}
        fill="none"
        stroke="currentColor"
        strokeWidth={1}
        className="text-blue-400/40"
      />

      {/* TTFB lines */}
      <path d={p50Path} fill="none" stroke="#a1a1aa" strokeWidth={1.5} />
      <path d={p95Path} fill="none" stroke="#f59e0b" strokeWidth={1.5} />
      <path d={p99Path} fill="none" stroke="#ef4444" strokeWidth={1.5} />

      {/* Error rate dots */}
      {errorPoints.map((p, i) => (
        <circle
          key={`err-${i}`}
          cx={p.x}
          cy={padTop + innerH - 6}
          r={3}
          fill="#ef4444"
          opacity={Math.min(1, p.rate * 5 + 0.3)}
        />
      ))}

      {/* Breaking point line */}
      {breakingXPos != null && (
        <>
          <line
            x1={breakingXPos}
            y1={padTop}
            x2={breakingXPos}
            y2={padTop + innerH}
            stroke="#f59e0b"
            strokeWidth={1.5}
            strokeDasharray="6,4"
          />
          <text
            x={breakingXPos + 4}
            y={padTop + 10}
            fill="#f59e0b"
            fontSize={9}
            fontFamily="monospace"
          >
            breaking point
          </text>
        </>
      )}

      {/* Left Y-axis labels (TTFB ms) */}
      {yTtfbTicks.map((v) => (
        <text
          key={`yl-${v}`}
          x={padLeft - 6}
          y={yTtfb(v) + 3}
          textAnchor="end"
          fill="currentColor"
          fontSize={9}
          fontFamily="monospace"
          className="text-muted-foreground"
        >
          {v}
        </text>
      ))}
      <text
        x={8}
        y={padTop + innerH / 2}
        textAnchor="middle"
        fill="currentColor"
        fontSize={9}
        className="text-muted-foreground"
        transform={`rotate(-90, 8, ${padTop + innerH / 2})`}
      >
        TTFB (ms)
      </text>

      {/* Right Y-axis labels (connections) */}
      {yConnTicks.map((v) => (
        <text
          key={`yr-${v}`}
          x={width - padRight + 6}
          y={yConn(v) + 3}
          textAnchor="start"
          fill="currentColor"
          fontSize={9}
          fontFamily="monospace"
          className="text-blue-500/60 dark:text-blue-400/60"
        >
          {v}
        </text>
      ))}
      <text
        x={width - 8}
        y={padTop + innerH / 2}
        textAnchor="middle"
        fill="currentColor"
        fontSize={9}
        className="text-blue-500/60 dark:text-blue-400/60"
        transform={`rotate(90, ${width - 8}, ${padTop + innerH / 2})`}
      >
        Connections
      </text>

      {/* X-axis labels */}
      {xTicks.map((t) => (
        <text
          key={`xt-${t}`}
          x={xScale(t)}
          y={height - padBottom + 16}
          textAnchor="middle"
          fill="currentColor"
          fontSize={9}
          fontFamily="monospace"
          className="text-muted-foreground"
        >
          {t}s
        </text>
      ))}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------------

function ChartLegend() {
  const items = [
    { color: "#a1a1aa", label: "P50 TTFB", dash: false },
    { color: "#f59e0b", label: "P95 TTFB", dash: false },
    { color: "#ef4444", label: "P99 TTFB", dash: false },
  ];

  return (
    <div className="flex items-center gap-5 mt-2 px-1">
      {items.map((item) => (
        <div key={item.label} className="flex items-center gap-1.5">
          <span
            className="h-0.5 w-4 rounded"
            style={{ backgroundColor: item.color }}
          />
          <span className="text-[10px] text-muted-foreground">{item.label}</span>
        </div>
      ))}
      <div className="flex items-center gap-1.5">
        <span className="h-3 w-4 rounded bg-blue-500/15 dark:bg-blue-400/15 border border-blue-400/30" />
        <span className="text-[10px] text-muted-foreground">Connections</span>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-full bg-red-500" />
        <span className="text-[10px] text-muted-foreground">Errors</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface LoadTestResultsProps {
  scenario: ScenarioResultRow;
}

export function LoadTestResults({ scenario }: LoadTestResultsProps) {
  const result = scenario.metrics_json as LoadTestResult;
  const timeline = result.timeline;

  return (
    <div className="space-y-6">
      {/* Summary cards — row 1 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <SummaryCard
          label="Pattern"
          value={PATTERN_LABELS[result.pattern] ?? result.pattern}
        />
        <SummaryCard
          label="Peak Concurrency"
          value={`${result.actual_peak_concurrency} / ${result.target_concurrency}`}
        />
        <SummaryCard
          label="Total Calls"
          value={`${result.successful_calls} / ${result.total_calls}`}
          sub={result.failed_calls > 0 ? `${result.failed_calls} failed` : undefined}
        />
        <SummaryCard
          label="Error Rate"
          value={fmtPct(result.summary.error_rate)}
          status={result.summary.error_rate > 0.1 ? "fail" : "pass"}
        />
      </div>

      {/* Summary cards — row 2 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <SummaryCard label="TTFB P50" value={fmtMs(result.summary.ttfb_p50_ms)} />
        <SummaryCard label="TTFB P95" value={fmtMs(result.summary.ttfb_p95_ms)} />
        <SummaryCard label="TTFB P99" value={fmtMs(result.summary.ttfb_p99_ms)} />
        <SummaryCard
          label="Duration"
          value={formatDuration(result.duration_ms)}
        />
      </div>

      {/* Breaking point callout */}
      {result.summary.breaking_point != null && (
        <Card className="border-amber-500/50 bg-amber-500/5">
          <CardContent className="py-3">
            <p className="text-sm">
              <span className="font-medium text-amber-600 dark:text-amber-400">Breaking point</span>
              {" "}detected at{" "}
              <span className="font-mono font-semibold">{result.summary.breaking_point}</span>
              {" "}concurrent connections — P95 TTFB exceeded 2x baseline
            </p>
          </CardContent>
        </Card>
      )}

      {/* Timeline chart */}
      {timeline.length > 1 && (
        <Card>
          <CardContent className="py-4">
            <h3 className="text-xs text-muted-foreground/60 uppercase tracking-wider mb-4">
              Timeline
            </h3>
            <LoadTestTimelineChart
              timeline={timeline}
              breakingPoint={result.summary.breaking_point}
            />
            <ChartLegend />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
