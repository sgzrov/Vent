import { cn } from "@/lib/utils";

interface TtfbEvidenceProps {
  metrics: Record<string, number | boolean>;
}

function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}

function fmtMs(v: number): string {
  return `${Math.round(v)}ms`;
}

const TIERS = [
  { key: "simple", label: "Simple" },
  { key: "complex", label: "Complex" },
  { key: "tool", label: "Tool Call" },
] as const;

export function TtfbEvidence({ metrics }: TtfbEvidenceProps) {
  const threshold = num(metrics.threshold_ms);
  const p50 = num(metrics.p50_ttfb_ms);
  const p95 = num(metrics.p95_ttfb_ms);
  const ttfwDelta = num(metrics.ttfw_delta_ms);
  const responsesReceived = num(metrics.responses_received);

  const tiers = TIERS.map((tier) => ({
    ...tier,
    mean: num(metrics[`${tier.key}_mean_ttfb_ms`]),
    p95: num(metrics[`${tier.key}_p95_ttfb_ms`]),
  }));

  // For the bar chart, find the max value across all tier p95s and the threshold
  const allP95Values = tiers.map((t) => t.p95).filter((v) => v > 0);
  const barMax = Math.max(...allP95Values, threshold, 1);

  // SVG dimensions for latency bars
  const svgWidth = 400;
  const barHeight = 24;
  const labelWidth = 80;
  const chartWidth = svgWidth - labelWidth - 16;
  const rowHeight = 40;
  const svgHeight = tiers.length * rowHeight + 20;

  const thresholdX = labelWidth + (threshold / barMax) * chartWidth;

  return (
    <div className="space-y-5">
      {/* Header stats */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-mono">{responsesReceived}</span> responses
        measured
        {threshold > 0 && (
          <>
            <span className="text-muted-foreground/40">|</span>
            Threshold: <span className="font-mono">{fmtMs(threshold)}</span>
          </>
        )}
      </div>

      {/* Tier breakdown table */}
      <div>
        <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
          Tier Breakdown
        </h4>
        <div className="rounded-md border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/50">
                <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground">
                  Tier
                </th>
                <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground">
                  Mean
                </th>
                <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground">
                  P95
                </th>
              </tr>
            </thead>
            <tbody>
              {tiers.map((tier) => {
                const meanOver = threshold > 0 && tier.mean > threshold;
                const p95Over = threshold > 0 && tier.p95 > threshold;
                return (
                  <tr
                    key={tier.key}
                    className="border-t border-border/50"
                  >
                    <td className="px-3 py-2 font-medium">{tier.label}</td>
                    <td
                      className={cn(
                        "px-3 py-2 text-right font-mono tabular-nums",
                        meanOver
                          ? "text-red-600 dark:text-red-400"
                          : "text-foreground"
                      )}
                    >
                      {tier.mean > 0 ? fmtMs(tier.mean) : "--"}
                    </td>
                    <td
                      className={cn(
                        "px-3 py-2 text-right font-mono tabular-nums",
                        p95Over
                          ? "text-red-600 dark:text-red-400"
                          : "text-foreground"
                      )}
                    >
                      {tier.p95 > 0 ? fmtMs(tier.p95) : "--"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Overall percentile cards */}
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-md border bg-muted/30 px-3 py-2.5">
          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
            P50 TTFB
          </p>
          <p
            className={cn(
              "text-lg font-bold font-mono tabular-nums mt-0.5",
              threshold > 0 && p50 > threshold
                ? "text-red-600 dark:text-red-400"
                : "text-foreground"
            )}
          >
            {fmtMs(p50)}
          </p>
        </div>
        <div className="rounded-md border bg-muted/30 px-3 py-2.5">
          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
            P95 TTFB
          </p>
          <p
            className={cn(
              "text-lg font-bold font-mono tabular-nums mt-0.5",
              threshold > 0 && p95 > threshold
                ? "text-red-600 dark:text-red-400"
                : "text-foreground"
            )}
          >
            {fmtMs(p95)}
          </p>
        </div>
        <div className="rounded-md border bg-muted/30 px-3 py-2.5">
          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
            TTFW Delta
          </p>
          <p className="text-lg font-bold font-mono tabular-nums mt-0.5">
            {ttfwDelta > 0 ? `+${fmtMs(ttfwDelta)}` : fmtMs(ttfwDelta)}
          </p>
        </div>
      </div>

      {/* Visual latency bars */}
      <div>
        <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
          Latency Distribution (P95)
        </h4>
        <svg
          viewBox={`0 0 ${svgWidth} ${svgHeight}`}
          className="w-full h-auto overflow-visible"
          role="img"
          aria-label="Latency distribution bars"
        >
          {/* Threshold line */}
          {threshold > 0 && (
            <>
              <line
                x1={thresholdX}
                y1={0}
                x2={thresholdX}
                y2={svgHeight - 14}
                stroke="currentColor"
                strokeWidth={1}
                strokeDasharray="4,3"
                className="text-muted-foreground/50"
              />
              <text
                x={thresholdX}
                y={svgHeight - 2}
                textAnchor="middle"
                className="fill-muted-foreground"
                fontSize={9}
                fontFamily="ui-monospace, monospace"
              >
                {fmtMs(threshold)}
              </text>
            </>
          )}

          {tiers.map((tier, i) => {
            const y = i * rowHeight + 4;
            const barW = tier.p95 > 0 ? (tier.p95 / barMax) * chartWidth : 0;
            const overThreshold = threshold > 0 && tier.p95 > threshold;

            return (
              <g key={tier.key}>
                {/* Label */}
                <text
                  x={0}
                  y={y + barHeight / 2 + 4}
                  className="fill-foreground"
                  fontSize={12}
                  fontWeight={500}
                >
                  {tier.label}
                </text>

                {/* Bar background */}
                <rect
                  x={labelWidth}
                  y={y}
                  width={chartWidth}
                  height={barHeight}
                  rx={4}
                  className="fill-muted/60"
                />

                {/* Bar value */}
                {barW > 0 && (
                  <rect
                    x={labelWidth}
                    y={y}
                    width={barW}
                    height={barHeight}
                    rx={4}
                    className={cn(
                      overThreshold
                        ? "fill-red-500/70 dark:fill-red-500/50"
                        : "fill-emerald-500/70 dark:fill-emerald-500/50"
                    )}
                  />
                )}

                {/* Value label */}
                {tier.p95 > 0 && (
                  <text
                    x={labelWidth + barW + 6}
                    y={y + barHeight / 2 + 4}
                    className={cn(
                      overThreshold
                        ? "fill-red-600 dark:fill-red-400"
                        : "fill-muted-foreground"
                    )}
                    fontSize={11}
                    fontFamily="ui-monospace, monospace"
                  >
                    {fmtMs(tier.p95)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
