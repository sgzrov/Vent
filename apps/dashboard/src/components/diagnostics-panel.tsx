import { cn } from "@/lib/utils";
import type { TestDiagnostics } from "@/lib/types";

interface DiagnosticsPanelProps {
  diagnostics: TestDiagnostics;
}

function ErrorOriginBadge({ origin }: { origin: "platform" | "agent" | null }) {
  if (!origin) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 px-2 py-0.5 text-xs">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
        Clean
      </span>
    );
  }
  if (origin === "platform") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md bg-blue-500/10 text-blue-700 dark:text-blue-400 px-2 py-0.5 text-xs">
        <span className="h-1.5 w-1.5 rounded-full bg-blue-500" />
        Platform Issue
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md bg-red-500/10 text-red-700 dark:text-red-400 px-2 py-0.5 text-xs">
      <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
      Agent Issue
    </span>
  );
}

function TimingBar({ diagnostics }: { diagnostics: TestDiagnostics }) {
  const t = diagnostics.timing;
  const segments = [
    { label: "Connect", ms: t.channel_connect_ms, color: "bg-blue-500" },
    { label: "TTS", ms: t.tts_synthesis_ms, color: "bg-violet-500" },
    { label: "Send", ms: t.audio_send_ms, color: "bg-cyan-500" },
    { label: "Wait", ms: t.agent_response_wait_ms, color: "bg-amber-500" },
    { label: "STT", ms: t.stt_transcription_ms, color: "bg-emerald-500" },
  ].filter((s) => s.ms != null && s.ms > 0) as Array<{
    label: string;
    ms: number;
    color: string;
  }>;

  if (segments.length === 0) return null;

  const total = segments.reduce((sum, s) => sum + s.ms, 0);

  return (
    <div>
      <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5">
        Timing Breakdown
      </p>
      <div className="flex h-5 rounded-md overflow-hidden">
        {segments.map((seg) => (
          <div
            key={seg.label}
            className={cn(seg.color, "relative group")}
            style={{ width: `${(seg.ms / total) * 100}%`, minWidth: "2px" }}
            title={`${seg.label}: ${Math.round(seg.ms)}ms`}
          >
            <div className="absolute inset-0 flex items-center justify-center">
              {seg.ms / total > 0.12 && (
                <span className="text-[9px] text-white font-mono truncate px-1">
                  {Math.round(seg.ms)}ms
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="flex gap-3 mt-1.5">
        {segments.map((seg) => (
          <div key={seg.label} className="flex items-center gap-1">
            <span className={cn("h-2 w-2 rounded-sm", seg.color)} />
            <span className="text-[10px] text-muted-foreground">
              {seg.label} {Math.round(seg.ms)}ms
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function DiagnosticsPanel({ diagnostics }: DiagnosticsPanelProps) {
  const ch = diagnostics.channel;

  return (
    <details className="text-xs">
      <summary className="text-muted-foreground uppercase tracking-wider cursor-pointer py-1 hover:text-foreground transition-colors flex items-center gap-2">
        Diagnostics
        <ErrorOriginBadge origin={diagnostics.error_origin} />
      </summary>
      <div className="mt-3 space-y-3">
        {diagnostics.error_detail && (
          <p className="text-sm text-destructive font-mono">
            {diagnostics.error_detail}
          </p>
        )}

        <TimingBar diagnostics={diagnostics} />

        <div>
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5">
            Channel Stats
          </p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <div className="rounded-md border border-border p-2">
              <p className="text-[10px] text-muted-foreground">Connected</p>
              <p className={cn("text-sm font-bold", ch.connected ? "text-emerald-600" : "text-red-600")}>
                {ch.connected ? "Yes" : "No"}
              </p>
            </div>
            <div className="rounded-md border border-border p-2">
              <p className="text-[10px] text-muted-foreground">Bytes Sent</p>
              <p className="text-sm font-bold tabular-nums font-mono">
                {(ch.audio_bytes_sent / 1024).toFixed(1)}KB
              </p>
            </div>
            <div className="rounded-md border border-border p-2">
              <p className="text-[10px] text-muted-foreground">Bytes Received</p>
              <p className="text-sm font-bold tabular-nums font-mono">
                {(ch.audio_bytes_received / 1024).toFixed(1)}KB
              </p>
            </div>
            <div className="rounded-md border border-border p-2">
              <p className="text-[10px] text-muted-foreground">Errors</p>
              <p className={cn("text-sm font-bold tabular-nums", ch.error_events.length > 0 ? "text-red-600" : "text-emerald-600")}>
                {ch.error_events.length}
              </p>
            </div>
          </div>
          {ch.error_events.length > 0 && (
            <div className="mt-2 space-y-1">
              {ch.error_events.map((err, i) => (
                <p key={i} className="text-xs text-destructive font-mono">
                  {err}
                </p>
              ))}
            </div>
          )}
        </div>
      </div>
    </details>
  );
}
