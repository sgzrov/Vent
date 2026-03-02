import { cn } from "@/lib/utils";

interface BargeInEvidenceProps {
  metrics: Record<string, number | boolean>;
}

const TIMELINE_NODES = [
  { label: "Prompt Sent", key: "prompt" },
  { label: "Agent Speaking", key: "speaking" },
  { label: "Interruption Sent", key: "interruption" },
  { label: "Agent Stops", key: "stops" },
] as const;

export function BargeInEvidence({ metrics }: BargeInEvidenceProps) {
  const agentResponded = metrics.agent_responded as boolean | undefined;
  const bargeInHandled = metrics.barge_in_handled as boolean | undefined;
  const stopLatency = metrics.stop_latency_ms as number | undefined;
  const threshold = metrics.threshold_ms as number | undefined;

  const withinThreshold =
    stopLatency !== undefined && threshold !== undefined
      ? stopLatency <= threshold
      : undefined;

  const svgWidth = 520;
  const svgHeight = 80;
  const nodeRadius = 8;
  const padX = 40;
  const nodeY = 32;
  const nodeSpacing = (svgWidth - padX * 2) / (TIMELINE_NODES.length - 1);

  // Gauge dimensions
  const gaugeWidth = 400;
  const gaugeHeight = 36;
  const gaugePadX = 12;
  const barHeight = 12;
  const barY = 10;

  // Compute gauge fill ratio
  const maxGaugeValue =
    threshold !== undefined
      ? Math.max(threshold * 1.5, stopLatency ?? 0)
      : stopLatency !== undefined
        ? stopLatency * 1.5
        : 1000;

  const fillRatio =
    stopLatency !== undefined ? Math.min(stopLatency / maxGaugeValue, 1) : 0;
  const thresholdRatio =
    threshold !== undefined ? Math.min(threshold / maxGaugeValue, 1) : undefined;

  function getNodeColor(key: string): string {
    switch (key) {
      case "prompt":
        return "fill-blue-500";
      case "speaking":
        return "fill-emerald-500";
      case "interruption":
        return "fill-amber-500";
      case "stops":
        return bargeInHandled === false
          ? "fill-red-500"
          : "fill-emerald-500";
      default:
        return "fill-zinc-400";
    }
  }

  function getNodeStroke(key: string): string {
    switch (key) {
      case "prompt":
        return "stroke-blue-300 dark:stroke-blue-700";
      case "speaking":
        return "stroke-emerald-300 dark:stroke-emerald-700";
      case "interruption":
        return "stroke-amber-300 dark:stroke-amber-700";
      case "stops":
        return bargeInHandled === false
          ? "stroke-red-300 dark:stroke-red-700"
          : "stroke-emerald-300 dark:stroke-emerald-700";
      default:
        return "stroke-zinc-300";
    }
  }

  return (
    <div className="space-y-4">
      {/* Timeline SVG */}
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${svgWidth} ${svgHeight}`}
          className="w-full max-w-[520px] h-auto"
        >
          {/* Connecting lines */}
          {TIMELINE_NODES.slice(0, -1).map((_, i) => {
            const x1 = padX + i * nodeSpacing + nodeRadius;
            const x2 = padX + (i + 1) * nodeSpacing - nodeRadius;
            return (
              <line
                key={`line-${i}`}
                x1={x1}
                y1={nodeY}
                x2={x2}
                y2={nodeY}
                strokeWidth={2}
                className="stroke-zinc-300 dark:stroke-zinc-600"
              />
            );
          })}

          {/* Timing annotation between interruption and stops */}
          {stopLatency !== undefined && (
            <>
              <line
                x1={padX + 2 * nodeSpacing}
                y1={nodeY - 18}
                x2={padX + 3 * nodeSpacing}
                y2={nodeY - 18}
                strokeWidth={1}
                strokeDasharray="3,2"
                className="stroke-muted-foreground/60"
              />
              <text
                x={padX + 2.5 * nodeSpacing}
                y={nodeY - 22}
                textAnchor="middle"
                className={cn(
                  "text-[9px] font-mono font-medium",
                  withinThreshold === false
                    ? "fill-red-500"
                    : "fill-muted-foreground"
                )}
              >
                {Math.round(stopLatency)}ms
              </text>
            </>
          )}

          {/* Nodes */}
          {TIMELINE_NODES.map((node, i) => {
            const cx = padX + i * nodeSpacing;
            return (
              <g key={node.key}>
                <circle
                  cx={cx}
                  cy={nodeY}
                  r={nodeRadius + 3}
                  strokeWidth={2}
                  fill="none"
                  className={cn(getNodeStroke(node.key), "opacity-50")}
                />
                <circle
                  cx={cx}
                  cy={nodeY}
                  r={nodeRadius}
                  className={getNodeColor(node.key)}
                />
                <text
                  x={cx}
                  y={nodeY + 24}
                  textAnchor="middle"
                  className="fill-muted-foreground text-[10px] font-medium"
                >
                  {node.label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {/* Latency gauge */}
      {(stopLatency !== undefined || threshold !== undefined) && (
        <div>
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5">
            Stop Latency vs Threshold
          </p>
          <div className="overflow-x-auto">
            <svg
              viewBox={`0 0 ${gaugeWidth} ${gaugeHeight}`}
              className="w-full max-w-[400px] h-auto"
            >
              {/* Track background */}
              <rect
                x={gaugePadX}
                y={barY}
                width={gaugeWidth - gaugePadX * 2}
                height={barHeight}
                rx={4}
                className="fill-zinc-200 dark:fill-zinc-700"
              />

              {/* Fill bar */}
              {stopLatency !== undefined && fillRatio > 0 && (
                <rect
                  x={gaugePadX}
                  y={barY}
                  width={(gaugeWidth - gaugePadX * 2) * fillRatio}
                  height={barHeight}
                  rx={4}
                  className={cn(
                    withinThreshold === false
                      ? "fill-red-500/80"
                      : "fill-emerald-500/80"
                  )}
                />
              )}

              {/* Threshold marker */}
              {thresholdRatio !== undefined && (
                <>
                  <line
                    x1={gaugePadX + (gaugeWidth - gaugePadX * 2) * thresholdRatio}
                    y1={barY - 2}
                    x2={gaugePadX + (gaugeWidth - gaugePadX * 2) * thresholdRatio}
                    y2={barY + barHeight + 2}
                    strokeWidth={2}
                    className="stroke-zinc-900 dark:stroke-zinc-100"
                  />
                  <text
                    x={gaugePadX + (gaugeWidth - gaugePadX * 2) * thresholdRatio}
                    y={barY + barHeight + 14}
                    textAnchor="middle"
                    className="fill-muted-foreground text-[9px] font-mono"
                  >
                    {Math.round(threshold!)}ms threshold
                  </text>
                </>
              )}

              {/* Value label */}
              {stopLatency !== undefined && fillRatio > 0 && (
                <text
                  x={
                    gaugePadX +
                    (gaugeWidth - gaugePadX * 2) * fillRatio +
                    (fillRatio > 0.85 ? -8 : 8)
                  }
                  y={barY + barHeight / 2 + 3.5}
                  textAnchor={fillRatio > 0.85 ? "end" : "start"}
                  className={cn(
                    "text-[9px] font-mono font-semibold",
                    withinThreshold === false
                      ? "fill-red-600 dark:fill-red-400"
                      : "fill-emerald-600 dark:fill-emerald-400"
                  )}
                >
                  {Math.round(stopLatency)}ms
                </text>
              )}
            </svg>
          </div>
        </div>
      )}

      {/* Summary metric cards */}
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-lg bg-muted/50 px-3 py-2.5">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">
            Handled
          </p>
          <p
            className={cn(
              "text-sm font-semibold font-mono",
              bargeInHandled === true && "text-emerald-600 dark:text-emerald-400",
              bargeInHandled === false && "text-red-600 dark:text-red-400",
              bargeInHandled === undefined && "text-muted-foreground"
            )}
          >
            {bargeInHandled === undefined
              ? "--"
              : bargeInHandled
                ? "yes"
                : "no"}
          </p>
        </div>

        <div className="rounded-lg bg-muted/50 px-3 py-2.5">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">
            Stop Latency
          </p>
          <p
            className={cn(
              "text-sm font-semibold font-mono",
              withinThreshold === false
                ? "text-red-600 dark:text-red-400"
                : "text-muted-foreground"
            )}
          >
            {stopLatency !== undefined ? `${Math.round(stopLatency)}ms` : "--"}
          </p>
        </div>

        <div className="rounded-lg bg-muted/50 px-3 py-2.5">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">
            Threshold
          </p>
          <p className="text-sm font-semibold font-mono text-muted-foreground">
            {threshold !== undefined ? `${Math.round(threshold)}ms` : "--"}
          </p>
        </div>
      </div>
    </div>
  );
}
