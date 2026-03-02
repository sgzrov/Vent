import { cn } from "@/lib/utils";

interface AudioQualityEvidenceProps {
  metrics: Record<string, number | boolean>;
}

function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}

function bool(v: unknown): boolean {
  return v === true;
}

function fmtPercent(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function fmtMs(v: number): string {
  return `${Math.round(v)}ms`;
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={cn("w-3.5 h-3.5", className)}
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
      className={cn("w-3.5 h-3.5", className)}
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

function clippingColor(ratio: number): string {
  return ratio < 0.01
    ? "text-emerald-600 dark:text-emerald-400"
    : "text-red-600 dark:text-red-400";
}

function energyColor(consistency: number): string {
  if (consistency >= 0.8) return "text-emerald-600 dark:text-emerald-400";
  if (consistency >= 0.5) return "text-amber-600 dark:text-amber-400";
  return "text-red-600 dark:text-red-400";
}

function snrColor(snr: number): string {
  if (snr > 15) return "text-emerald-600 dark:text-emerald-400";
  if (snr >= 10) return "text-amber-600 dark:text-amber-400";
  return "text-red-600 dark:text-red-400";
}

export function AudioQualityEvidence({ metrics }: AudioQualityEvidenceProps) {
  const durationMs = num(metrics.duration_ms_audio);
  const totalSamples = num(metrics.total_samples);
  const clippingRatio = num(metrics.clipping_ratio);
  const clippedSamples = num(metrics.clipped_samples);
  const energyConsistency = num(metrics.energy_consistency);
  const meanSpeechRms = num(metrics.mean_speech_rms);
  const suddenDrops = num(metrics.sudden_drops);
  const suddenSpikes = num(metrics.sudden_spikes);
  const cleanStart = bool(metrics.clean_start);
  const cleanEnd = bool(metrics.clean_end);
  const estimatedSnr = num(metrics.estimated_snr_db);
  const speechWindows = num(metrics.speech_windows);
  const silenceWindows = num(metrics.silence_windows);

  const totalWindows = speechWindows + silenceWindows;
  const speechRatio = totalWindows > 0 ? speechWindows / totalWindows : 0;

  // SVG for speech/silence bar
  const barWidth = 400;
  const barHeight = 28;
  const speechBarWidth = speechRatio * barWidth;

  return (
    <div className="space-y-5">
      {/* Duration/samples header */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {durationMs > 0 && (
          <>
            Duration: <span className="font-mono">{fmtMs(durationMs)}</span>
          </>
        )}
        {totalSamples > 0 && (
          <>
            <span className="text-muted-foreground/40">|</span>
            <span className="font-mono">
              {totalSamples.toLocaleString()}
            </span>{" "}
            samples
          </>
        )}
      </div>

      {/* Signal quality grid */}
      <div>
        <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
          Signal Quality
        </h4>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {/* Clipping Ratio */}
          <div className="rounded-md border bg-muted/30 px-3 py-2.5">
            <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
              Clipping Ratio
            </p>
            <p
              className={cn(
                "text-lg font-bold font-mono tabular-nums mt-0.5",
                clippingColor(clippingRatio)
              )}
            >
              {fmtPercent(clippingRatio)}
            </p>
            {clippedSamples > 0 && (
              <p className="text-[10px] text-muted-foreground mt-0.5">
                {clippedSamples.toLocaleString()} clipped
              </p>
            )}
          </div>

          {/* Energy Consistency */}
          <div className="rounded-md border bg-muted/30 px-3 py-2.5">
            <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
              Energy Consistency
            </p>
            <p
              className={cn(
                "text-lg font-bold font-mono tabular-nums mt-0.5",
                energyColor(energyConsistency)
              )}
            >
              {fmtPercent(energyConsistency)}
            </p>
            {meanSpeechRms > 0 && (
              <p className="text-[10px] text-muted-foreground font-mono mt-0.5">
                RMS {meanSpeechRms.toFixed(4)}
              </p>
            )}
          </div>

          {/* Estimated SNR */}
          <div className="rounded-md border bg-muted/30 px-3 py-2.5">
            <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
              Estimated SNR
            </p>
            <p
              className={cn(
                "text-lg font-bold font-mono tabular-nums mt-0.5",
                estimatedSnr > 0
                  ? snrColor(estimatedSnr)
                  : "text-foreground"
              )}
            >
              {estimatedSnr > 0 ? `${estimatedSnr.toFixed(1)} dB` : "--"}
            </p>
          </div>

          {/* Clean Start */}
          <div className="rounded-md border bg-muted/30 px-3 py-2.5">
            <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
              Clean Start
            </p>
            <div className="flex items-center gap-1.5 mt-1">
              {cleanStart ? (
                <>
                  <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-emerald-100 dark:bg-emerald-900/50">
                    <CheckIcon className="text-emerald-600 dark:text-emerald-400" />
                  </span>
                  <span className="text-sm font-semibold text-emerald-600 dark:text-emerald-400">
                    Yes
                  </span>
                </>
              ) : (
                <>
                  <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-red-100 dark:bg-red-900/50">
                    <XIcon className="text-red-600 dark:text-red-400" />
                  </span>
                  <span className="text-sm font-semibold text-red-600 dark:text-red-400">
                    No
                  </span>
                </>
              )}
            </div>
          </div>

          {/* Clean End */}
          <div className="rounded-md border bg-muted/30 px-3 py-2.5">
            <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
              Clean End
            </p>
            <div className="flex items-center gap-1.5 mt-1">
              {cleanEnd ? (
                <>
                  <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-emerald-100 dark:bg-emerald-900/50">
                    <CheckIcon className="text-emerald-600 dark:text-emerald-400" />
                  </span>
                  <span className="text-sm font-semibold text-emerald-600 dark:text-emerald-400">
                    Yes
                  </span>
                </>
              ) : (
                <>
                  <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-red-100 dark:bg-red-900/50">
                    <XIcon className="text-red-600 dark:text-red-400" />
                  </span>
                  <span className="text-sm font-semibold text-red-600 dark:text-red-400">
                    No
                  </span>
                </>
              )}
            </div>
          </div>

          {/* Sudden Drops / Spikes */}
          <div className="rounded-md border bg-muted/30 px-3 py-2.5">
            <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
              Anomalies
            </p>
            <div className="flex items-baseline gap-3 mt-1">
              <div>
                <span
                  className={cn(
                    "text-lg font-bold font-mono tabular-nums",
                    suddenDrops > 0
                      ? "text-red-600 dark:text-red-400"
                      : "text-foreground"
                  )}
                >
                  {suddenDrops}
                </span>
                <span className="text-[10px] text-muted-foreground ml-1">
                  drops
                </span>
              </div>
              <div>
                <span
                  className={cn(
                    "text-lg font-bold font-mono tabular-nums",
                    suddenSpikes > 0
                      ? "text-red-600 dark:text-red-400"
                      : "text-foreground"
                  )}
                >
                  {suddenSpikes}
                </span>
                <span className="text-[10px] text-muted-foreground ml-1">
                  spikes
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Speech / Silence bar */}
      {totalWindows > 0 && (
        <div>
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
            Speech / Silence Ratio
          </h4>
          <svg
            viewBox={`0 0 ${barWidth} ${barHeight + 20}`}
            className="w-full h-auto overflow-visible"
            role="img"
            aria-label="Speech vs silence ratio"
          >
            {/* Background */}
            <rect
              x={0}
              y={0}
              width={barWidth}
              height={barHeight}
              rx={6}
              className="fill-zinc-200 dark:fill-zinc-700"
            />

            {/* Speech portion */}
            {speechBarWidth > 0 && (
              <rect
                x={0}
                y={0}
                width={speechBarWidth}
                height={barHeight}
                rx={6}
                className="fill-blue-500/70 dark:fill-blue-500/50"
              />
            )}

            {/* Overlap fix: re-draw right edge of speech if it doesn't span full width */}
            {speechBarWidth > 0 && speechBarWidth < barWidth && (
              <rect
                x={speechBarWidth - 6}
                y={0}
                width={6}
                height={barHeight}
                className="fill-blue-500/70 dark:fill-blue-500/50"
              />
            )}

            {/* Labels */}
            <text
              x={8}
              y={barHeight / 2 + 4}
              className="fill-white dark:fill-white"
              fontSize={11}
              fontWeight={600}
              fontFamily="ui-monospace, monospace"
            >
              {speechWindows > 0 &&
                speechRatio >= 0.15 &&
                `Speech ${(speechRatio * 100).toFixed(0)}%`}
            </text>
            <text
              x={barWidth - 8}
              y={barHeight / 2 + 4}
              textAnchor="end"
              className="fill-zinc-600 dark:fill-zinc-300"
              fontSize={11}
              fontWeight={600}
              fontFamily="ui-monospace, monospace"
            >
              {silenceWindows > 0 &&
                1 - speechRatio >= 0.15 &&
                `Silence ${((1 - speechRatio) * 100).toFixed(0)}%`}
            </text>

            {/* Window counts below */}
            <text
              x={0}
              y={barHeight + 14}
              className="fill-muted-foreground"
              fontSize={10}
              fontFamily="ui-monospace, monospace"
            >
              {speechWindows} speech windows
            </text>
            <text
              x={barWidth}
              y={barHeight + 14}
              textAnchor="end"
              className="fill-muted-foreground"
              fontSize={10}
              fontFamily="ui-monospace, monospace"
            >
              {silenceWindows} silence windows
            </text>
          </svg>
        </div>
      )}
    </div>
  );
}
