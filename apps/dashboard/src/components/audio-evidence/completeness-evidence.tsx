import { cn } from "@/lib/utils";

interface CompletenessEvidenceProps {
  metrics: Record<string, number | boolean>;
}

const WORD_COUNT_THRESHOLD = 10;

export function CompletenessEvidence({ metrics }: CompletenessEvidenceProps) {
  const responseReceived = metrics.response_received as boolean | undefined;
  const transcriptionLength = metrics.transcription_length as
    | number
    | undefined;
  const wordCount = metrics.word_count as number | undefined;
  const endsWithCompleteSentence = metrics.ends_with_complete_sentence as
    | boolean
    | undefined;
  const hasSubstance = metrics.has_substance as boolean | undefined;
  const sttConfidence = metrics.stt_confidence as number | undefined;
  const timedOut = metrics.timed_out as boolean | undefined;

  // Word count gauge
  const maxWordDisplay = Math.max(
    WORD_COUNT_THRESHOLD * 3,
    wordCount ?? 0,
    30
  );
  const wordFillRatio =
    wordCount !== undefined ? Math.min(wordCount / maxWordDisplay, 1) : 0;
  const thresholdRatio = WORD_COUNT_THRESHOLD / maxWordDisplay;
  const meetsWordThreshold =
    wordCount !== undefined ? wordCount >= WORD_COUNT_THRESHOLD : undefined;

  const gaugeWidth = 400;
  const gaugeBarHeight = 12;
  const gaugePadX = 12;
  const barY = 10;
  const svgHeight = 40;

  // Checklist items
  const checklistItems = [
    {
      label: "Response received",
      value: responseReceived,
      pass: responseReceived === true,
    },
    {
      label: "Complete sentence",
      value: endsWithCompleteSentence,
      pass: endsWithCompleteSentence === true,
    },
    {
      label: "Has substance",
      value: hasSubstance,
      pass: hasSubstance === true,
    },
    {
      label: "Not timed out",
      value: timedOut !== undefined ? !timedOut : undefined,
      pass: timedOut === false,
    },
  ];

  const CheckIcon = ({ className }: { className?: string }) => (
    <svg
      viewBox="0 0 16 16"
      className={cn("w-3.5 h-3.5", className)}
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
      className={cn("w-3.5 h-3.5", className)}
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
      {/* Word count bar */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider">
            Word Count
          </p>
          {wordCount !== undefined && (
            <p
              className={cn(
                "text-xs font-mono font-semibold",
                meetsWordThreshold
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-red-600 dark:text-red-400"
              )}
            >
              {wordCount} words
            </p>
          )}
        </div>
        <div className="overflow-x-auto">
          <svg
            viewBox={`0 0 ${gaugeWidth} ${svgHeight}`}
            className="w-full max-w-[400px] h-auto"
          >
            {/* Track */}
            <rect
              x={gaugePadX}
              y={barY}
              width={gaugeWidth - gaugePadX * 2}
              height={gaugeBarHeight}
              rx={4}
              className="fill-zinc-200 dark:fill-zinc-700"
            />

            {/* Fill */}
            {wordCount !== undefined && wordFillRatio > 0 && (
              <rect
                x={gaugePadX}
                y={barY}
                width={(gaugeWidth - gaugePadX * 2) * wordFillRatio}
                height={gaugeBarHeight}
                rx={4}
                className={cn(
                  meetsWordThreshold
                    ? "fill-emerald-500/80"
                    : "fill-red-500/80"
                )}
              />
            )}

            {/* Threshold marker */}
            <line
              x1={gaugePadX + (gaugeWidth - gaugePadX * 2) * thresholdRatio}
              y1={barY - 2}
              x2={gaugePadX + (gaugeWidth - gaugePadX * 2) * thresholdRatio}
              y2={barY + gaugeBarHeight + 2}
              strokeWidth={2}
              className="stroke-zinc-900 dark:stroke-zinc-100"
            />
            <text
              x={gaugePadX + (gaugeWidth - gaugePadX * 2) * thresholdRatio}
              y={barY + gaugeBarHeight + 14}
              textAnchor="middle"
              className="fill-muted-foreground text-[9px] font-mono"
            >
              {WORD_COUNT_THRESHOLD} words min
            </text>
          </svg>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {/* Checklist */}
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 overflow-hidden">
          {checklistItems.map((item, i) => (
            <div
              key={item.label}
              className={cn(
                "flex items-center justify-between px-3 py-2",
                i < checklistItems.length - 1 &&
                  "border-b border-zinc-100 dark:border-zinc-800"
              )}
            >
              <span className="text-xs text-muted-foreground">
                {item.label}
              </span>
              {item.value === undefined ? (
                <span className="text-xs font-mono text-muted-foreground/50">
                  --
                </span>
              ) : item.pass ? (
                <CheckIcon className="text-emerald-500" />
              ) : (
                <XIcon className="text-red-400 dark:text-red-500" />
              )}
            </div>
          ))}
        </div>

        {/* Side metrics */}
        <div className="space-y-3">
          {/* STT Confidence */}
          <div className="rounded-lg bg-muted/50 px-3 py-2.5">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">
              STT Confidence
            </p>
            <div className="flex items-center gap-2">
              <p
                className={cn(
                  "text-sm font-semibold font-mono",
                  sttConfidence !== undefined && sttConfidence >= 0.8
                    ? "text-emerald-600 dark:text-emerald-400"
                    : sttConfidence !== undefined && sttConfidence >= 0.5
                      ? "text-amber-600 dark:text-amber-400"
                      : sttConfidence !== undefined
                        ? "text-red-600 dark:text-red-400"
                        : "text-muted-foreground"
                )}
              >
                {sttConfidence !== undefined
                  ? `${(sttConfidence * 100).toFixed(0)}%`
                  : "--"}
              </p>
              {sttConfidence !== undefined && (
                <div className="flex-1 h-1.5 rounded-full bg-zinc-200 dark:bg-zinc-700 overflow-hidden max-w-[80px]">
                  <div
                    className={cn(
                      "h-full rounded-full",
                      sttConfidence >= 0.8
                        ? "bg-emerald-500"
                        : sttConfidence >= 0.5
                          ? "bg-amber-500"
                          : "bg-red-500"
                    )}
                    style={{ width: `${sttConfidence * 100}%` }}
                  />
                </div>
              )}
            </div>
          </div>

          {/* Transcription length */}
          <div className="rounded-lg bg-muted/50 px-3 py-2.5">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">
              Transcription Length
            </p>
            <p className="text-sm font-semibold font-mono text-muted-foreground">
              {transcriptionLength !== undefined
                ? `${transcriptionLength} chars`
                : "--"}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
