import { cn } from "@/lib/utils";

interface EchoEvidenceProps {
  metrics: Record<string, number | boolean>;
}

const TIMELINE_NODES = [
  { label: "Prompt Sent", key: "prompt" },
  { label: "Agent Response", key: "response" },
  { label: "Silence Begins", key: "silence" },
  { label: "Outcome", key: "outcome" },
] as const;

export function EchoEvidence({ metrics }: EchoEvidenceProps) {
  const echoDetected = metrics.echo_detected as boolean | undefined;
  const unpromptedCount = metrics.unprompted_count as number | undefined;
  const firstResponseDelay = metrics.first_response_delay_ms as
    | number
    | undefined;

  const svgWidth = 520;
  const svgHeight = 80;
  const nodeRadius = 8;
  const padX = 40;
  const nodeY = 32;
  const nodeSpacing = (svgWidth - padX * 2) / (TIMELINE_NODES.length - 1);

  function getNodeColor(key: string): string {
    switch (key) {
      case "prompt":
        return "fill-blue-500";
      case "response":
        return "fill-emerald-500";
      case "silence":
        return "fill-zinc-400 dark:fill-zinc-500";
      case "outcome":
        return echoDetected ? "fill-red-500" : "fill-emerald-500";
      default:
        return "fill-zinc-400";
    }
  }

  function getNodeStroke(key: string): string {
    switch (key) {
      case "prompt":
        return "stroke-blue-300 dark:stroke-blue-700";
      case "response":
        return "stroke-emerald-300 dark:stroke-emerald-700";
      case "silence":
        return "stroke-zinc-300 dark:stroke-zinc-600";
      case "outcome":
        return echoDetected
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

          {/* Nodes */}
          {TIMELINE_NODES.map((node, i) => {
            const cx = padX + i * nodeSpacing;
            return (
              <g key={node.key}>
                {/* Outer ring */}
                <circle
                  cx={cx}
                  cy={nodeY}
                  r={nodeRadius + 3}
                  strokeWidth={2}
                  fill="none"
                  className={cn(getNodeStroke(node.key), "opacity-50")}
                />
                {/* Inner dot */}
                <circle
                  cx={cx}
                  cy={nodeY}
                  r={nodeRadius}
                  className={getNodeColor(node.key)}
                />
                {/* Label */}
                <text
                  x={cx}
                  y={nodeY + 24}
                  textAnchor="middle"
                  className="fill-muted-foreground text-[10px] font-medium"
                >
                  {node.key === "outcome"
                    ? echoDetected
                      ? "Echo Detected"
                      : "No Echo"
                    : node.label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {/* Metric cards */}
      <div className="grid grid-cols-3 gap-3">
        {/* Echo Detected */}
        <div className="rounded-lg bg-muted/50 px-3 py-2.5">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">
            Echo Detected
          </p>
          <p
            className={cn(
              "text-sm font-semibold font-mono",
              echoDetected === true && "text-red-600 dark:text-red-400",
              echoDetected === false && "text-emerald-600 dark:text-emerald-400",
              echoDetected === undefined && "text-muted-foreground"
            )}
          >
            {echoDetected === undefined ? "--" : echoDetected ? "yes" : "no"}
          </p>
        </div>

        {/* Unprompted Responses */}
        <div className="rounded-lg bg-muted/50 px-3 py-2.5">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">
            Unprompted Responses
          </p>
          <p
            className={cn(
              "text-sm font-semibold font-mono",
              typeof unpromptedCount === "number" && unpromptedCount > 0
                ? "text-amber-600 dark:text-amber-400"
                : "text-muted-foreground"
            )}
          >
            {unpromptedCount !== undefined ? unpromptedCount : "--"}
          </p>
        </div>

        {/* First Response Delay */}
        <div className="rounded-lg bg-muted/50 px-3 py-2.5">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">
            First Response Delay
          </p>
          <p className="text-sm font-semibold font-mono text-muted-foreground">
            {firstResponseDelay !== undefined
              ? `${Math.round(firstResponseDelay)}ms`
              : "--"}
          </p>
        </div>
      </div>
    </div>
  );
}
