import type { AudioTestName } from "./types";

export interface AudioTestMeta {
  key: AudioTestName;
  label: string;
  description: string;
  methodology: string;
  metricLabels: Record<string, string>;
  metricUnits: Record<string, "ms" | "%" | "count" | "boolean" | "dB" | "ratio">;
}

export const AUDIO_TEST_REGISTRY: Record<AudioTestName, AudioTestMeta> = {
  audio_quality: {
    key: "audio_quality",
    label: "Audio Quality",
    description:
      "Analyzes the agent's audio output for clipping, energy consistency, SNR, and artifacts. Measures infrastructure-level signal quality.",
    methodology:
      "Sends a prompt requiring a detailed response. Analyzes the returned audio for clipping (samples near max amplitude), energy drops/spikes, clean start/end, and estimated signal-to-noise ratio.",
    metricLabels: {
      duration_ms_audio: "Audio Duration",
      total_samples: "Total Samples",
      clipping_ratio: "Clipping Ratio",
      clipped_samples: "Clipped Samples",
      energy_consistency: "Energy Consistency",
      mean_speech_rms: "Mean Speech RMS",
      sudden_drops: "Sudden Drops",
      sudden_spikes: "Sudden Spikes",
      clean_start: "Clean Start",
      clean_end: "Clean End",
      estimated_snr_db: "Estimated SNR",
      speech_windows: "Speech Windows",
      silence_windows: "Silence Windows",
    },
    metricUnits: {
      duration_ms_audio: "ms",
      total_samples: "count",
      clipping_ratio: "ratio",
      clipped_samples: "count",
      energy_consistency: "ratio",
      mean_speech_rms: "count",
      sudden_drops: "count",
      sudden_spikes: "count",
      clean_start: "boolean",
      clean_end: "boolean",
      estimated_snr_db: "dB",
      speech_windows: "count",
      silence_windows: "count",
    },
  },
  latency: {
    key: "latency",
    label: "Latency",
    description:
      "Measures response latency across tiered prompts — simple, complex, and tool-triggering. Reports TTFB and TTFW percentiles per tier.",
    methodology:
      "Sends 3 simple, 2 complex, and 2 tool-triggering prompts. Measures TTFB (first audio byte) and TTFW (first word onset) for each. Reports percentiles per tier.",
    metricLabels: {
      responses_received: "Responses",
      mean_ttfb_ms: "Mean TTFB",
      p50_ttfb_ms: "P50 TTFB",
      p95_ttfb_ms: "P95 TTFB",
      simple_mean_ttfb_ms: "Simple Mean",
      simple_p95_ttfb_ms: "Simple P95",
      complex_mean_ttfb_ms: "Complex Mean",
      complex_p95_ttfb_ms: "Complex P95",
      tool_mean_ttfb_ms: "Tool Mean",
      tool_p95_ttfb_ms: "Tool P95",
      mean_ttfw_ms: "Mean TTFW",
      p50_ttfw_ms: "P50 TTFW",
      p95_ttfw_ms: "P95 TTFW",
      ttfw_delta_ms: "TTFW Delta",
    },
    metricUnits: {
      responses_received: "count",
      mean_ttfb_ms: "ms",
      p50_ttfb_ms: "ms",
      p95_ttfb_ms: "ms",
      simple_mean_ttfb_ms: "ms",
      simple_p95_ttfb_ms: "ms",
      complex_mean_ttfb_ms: "ms",
      complex_p95_ttfb_ms: "ms",
      tool_mean_ttfb_ms: "ms",
      tool_p95_ttfb_ms: "ms",
      mean_ttfw_ms: "ms",
      p50_ttfw_ms: "ms",
      p95_ttfw_ms: "ms",
      ttfw_delta_ms: "ms",
    },
  },
  echo: {
    key: "echo",
    label: "Echo Detection",
    description:
      "Detects pipeline feedback loops where the agent's STT picks up its own TTS output. Indicates infrastructure-level audio routing issues.",
    methodology:
      "Sends a prompt, then goes silent. Counts unprompted agent responses during silence. Two or more unprompted responses indicate a feedback loop.",
    metricLabels: {
      echo_detected: "Echo Detected",
      unprompted_count: "Unprompted Responses",
      first_response_delay_ms: "First Response Delay",
    },
    metricUnits: {
      echo_detected: "boolean",
      unprompted_count: "count",
      first_response_delay_ms: "ms",
    },
  },
};

/** Labels for legacy audio test names from historical runs. */
export const LEGACY_AUDIO_TEST_LABELS: Record<string, string> = {
  barge_in: "Barge-in Handling",
  ttfb: "Time to First Byte",
  silence_handling: "Silence Handling",
  connection_stability: "Connection Stability",
  response_completeness: "Response Completeness",
  noise_resilience: "Noise Resilience",
  endpointing: "Endpointing",
};

export const RED_TEAM_LABELS: Record<string, string> = {
  prompt_injection: "Prompt Injection",
  pii_extraction: "PII Extraction",
  jailbreak: "Jailbreak",
  social_engineering: "Social Engineering",
  off_topic: "Off-Topic",
  compliance_bypass: "Compliance Bypass",
};
