import { cn } from "@/lib/utils";

interface EndpointingEvidenceProps {
  metrics: Record<string, number | boolean>;
}

function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}

function fmtMs(v: number): string {
  return `${Math.round(v)}ms`;
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={cn("w-4 h-4", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="3,8 7,12 13,4" />
    </svg>
  );
}

function XIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={cn("w-4 h-4", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="4" y1="4" x2="12" y2="12" />
      <line x1="12" y1="4" x2="4" y2="12" />
    </svg>
  );
}

export function EndpointingEvidence({ metrics }: EndpointingEvidenceProps) {
  const trialsTotal = num(metrics.trials_total) || 3;
  const trialsPassed = num(metrics.trials_passed);
  const prematureResponses = num(metrics.premature_responses);
  const pauseDuration = num(metrics.pause_duration_ms);
  const meanResponseTime = num(metrics.mean_response_time_ms);

  // Generate trial results: passed trials are first, failed are last
  const trials = Array.from({ length: trialsTotal }, (_, i) => ({
    index: i + 1,
    passed: i < trialsPassed,
  }));

  const allPassed = trialsPassed === trialsTotal;

  return (
    <div className="space-y-5">
      {/* Pass ratio badge + config */}
      <div className="flex items-center justify-between">
        <div
          className={cn(
            "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold border",
            allPassed
              ? "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-400 dark:border-emerald-800"
              : "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-400 dark:border-red-800"
          )}
        >
          {trialsPassed}/{trialsTotal} passed
        </div>
        {pauseDuration > 0 && (
          <span className="text-xs text-muted-foreground">
            Pause duration:{" "}
            <span className="font-mono">{fmtMs(pauseDuration)}</span>
          </span>
        )}
      </div>

      {/* Trial results */}
      <div>
        <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
          Trial Results
        </h4>
        <div className="space-y-1.5">
          {trials.map((trial) => (
            <div
              key={trial.index}
              className={cn(
                "flex items-center justify-between rounded-md border px-3 py-2.5",
                trial.passed
                  ? "border-emerald-200/60 bg-emerald-50/50 dark:border-emerald-800/40 dark:bg-emerald-950/20"
                  : "border-red-200/60 bg-red-50/50 dark:border-red-800/40 dark:bg-red-950/20"
              )}
            >
              <div className="flex items-center gap-2.5">
                {trial.passed ? (
                  <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-emerald-100 dark:bg-emerald-900/50">
                    <CheckIcon className="text-emerald-600 dark:text-emerald-400" />
                  </span>
                ) : (
                  <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-red-100 dark:bg-red-900/50">
                    <XIcon className="text-red-600 dark:text-red-400" />
                  </span>
                )}
                <span className="text-sm font-medium">
                  Trial {trial.index}
                </span>
              </div>
              <span
                className={cn(
                  "text-xs",
                  trial.passed
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-red-600 dark:text-red-400"
                )}
              >
                {trial.passed ? "Waited correctly" : "Responded prematurely"}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-md border bg-muted/30 px-3 py-2.5">
          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
            Premature Responses
          </p>
          <p
            className={cn(
              "text-lg font-bold font-mono tabular-nums mt-0.5",
              prematureResponses > 0
                ? "text-red-600 dark:text-red-400"
                : "text-emerald-600 dark:text-emerald-400"
            )}
          >
            {prematureResponses}
          </p>
        </div>
        <div className="rounded-md border bg-muted/30 px-3 py-2.5">
          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
            Mean Response Time
          </p>
          <p className="text-lg font-bold font-mono tabular-nums mt-0.5">
            {meanResponseTime > 0 ? fmtMs(meanResponseTime) : "--"}
          </p>
          <p className="text-[10px] text-muted-foreground mt-0.5">
            after full utterance
          </p>
        </div>
      </div>
    </div>
  );
}
