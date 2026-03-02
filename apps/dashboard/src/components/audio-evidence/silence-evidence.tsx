import { cn } from "@/lib/utils";

interface SilenceEvidenceProps {
  metrics: Record<string, number | boolean>;
}

export function SilenceEvidence({ metrics }: SilenceEvidenceProps) {
  const agentResponded = metrics.agent_responded as boolean | undefined;
  const stillConnected = metrics.still_connected as boolean | undefined;
  const agentReprompted = metrics.agent_reprompted as boolean | undefined;
  const silenceDuration = metrics.silence_duration_ms as number | undefined;

  const svgWidth = 520;
  const svgHeight = 90;
  const padX = 40;
  const nodeY = 32;
  const nodeRadius = 8;

  // Node positions: Greeting, Response, Silence bar start/end, Outcome
  const greetingX = padX;
  const responseX = padX + 100;
  const silenceStartX = padX + 200;
  const silenceEndX = padX + 380;
  const outcomeX = padX + 460;

  const silenceBarHeight = 16;

  return (
    <div className="space-y-4">
      {/* Timeline SVG */}
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${svgWidth} ${svgHeight}`}
          className="w-full max-w-[520px] h-auto"
        >
          {/* Line: Greeting -> Response */}
          <line
            x1={greetingX + nodeRadius}
            y1={nodeY}
            x2={responseX - nodeRadius}
            y2={nodeY}
            strokeWidth={2}
            className="stroke-zinc-300 dark:stroke-zinc-600"
          />

          {/* Line: Response -> Silence start */}
          <line
            x1={responseX + nodeRadius}
            y1={nodeY}
            x2={silenceStartX}
            y2={nodeY}
            strokeWidth={2}
            className="stroke-zinc-300 dark:stroke-zinc-600"
          />

          {/* Silence bar */}
          <rect
            x={silenceStartX}
            y={nodeY - silenceBarHeight / 2}
            width={silenceEndX - silenceStartX}
            height={silenceBarHeight}
            rx={4}
            className="fill-zinc-200 dark:fill-zinc-700"
          />
          <rect
            x={silenceStartX}
            y={nodeY - silenceBarHeight / 2}
            width={silenceEndX - silenceStartX}
            height={silenceBarHeight}
            rx={4}
            className="fill-amber-100/60 dark:fill-amber-900/30"
          />
          {/* Silence duration label */}
          <text
            x={(silenceStartX + silenceEndX) / 2}
            y={nodeY + 4}
            textAnchor="middle"
            className="fill-amber-700 dark:fill-amber-300 text-[9px] font-mono font-semibold"
          >
            {silenceDuration !== undefined
              ? `${(silenceDuration / 1000).toFixed(1)}s silence`
              : "silence"}
          </text>

          {/* Line: Silence end -> Outcome */}
          <line
            x1={silenceEndX}
            y1={nodeY}
            x2={outcomeX - nodeRadius}
            y2={nodeY}
            strokeWidth={2}
            className="stroke-zinc-300 dark:stroke-zinc-600"
          />

          {/* Greeting node */}
          <circle
            cx={greetingX}
            cy={nodeY}
            r={nodeRadius + 3}
            strokeWidth={2}
            fill="none"
            className="stroke-blue-300 dark:stroke-blue-700 opacity-50"
          />
          <circle
            cx={greetingX}
            cy={nodeY}
            r={nodeRadius}
            className="fill-blue-500"
          />
          <text
            x={greetingX}
            y={nodeY + 26}
            textAnchor="middle"
            className="fill-muted-foreground text-[10px] font-medium"
          >
            Greeting
          </text>

          {/* Response node */}
          <circle
            cx={responseX}
            cy={nodeY}
            r={nodeRadius + 3}
            strokeWidth={2}
            fill="none"
            className={cn(
              "opacity-50",
              agentResponded === false
                ? "stroke-red-300 dark:stroke-red-700"
                : "stroke-emerald-300 dark:stroke-emerald-700"
            )}
          />
          <circle
            cx={responseX}
            cy={nodeY}
            r={nodeRadius}
            className={
              agentResponded === false ? "fill-red-500" : "fill-emerald-500"
            }
          />
          <text
            x={responseX}
            y={nodeY + 26}
            textAnchor="middle"
            className="fill-muted-foreground text-[10px] font-medium"
          >
            {agentResponded === false ? "No Response" : "Response"}
          </text>

          {/* Silence period label above bar */}
          <text
            x={(silenceStartX + silenceEndX) / 2}
            y={nodeY - silenceBarHeight / 2 - 6}
            textAnchor="middle"
            className="fill-muted-foreground text-[9px] font-medium uppercase tracking-wider"
          >
            Silence Period
          </text>

          {/* Outcome node */}
          <circle
            cx={outcomeX}
            cy={nodeY}
            r={nodeRadius + 3}
            strokeWidth={2}
            fill="none"
            className={cn(
              "opacity-50",
              stillConnected === false
                ? "stroke-red-300 dark:stroke-red-700"
                : "stroke-emerald-300 dark:stroke-emerald-700"
            )}
          />
          <circle
            cx={outcomeX}
            cy={nodeY}
            r={nodeRadius}
            className={
              stillConnected === false ? "fill-red-500" : "fill-emerald-500"
            }
          />
          <text
            x={outcomeX}
            y={nodeY + 26}
            textAnchor="middle"
            className={cn(
              "text-[10px] font-semibold",
              stillConnected === false
                ? "fill-red-600 dark:fill-red-400"
                : "fill-emerald-600 dark:fill-emerald-400"
            )}
          >
            {stillConnected === false ? "Disconnected" : "Connected"}
          </text>

          {/* Re-prompted badge */}
          {agentReprompted === true && (
            <>
              <rect
                x={(silenceStartX + silenceEndX) / 2 - 40}
                y={nodeY + silenceBarHeight / 2 + 8}
                width={80}
                height={16}
                rx={8}
                className="fill-emerald-100 dark:fill-emerald-900/40"
              />
              <text
                x={(silenceStartX + silenceEndX) / 2}
                y={nodeY + silenceBarHeight / 2 + 20}
                textAnchor="middle"
                className="fill-emerald-700 dark:fill-emerald-300 text-[8px] font-semibold"
              >
                Re-prompted
              </text>
            </>
          )}
        </svg>
      </div>

      {/* Summary metric cards */}
      <div className="grid grid-cols-4 gap-3">
        <div className="rounded-lg bg-muted/50 px-3 py-2.5">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">
            Agent Responded
          </p>
          <p
            className={cn(
              "text-sm font-semibold font-mono",
              agentResponded === true && "text-emerald-600 dark:text-emerald-400",
              agentResponded === false && "text-red-600 dark:text-red-400",
              agentResponded === undefined && "text-muted-foreground"
            )}
          >
            {agentResponded === undefined
              ? "--"
              : agentResponded
                ? "yes"
                : "no"}
          </p>
        </div>

        <div className="rounded-lg bg-muted/50 px-3 py-2.5">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">
            Still Connected
          </p>
          <p
            className={cn(
              "text-sm font-semibold font-mono",
              stillConnected === true && "text-emerald-600 dark:text-emerald-400",
              stillConnected === false && "text-red-600 dark:text-red-400",
              stillConnected === undefined && "text-muted-foreground"
            )}
          >
            {stillConnected === undefined
              ? "--"
              : stillConnected
                ? "yes"
                : "no"}
          </p>
        </div>

        <div className="rounded-lg bg-muted/50 px-3 py-2.5">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">
            Re-prompted
          </p>
          <p
            className={cn(
              "text-sm font-semibold font-mono",
              agentReprompted === true &&
                "text-emerald-600 dark:text-emerald-400",
              agentReprompted !== true && "text-muted-foreground"
            )}
          >
            {agentReprompted === undefined
              ? "--"
              : agentReprompted
                ? "yes"
                : "no"}
          </p>
        </div>

        <div className="rounded-lg bg-muted/50 px-3 py-2.5">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">
            Silence Duration
          </p>
          <p className="text-sm font-semibold font-mono text-muted-foreground">
            {silenceDuration !== undefined
              ? `${(silenceDuration / 1000).toFixed(1)}s`
              : "--"}
          </p>
        </div>
      </div>
    </div>
  );
}
