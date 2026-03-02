import { cn } from "@/lib/utils";

interface NoiseEvidenceProps {
  metrics: Record<string, number | boolean>;
}

function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}

function fmtMs(v: number): string {
  return `${Math.round(v)}ms`;
}

const NOISE_TYPES = [
  { key: "white", label: "White Noise" },
  { key: "babble", label: "Babble" },
  { key: "pink", label: "Pink Noise" },
] as const;

const SNR_LEVELS = [
  { key: "20db", label: "20 dB" },
  { key: "10db", label: "10 dB" },
  { key: "5db", label: "5 dB" },
] as const;

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

export function NoiseEvidence({ metrics }: NoiseEvidenceProps) {
  const baselineTtfb = num(metrics.baseline_ttfb_ms);
  const trialsTotal = num(metrics.trials_total) || 9;
  const trialsResponded = num(metrics.trials_responded);
  const minRespondingSnr = num(metrics.min_responding_snr_db);
  const worstDegradation = num(metrics.worst_ttfb_degradation_ms);
  const meanDegradation = num(metrics.mean_ttfb_degradation_ms);

  const responseRate = `${trialsResponded}/${trialsTotal}`;

  return (
    <div className="space-y-5">
      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-md border bg-muted/30 px-3 py-2.5">
          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
            Baseline TTFB
          </p>
          <p className="text-lg font-bold font-mono tabular-nums mt-0.5">
            {fmtMs(baselineTtfb)}
          </p>
        </div>
        <div className="rounded-md border bg-muted/30 px-3 py-2.5">
          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
            Response Rate
          </p>
          <p
            className={cn(
              "text-lg font-bold font-mono tabular-nums mt-0.5",
              trialsResponded === trialsTotal
                ? "text-emerald-600 dark:text-emerald-400"
                : trialsResponded >= trialsTotal * 0.5
                  ? "text-amber-600 dark:text-amber-400"
                  : "text-red-600 dark:text-red-400"
            )}
          >
            {responseRate}
          </p>
        </div>
        <div className="rounded-md border bg-muted/30 px-3 py-2.5">
          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
            Min SNR
          </p>
          <p className="text-lg font-bold font-mono tabular-nums mt-0.5">
            {minRespondingSnr > 0 ? `${minRespondingSnr} dB` : "--"}
          </p>
        </div>
        <div className="rounded-md border bg-muted/30 px-3 py-2.5">
          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
            Worst Degradation
          </p>
          <p
            className={cn(
              "text-lg font-bold font-mono tabular-nums mt-0.5",
              worstDegradation > 500
                ? "text-red-600 dark:text-red-400"
                : "text-foreground"
            )}
          >
            {worstDegradation > 0 ? `+${fmtMs(worstDegradation)}` : "--"}
          </p>
        </div>
      </div>

      {/* Mean degradation note */}
      {meanDegradation > 0 && (
        <p className="text-xs text-muted-foreground">
          Mean TTFB degradation across responding trials:{" "}
          <span className="font-mono">+{fmtMs(meanDegradation)}</span>
        </p>
      )}

      {/* 3x3 Noise Matrix */}
      <div>
        <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
          Noise Tolerance Matrix
        </h4>
        <div className="rounded-md border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/50">
                <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground">
                  Noise Type
                </th>
                {SNR_LEVELS.map((level) => (
                  <th
                    key={level.key}
                    className="text-center px-3 py-2 text-xs font-medium text-muted-foreground"
                  >
                    {level.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {NOISE_TYPES.map((noise) => (
                <tr key={noise.key} className="border-t border-border/50">
                  <td className="px-3 py-2.5 font-medium">{noise.label}</td>
                  {SNR_LEVELS.map((level) => {
                    const metricKey = `${noise.key}_${level.key}_responded`;
                    const responded = metrics[metricKey] === true;
                    return (
                      <td key={level.key} className="text-center px-3 py-2.5">
                        <span className="inline-flex items-center justify-center">
                          {responded ? (
                            <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-emerald-50 dark:bg-emerald-950/40">
                              <CheckIcon className="text-emerald-600 dark:text-emerald-400" />
                            </span>
                          ) : (
                            <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-red-50 dark:bg-red-950/40">
                              <XIcon className="text-red-600 dark:text-red-400" />
                            </span>
                          )}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
