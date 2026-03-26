import type {
  ConversationMetrics,
  LatencyMetrics,
  TranscriptMetrics,
} from "@/lib/types";
import { formatDuration } from "@/lib/format";
import { TtfbSparkline } from "@/components/ttfb-sparkline";

interface ConversationMetricsPanelProps {
  metrics: ConversationMetrics;
  transcriptLength: number;
  durationMs: number;
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border p-2">
      <p className="text-[10px] text-muted-foreground uppercase tracking-wider">
        {label}
      </p>
      <p className="text-sm font-bold tabular-nums mt-0.5">{value}</p>
    </div>
  );
}

function LatencySection({ latency }: { latency: LatencyMetrics }) {
  return (
    <div>
      <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
        Latency
      </h4>
      {latency.ttfb_per_turn_ms.length >= 2 && (
        <div className="mb-3 rounded-md border p-3">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-2">
            TTFB per turn
          </p>
          <TtfbSparkline
            values={latency.ttfb_per_turn_ms}
            p90={latency.p90_ttfb_ms}
          />
        </div>
      )}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
        <MetricCard
          label="P50 TTFB"
          value={`${Math.round(latency.p50_ttfb_ms)}ms`}
        />
        <MetricCard
          label="P90 TTFB"
          value={`${Math.round(latency.p90_ttfb_ms)}ms`}
        />
        <MetricCard
          label="P95 TTFB"
          value={`${Math.round(latency.p95_ttfb_ms)}ms`}
        />
        <MetricCard
          label="First Turn"
          value={`${Math.round(latency.first_turn_ttfb_ms)}ms`}
        />
        <MetricCard
          label="Mean Turn Gap"
          value={`${Math.round(latency.mean_turn_gap_ms)}ms`}
        />
        <MetricCard
          label="Total Silence"
          value={formatDuration(latency.total_silence_ms)}
        />
      </div>
    </div>
  );
}


function TranscriptSection({ transcript }: { transcript: TranscriptMetrics }) {
  const items: Array<{ label: string; value: string }> = [];
  if (transcript.wer != null)
    items.push({ label: "Word Error Rate", value: `${(transcript.wer * 100).toFixed(1)}%` });
  if (transcript.words_per_minute != null)
    items.push({ label: "Words/min", value: String(Math.round(transcript.words_per_minute)) });
  if (transcript.filler_word_rate != null)
    items.push({ label: "Filler Rate", value: `${transcript.filler_word_rate.toFixed(1)}%` });
  if (transcript.repetition_score != null)
    items.push({ label: "Repetition", value: `${(transcript.repetition_score * 100).toFixed(1)}%` });
  if (transcript.reprompt_count != null)
    items.push({ label: "Reprompts", value: String(transcript.reprompt_count) });
  if (transcript.vocabulary_diversity != null)
    items.push({ label: "Vocab Diversity", value: `${(transcript.vocabulary_diversity * 100).toFixed(0)}%` });

  if (items.length === 0) return null;

  return (
    <div>
      <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
        Transcript Quality
      </h4>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
        {items.map((item) => (
          <MetricCard key={item.label} label={item.label} value={item.value} />
        ))}
      </div>
    </div>
  );
}

export function ConversationMetricsPanel({
  metrics,
  transcriptLength,
  durationMs,
}: ConversationMetricsPanelProps) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <MetricCard label="Turns" value={String(transcriptLength)} />
        <MetricCard
          label="Mean TTFB"
          value={`${Math.round(metrics.mean_ttfb_ms)}ms`}
        />
        <MetricCard
          label="Duration"
          value={formatDuration(durationMs)}
        />
        {metrics.audio_analysis?.talk_ratio_vad != null && (
          <MetricCard
            label="Talk Ratio"
            value={`${(metrics.audio_analysis.talk_ratio_vad * 100).toFixed(0)}%`}
          />
        )}
      </div>

      {metrics.latency && <LatencySection latency={metrics.latency} />}

      {metrics.transcript && (
        <TranscriptSection transcript={metrics.transcript} />
      )}

      {metrics.tool_calls && (
        <div>
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
            Tool Calls
          </h4>
          <div className="grid grid-cols-3 gap-2">
            <MetricCard label="Total" value={String(metrics.tool_calls.total)} />
            <MetricCard
              label="Successful"
              value={String(metrics.tool_calls.successful)}
            />
            <MetricCard
              label="Failed"
              value={String(metrics.tool_calls.failed)}
            />
          </div>
          {metrics.tool_calls.names.length > 0 && (
            <p className="text-xs text-muted-foreground mt-1 font-mono">
              {metrics.tool_calls.names.join(", ")}
            </p>
          )}
        </div>
      )}

      {metrics.audio_analysis && (
        <div>
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
            Audio Analysis
          </h4>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <MetricCard
              label="Speech Ratio"
              value={`${(metrics.audio_analysis.agent_speech_ratio * 100).toFixed(0)}%`}
            />
            <MetricCard
              label="Talk Ratio (VAD)"
              value={`${(metrics.audio_analysis.talk_ratio_vad * 100).toFixed(0)}%`}
            />
            <MetricCard
              label="Longest Monologue"
              value={formatDuration(
                metrics.audio_analysis.longest_monologue_ms
              )}
            />
            <MetricCard
              label="Silence Gaps >2s"
              value={String(metrics.audio_analysis.silence_gaps_over_2s)}
            />
          </div>
        </div>
      )}

      {metrics.harness_overhead && (
        <details className="text-xs">
          <summary className="text-muted-foreground uppercase tracking-wider cursor-pointer py-1">
            Harness Overhead
          </summary>
          <div className="grid grid-cols-2 gap-2 mt-2">
            <MetricCard
              label="Mean TTS"
              value={`${Math.round(metrics.harness_overhead.mean_tts_ms)}ms`}
            />
            <MetricCard
              label="Mean STT"
              value={`${Math.round(metrics.harness_overhead.mean_stt_ms)}ms`}
            />
          </div>
        </details>
      )}
    </div>
  );
}
