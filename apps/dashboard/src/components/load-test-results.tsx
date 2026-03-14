"use client";

import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type {
  ScenarioResultRow,
  LoadTestResult,
  LoadTestTierResult,
  LoadTestSeverity,
  LoadTestGrading,
} from "@/lib/types";
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

const SEVERITY_COLORS: Record<LoadTestSeverity, string> = {
  excellent: "text-emerald-600 dark:text-emerald-400",
  good: "text-blue-600 dark:text-blue-400",
  acceptable: "text-amber-600 dark:text-amber-400",
  critical: "text-red-600 dark:text-red-400",
};

const SEVERITY_BG: Record<LoadTestSeverity, string> = {
  excellent: "bg-emerald-500/10 border-emerald-500/30",
  good: "bg-blue-500/10 border-blue-500/30",
  acceptable: "bg-amber-500/10 border-amber-500/30",
  critical: "bg-red-500/10 border-red-500/30",
};

// ---------------------------------------------------------------------------
// Severity badge
// ---------------------------------------------------------------------------

function SeverityBadge({ severity }: { severity: LoadTestSeverity }) {
  return (
    <span
      className={cn(
        "inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold uppercase tracking-wider border",
        SEVERITY_BG[severity],
        SEVERITY_COLORS[severity],
      )}
    >
      {severity}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Summary card
// ---------------------------------------------------------------------------

function SummaryCard({
  label,
  value,
  sub,
  severity,
}: {
  label: string;
  value: string;
  sub?: string;
  severity?: LoadTestSeverity;
}) {
  return (
    <div className="rounded-lg border border-border px-3.5 py-2.5">
      <p className="text-[11px] text-muted-foreground/60 uppercase tracking-wider">
        {label}
      </p>
      <p
        className={cn(
          "text-lg font-semibold font-mono tabular-nums mt-0.5 leading-tight",
          severity && SEVERITY_COLORS[severity],
        )}
      >
        {value}
      </p>
      {sub && (
        <p className="text-[11px] text-muted-foreground mt-0.5">{sub}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Grading table
// ---------------------------------------------------------------------------

function GradingTable({ grading }: { grading: LoadTestGrading }) {
  const rows: Array<{ metric: string; grade: LoadTestSeverity }> = [
    { metric: "TTFW (P95)", grade: grading.ttfw },
    { metric: "P95 Latency", grade: grading.p95_latency },
    { metric: "Error Rate", grade: grading.error_rate },
    { metric: "Quality", grade: grading.quality },
  ];

  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            <th className="text-left px-3.5 py-2 text-[11px] text-muted-foreground/60 uppercase tracking-wider font-medium">
              Metric
            </th>
            <th className="text-right px-3.5 py-2 text-[11px] text-muted-foreground/60 uppercase tracking-wider font-medium">
              Grade
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.metric} className="border-b border-border last:border-0">
              <td className="px-3.5 py-2 text-foreground">{row.metric}</td>
              <td className="px-3.5 py-2 text-right">
                <span className={cn("font-semibold font-mono text-xs uppercase", SEVERITY_COLORS[row.grade])}>
                  {row.grade}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tier results table
// ---------------------------------------------------------------------------

function TierTable({ tiers }: { tiers: LoadTestTierResult[] }) {
  return (
    <div className="rounded-lg border border-border overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            {["Concurrency", "Calls", "Error Rate", "TTFB P95", "TTFW P95", "Quality", "Degradation"].map(
              (h) => (
                <th
                  key={h}
                  className="text-right px-3 py-2 text-[11px] text-muted-foreground/60 uppercase tracking-wider font-medium first:text-left"
                >
                  {h}
                </th>
              ),
            )}
          </tr>
        </thead>
        <tbody>
          {tiers.map((tier, i) => (
            <tr key={i} className="border-b border-border last:border-0">
              <td className="px-3 py-2 font-mono font-semibold tabular-nums text-foreground">
                {tier.concurrency}
              </td>
              <td className="px-3 py-2 font-mono tabular-nums text-right text-muted-foreground">
                {tier.successful_calls}/{tier.total_calls}
              </td>
              <td
                className={cn(
                  "px-3 py-2 font-mono tabular-nums text-right",
                  tier.error_rate > 0.01
                    ? "text-red-600 dark:text-red-400"
                    : tier.error_rate > 0
                    ? "text-amber-600 dark:text-amber-400"
                    : "text-muted-foreground",
                )}
              >
                {fmtPct(tier.error_rate)}
              </td>
              <td className="px-3 py-2 font-mono tabular-nums text-right text-muted-foreground">
                {fmtMs(tier.ttfb_p95_ms)}
              </td>
              <td className="px-3 py-2 font-mono tabular-nums text-right text-muted-foreground">
                {fmtMs(tier.ttfw_p95_ms)}
              </td>
              <td
                className={cn(
                  "px-3 py-2 font-mono tabular-nums text-right",
                  tier.mean_quality_score >= 0.8
                    ? "text-emerald-600 dark:text-emerald-400"
                    : tier.mean_quality_score >= 0.7
                    ? "text-amber-600 dark:text-amber-400"
                    : tier.mean_quality_score > 0
                    ? "text-red-600 dark:text-red-400"
                    : "text-muted-foreground",
                )}
              >
                {tier.mean_quality_score > 0 ? tier.mean_quality_score.toFixed(2) : "—"}
              </td>
              <td
                className={cn(
                  "px-3 py-2 font-mono tabular-nums text-right",
                  tier.ttfb_degradation_pct > 100
                    ? "text-red-600 dark:text-red-400"
                    : tier.ttfb_degradation_pct > 50
                    ? "text-amber-600 dark:text-amber-400"
                    : "text-muted-foreground",
                )}
              >
                {tier.ttfb_degradation_pct > 0 ? `+${tier.ttfb_degradation_pct}%` : "baseline"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Degradation chart (pure SVG)
// ---------------------------------------------------------------------------

function DegradationChart({ tiers }: { tiers: LoadTestTierResult[] }) {
  if (tiers.length < 2) return null;

  const width = 600;
  const height = 240;
  const padLeft = 52;
  const padRight = 52;
  const padTop = 20;
  const padBottom = 36;
  const innerW = width - padLeft - padRight;
  const innerH = height - padTop - padBottom;

  // X positions for each tier (evenly spaced)
  const xStep = innerW / (tiers.length - 1);
  const xPos = tiers.map((_, i) => padLeft + i * xStep);

  // Y scales
  const maxTtfb = Math.max(...tiers.map((t) => t.ttfb_p95_ms), 100);
  const yTtfb = (v: number) => padTop + innerH - (v / maxTtfb) * innerH;

  const hasQuality = tiers.some((t) => t.mean_quality_score > 0);
  const yQuality = (v: number) => padTop + innerH - v * innerH;

  // Build paths
  const ttfbPath = tiers
    .map((t, i) => `${i === 0 ? "M" : "L"} ${xPos[i]!.toFixed(1)} ${yTtfb(t.ttfb_p95_ms).toFixed(1)}`)
    .join(" ");

  const qualityPath = hasQuality
    ? tiers
        .map((t, i) => `${i === 0 ? "M" : "L"} ${xPos[i]!.toFixed(1)} ${yQuality(t.mean_quality_score).toFixed(1)}`)
        .join(" ")
    : null;

  // Y-axis ticks for TTFB
  const ttfbStep = maxTtfb <= 500 ? 100 : maxTtfb <= 2000 ? 500 : 1000;
  const ttfbTicks: number[] = [];
  for (let v = 0; v <= maxTtfb; v += ttfbStep) ttfbTicks.push(v);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto overflow-visible">
      {/* Grid lines */}
      {ttfbTicks.map((v) => (
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

      {/* P95 TTFB line + dots */}
      <path d={ttfbPath} fill="none" stroke="#ef4444" strokeWidth={2} />
      {tiers.map((t, i) => (
        <circle key={`ttfb-${i}`} cx={xPos[i]} cy={yTtfb(t.ttfb_p95_ms)} r={3.5} fill="#ef4444" />
      ))}

      {/* Quality line + dots */}
      {qualityPath && (
        <>
          <path d={qualityPath} fill="none" stroke="#22c55e" strokeWidth={2} />
          {tiers.map((t, i) => (
            <circle key={`q-${i}`} cx={xPos[i]} cy={yQuality(t.mean_quality_score)} r={3.5} fill="#22c55e" />
          ))}
        </>
      )}

      {/* Left Y-axis labels (TTFB) */}
      {ttfbTicks.map((v) => (
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
        fill="#ef4444"
        fontSize={9}
        transform={`rotate(-90, 8, ${padTop + innerH / 2})`}
      >
        P95 TTFB (ms)
      </text>

      {/* Right Y-axis labels (Quality 0-1) */}
      {hasQuality && (
        <>
          {[0, 0.25, 0.5, 0.75, 1].map((v) => (
            <text
              key={`yr-${v}`}
              x={width - padRight + 6}
              y={yQuality(v) + 3}
              textAnchor="start"
              fill="#22c55e"
              fontSize={9}
              fontFamily="monospace"
              opacity={0.7}
            >
              {v.toFixed(2)}
            </text>
          ))}
          <text
            x={width - 8}
            y={padTop + innerH / 2}
            textAnchor="middle"
            fill="#22c55e"
            fontSize={9}
            transform={`rotate(90, ${width - 8}, ${padTop + innerH / 2})`}
          >
            Quality
          </text>
        </>
      )}

      {/* X-axis labels (concurrency per tier) */}
      {tiers.map((t, i) => (
        <text
          key={`xt-${i}`}
          x={xPos[i]}
          y={height - padBottom + 16}
          textAnchor="middle"
          fill="currentColor"
          fontSize={9}
          fontFamily="monospace"
          className="text-muted-foreground"
        >
          {t.concurrency}
        </text>
      ))}
      <text
        x={padLeft + innerW / 2}
        y={height - 4}
        textAnchor="middle"
        fill="currentColor"
        fontSize={9}
        className="text-muted-foreground"
      >
        Concurrent Callers
      </text>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Chart legend
// ---------------------------------------------------------------------------

function ChartLegend({ hasQuality }: { hasQuality: boolean }) {
  return (
    <div className="flex items-center gap-5 mt-2 px-1">
      <div className="flex items-center gap-1.5">
        <span className="h-0.5 w-4 rounded bg-red-500" />
        <span className="text-[10px] text-muted-foreground">P95 TTFB</span>
      </div>
      {hasQuality && (
        <div className="flex items-center gap-1.5">
          <span className="h-0.5 w-4 rounded bg-emerald-500" />
          <span className="text-[10px] text-muted-foreground">Quality Score</span>
        </div>
      )}
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
  const hasQuality = result.tiers.some((t) => t.mean_quality_score > 0);

  return (
    <div className="space-y-6">
      {/* Header: severity + status */}
      <div className="flex items-center gap-3">
        <SeverityBadge severity={result.severity} />
        <span className="text-sm text-muted-foreground">
          {result.total_calls} calls across {result.tiers.length} tiers
        </span>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <SummaryCard
          label="Target Concurrency"
          value={`${result.target_concurrency}`}
        />
        <SummaryCard
          label="Total Calls"
          value={`${result.successful_calls} / ${result.total_calls}`}
          sub={result.failed_calls > 0 ? `${result.failed_calls} failed` : undefined}
        />
        <SummaryCard
          label="Duration"
          value={formatDuration(result.duration_ms)}
        />
        <SummaryCard
          label="Overall"
          value={result.severity}
          severity={result.severity}
        />
      </div>

      {/* Grading table + eval summary */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
          <h3 className="text-xs text-muted-foreground/60 uppercase tracking-wider mb-3">
            Grading
          </h3>
          <GradingTable grading={result.grading} />
        </div>

      </div>

      {/* Breaking point callout */}
      {result.breaking_point && (
        <Card className="border-amber-500/50 bg-amber-500/5">
          <CardContent className="py-3">
            <p className="text-sm">
              <span className="font-medium text-amber-600 dark:text-amber-400">Breaking point</span>
              {" "}detected at{" "}
              <span className="font-mono font-semibold">{result.breaking_point.concurrency}</span>
              {" "}concurrent connections — triggered by{" "}
              <span className="font-mono">
                {result.breaking_point.triggered_by.join(", ")}
              </span>
            </p>
          </CardContent>
        </Card>
      )}

      {/* Tier results table */}
      <div>
        <h3 className="text-xs text-muted-foreground/60 uppercase tracking-wider mb-3">
          Tier Results
        </h3>
        <TierTable tiers={result.tiers} />
      </div>

      {/* Degradation chart */}
      {result.tiers.length > 1 && (
        <Card>
          <CardContent className="py-4">
            <h3 className="text-xs text-muted-foreground/60 uppercase tracking-wider mb-4">
              Degradation Curve
            </h3>
            <DegradationChart tiers={result.tiers} />
            <ChartLegend hasQuality={hasQuality} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
