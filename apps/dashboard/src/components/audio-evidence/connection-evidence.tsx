import { cn } from "@/lib/utils";

interface ConnectionEvidenceProps {
  metrics: Record<string, number | boolean>;
}

export function ConnectionEvidence({ metrics }: ConnectionEvidenceProps) {
  const totalTurns = (metrics.total_turns as number | undefined) ?? 5;
  const completedTurns = (metrics.completed_turns as number | undefined) ?? 0;
  const stillConnected = metrics.still_connected as boolean | undefined;
  const disconnectedMidTest = metrics.disconnected_mid_test as
    | boolean
    | undefined;

  const completionPct =
    totalTurns > 0 ? Math.round((completedTurns / totalTurns) * 100) : 0;

  // Build turn rows
  const turns = Array.from({ length: totalTurns }, (_, i) => ({
    index: i + 1,
    completed: i < completedTurns,
  }));

  // SVG check and X icon paths
  const CheckIcon = ({ className }: { className?: string }) => (
    <svg
      viewBox="0 0 16 16"
      className={cn("w-4 h-4", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3.5 8.5L6.5 11.5L12.5 4.5" />
    </svg>
  );

  const XIcon = ({ className }: { className?: string }) => (
    <svg
      viewBox="0 0 16 16"
      className={cn("w-4 h-4", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 4L12 12M12 4L4 12" />
    </svg>
  );

  return (
    <div className="space-y-4">
      {/* Completion bar */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider">
            Turn Completion
          </p>
          <p className="text-xs font-mono font-semibold text-muted-foreground">
            {completedTurns}/{totalTurns}{" "}
            <span className="text-muted-foreground/60">({completionPct}%)</span>
          </p>
        </div>
        <div className="w-full h-2 rounded-full bg-zinc-200 dark:bg-zinc-700 overflow-hidden">
          <div
            className={cn(
              "h-full rounded-full transition-all",
              completionPct === 100
                ? "bg-emerald-500"
                : completionPct > 0
                  ? "bg-amber-500"
                  : "bg-red-500"
            )}
            style={{ width: `${completionPct}%` }}
          />
        </div>
      </div>

      {/* Turn-by-turn checklist */}
      <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 overflow-hidden">
        {turns.map((turn, i) => (
          <div
            key={turn.index}
            className={cn(
              "flex items-center justify-between px-3 py-2",
              i < turns.length - 1 &&
                "border-b border-zinc-100 dark:border-zinc-800"
            )}
          >
            <span className="text-xs font-mono text-muted-foreground">
              Turn {turn.index}
            </span>
            {turn.completed ? (
              <CheckIcon className="text-emerald-500" />
            ) : (
              <XIcon className="text-red-400 dark:text-red-500" />
            )}
          </div>
        ))}
      </div>

      {/* Connection status badge */}
      <div className="flex items-center gap-2">
        <div
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold",
            disconnectedMidTest === true
              ? "bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400"
              : stillConnected === true
                ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
                : stillConnected === false
                  ? "bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400"
                  : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
          )}
        >
          <span
            className={cn(
              "w-1.5 h-1.5 rounded-full",
              disconnectedMidTest === true
                ? "bg-red-500"
                : stillConnected === true
                  ? "bg-emerald-500"
                  : stillConnected === false
                    ? "bg-red-500"
                    : "bg-zinc-400"
            )}
          />
          {disconnectedMidTest === true
            ? "Disconnected mid-test"
            : stillConnected === true
              ? "Connected throughout"
              : stillConnected === false
                ? "Disconnected"
                : "Unknown"}
        </div>
      </div>
    </div>
  );
}
