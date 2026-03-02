import type { AudioTestName } from "./types";

export interface AudioTestMeta {
  key: AudioTestName;
  label: string;
  description: string;
  methodology: string;
  passCriteria: string;
  metricLabels: Record<string, string>;
  metricUnits: Record<string, "ms" | "%" | "count" | "boolean" | "dB" | "ratio">;
}

export const AUDIO_TEST_REGISTRY: Record<AudioTestName, AudioTestMeta> = {
  echo: {
    key: "echo",
    label: "Echo Detection",
    description:
      "Detects pipeline feedback loops where the agent's STT picks up its own TTS output.",
    methodology:
      "Sends a prompt, then goes silent. Counts unprompted agent responses during silence. Two or more unprompted responses indicate a feedback loop.",
    passCriteria: "Fewer than 2 unprompted responses during silence period.",
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
  barge_in: {
    key: "barge_in",
    label: "Barge-in Handling",
    description:
      "Verifies the agent stops speaking when interrupted mid-response.",
    methodology:
      "Sends a prompt that elicits a long response, then interrupts with a new utterance after the agent starts speaking. Measures how quickly the agent ceases output.",
    passCriteria: "Agent stops speaking within the configured threshold (default 2000ms).",
    metricLabels: {
      agent_responded: "Agent Responded",
      barge_in_handled: "Interruption Handled",
      stop_latency_ms: "Stop Latency",
      threshold_ms: "Threshold",
    },
    metricUnits: {
      agent_responded: "boolean",
      barge_in_handled: "boolean",
      stop_latency_ms: "ms",
      threshold_ms: "ms",
    },
  },
  ttfb: {
    key: "ttfb",
    label: "Time to First Byte",
    description:
      "Measures response latency across 7 tiered prompts — simple, complex, and tool-triggering.",
    methodology:
      "Sends 3 simple, 2 complex, and 2 tool-triggering prompts. Measures TTFB (first audio byte) and TTFW (first word onset) for each. Reports percentiles per tier.",
    passCriteria: "P95 TTFB across all prompts stays within the configured threshold.",
    metricLabels: {
      responses_received: "Responses",
      mean_ttfb_ms: "Mean TTFB",
      p50_ttfb_ms: "P50 TTFB",
      p95_ttfb_ms: "P95 TTFB",
      threshold_ms: "Threshold",
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
      threshold_ms: "ms",
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
  silence_handling: {
    key: "silence_handling",
    label: "Silence Handling",
    description:
      "Verifies the agent stays connected and optionally re-prompts during extended silence.",
    methodology:
      "Sends a greeting, waits for the agent to respond, then streams 8 seconds of silence. Checks whether the agent remains connected and whether it re-prompts.",
    passCriteria: "Agent remains connected throughout the silence period.",
    metricLabels: {
      agent_responded: "Agent Responded",
      still_connected: "Still Connected",
      agent_reprompted: "Agent Re-prompted",
      silence_duration_ms: "Silence Duration",
    },
    metricUnits: {
      agent_responded: "boolean",
      still_connected: "boolean",
      agent_reprompted: "boolean",
      silence_duration_ms: "ms",
    },
  },
  connection_stability: {
    key: "connection_stability",
    label: "Connection Stability",
    description:
      "Verifies the audio channel survives a multi-turn conversation without dropping.",
    methodology:
      "Sends 5 sequential prompts simulating a natural conversation flow. Counts how many turns receive a response and whether the channel stays connected.",
    passCriteria: "All 5 turns completed with channel still connected.",
    metricLabels: {
      total_turns: "Total Turns",
      completed_turns: "Completed Turns",
      still_connected: "Still Connected",
      disconnected_mid_test: "Disconnected Mid-Test",
    },
    metricUnits: {
      total_turns: "count",
      completed_turns: "count",
      still_connected: "boolean",
      disconnected_mid_test: "boolean",
    },
  },
  response_completeness: {
    key: "response_completeness",
    label: "Response Completeness",
    description:
      "Checks that agent responses have substantive content and complete sentence structure.",
    methodology:
      "Sends a prompt requiring a detailed explanation. Transcribes the response and checks word count, sentence completeness, and STT confidence.",
    passCriteria: "Response meets minimum word count and ends with a complete sentence.",
    metricLabels: {
      response_received: "Response Received",
      transcription_length: "Characters",
      word_count: "Word Count",
      ends_with_complete_sentence: "Complete Sentence",
      has_substance: "Has Substance",
      stt_confidence: "STT Confidence",
      timed_out: "Timed Out",
    },
    metricUnits: {
      response_received: "boolean",
      transcription_length: "count",
      word_count: "count",
      ends_with_complete_sentence: "boolean",
      has_substance: "boolean",
      stt_confidence: "ratio",
      timed_out: "boolean",
    },
  },
  noise_resilience: {
    key: "noise_resilience",
    label: "Noise Resilience",
    description:
      "Measures agent robustness under 9 background noise conditions.",
    methodology:
      "Establishes a clean baseline, then runs 9 trials combining 3 noise types (white, babble, pink) with 3 SNR levels (20dB, 10dB, 5dB). Measures response rate and latency degradation.",
    passCriteria: "Agent responds to all trials at or above the configured SNR threshold.",
    metricLabels: {
      baseline_ttfb_ms: "Baseline TTFB",
      trials_total: "Total Trials",
      trials_responded: "Trials Responded",
      trials_at_threshold_responded: "At-Threshold Responded",
      trials_at_threshold_total: "At-Threshold Total",
      worst_ttfb_degradation_ms: "Worst Degradation",
      mean_ttfb_degradation_ms: "Mean Degradation",
      min_responding_snr_db: "Min Responding SNR",
    },
    metricUnits: {
      baseline_ttfb_ms: "ms",
      trials_total: "count",
      trials_responded: "count",
      trials_at_threshold_responded: "count",
      trials_at_threshold_total: "count",
      worst_ttfb_degradation_ms: "ms",
      mean_ttfb_degradation_ms: "ms",
      min_responding_snr_db: "dB",
    },
  },
  endpointing: {
    key: "endpointing",
    label: "Endpointing",
    description:
      "Verifies the agent does not prematurely respond during natural mid-sentence pauses.",
    methodology:
      "Runs 3 trials, each sending a two-part utterance with a 1.5s pause in the middle. Checks if the agent waits for the full utterance or responds prematurely. Uses majority vote (2/3).",
    passCriteria: "Agent correctly waits for the full utterance in at least 2 of 3 trials.",
    metricLabels: {
      trials_total: "Total Trials",
      trials_passed: "Trials Passed",
      premature_responses: "Premature Responses",
      pause_duration_ms: "Pause Duration",
      mean_response_time_ms: "Mean Response Time",
    },
    metricUnits: {
      trials_total: "count",
      trials_passed: "count",
      premature_responses: "count",
      pause_duration_ms: "ms",
      mean_response_time_ms: "ms",
    },
  },
  audio_quality: {
    key: "audio_quality",
    label: "Audio Quality",
    description:
      "Analyzes the agent's audio output for clipping, energy consistency, SNR, and artifacts.",
    methodology:
      "Sends a prompt requiring a detailed response. Analyzes the returned audio for clipping (samples near max amplitude), energy drops/spikes, clean start/end, and estimated signal-to-noise ratio.",
    passCriteria: "No clipping detected, consistent energy, SNR above threshold, clean audio boundaries.",
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
};

export const RED_TEAM_LABELS: Record<string, string> = {
  prompt_injection: "Prompt Injection",
  pii_extraction: "PII Extraction",
  jailbreak: "Jailbreak",
  social_engineering: "Social Engineering",
  off_topic: "Off-Topic",
  compliance_bypass: "Compliance Bypass",
};
