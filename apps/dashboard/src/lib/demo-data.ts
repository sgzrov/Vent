import type { RunDetail } from "./types";

const now = new Date();
const createdAt = new Date(now.getTime() - 120_000).toISOString();

export const DEMO_RUN: RunDetail = {
  id: "demo-run-01",
  status: "fail",
  source_type: "remote",
  bundle_hash: null,
  created_at: createdAt,
  started_at: new Date(now.getTime() - 110_000).toISOString(),
  finished_at: new Date(now.getTime() - 62_800).toISOString(),
  duration_ms: 47200,
  error_text: null,
  test_spec_json: {
    audio_tests: ["echo", "ttfb"],
    conversation_tests: [
      {
        name: "Appointment Booking",
        caller_prompt:
          "I need to book an appointment for tomorrow at 2pm for a haircut",
        max_turns: 8,
        eval: [
          "Did the agent confirm the appointment time?",
          "Did the agent collect the customer's name?",
          "Did the agent provide a confirmation number?",
        ],
      },
      {
        name: "Refund Request",
        caller_prompt:
          "I want a refund for my order #12345, the product arrived damaged",
        max_turns: 10,
        eval: [
          "Did the agent acknowledge the issue?",
          "Did the agent follow the refund policy correctly?",
          "Did the agent offer to escalate to a supervisor when appropriate?",
        ],
      },
    ],
  },
  aggregate_json: {
    audio_tests: { total: 2, passed: 1, failed: 1 },
    conversation_tests: { total: 2, passed: 1, failed: 1 },
    total_duration_ms: 47200,
  },
  is_baseline: false,
  scenarios: [
    // --- Audio test 1: Echo Detection (pass) ---
    {
      id: "demo-audio-01",
      run_id: "demo-run-01",
      name: "echo",
      status: "pass",
      test_type: "audio",
      metrics_json: {
        test_name: "echo",
        status: "pass",
        metrics: {
          echo_detected: false,
          echo_delay_ms: 12,
          loop_detected: false,
        },
        duration_ms: 3200,
      },
      trace_json: [],
      created_at: createdAt,
    },
    // --- Audio test 2: TTFB (fail) ---
    {
      id: "demo-audio-02",
      run_id: "demo-run-01",
      name: "ttfb",
      status: "fail",
      test_type: "audio",
      metrics_json: {
        test_name: "ttfb",
        status: "fail",
        metrics: {
          p95_ttfb_ms: 1820,
          mean_ttfb_ms: 1340,
          max_ttfb_ms: 2100,
        },
        duration_ms: 8500,
        error: "P95 TTFB 1820ms exceeds threshold 1500ms",
      },
      trace_json: [],
      created_at: createdAt,
    },
    // --- Conversation test 1: Appointment Booking (pass) ---
    {
      id: "demo-conv-01",
      run_id: "demo-run-01",
      name: "Appointment Booking",
      status: "pass",
      test_type: "conversation",
      metrics_json: {
        name: "Appointment Booking",
        caller_prompt:
          "I need to book an appointment for tomorrow at 2pm for a haircut",
        status: "pass",
        transcript: [
          {
            role: "agent" as const,
            text: "Hi there! Welcome to StyleCuts. How can I help you today?",
            timestamp_ms: 0,
            ttfb_ms: 480,
            audio_duration_ms: 2800,
            stt_confidence: 0.96,
          },
          {
            role: "caller" as const,
            text: "Hi, I'd like to book an appointment for tomorrow at 2pm for a haircut please.",
            timestamp_ms: 3200,
            audio_duration_ms: 3500,
            stt_confidence: 0.94,
          },
          {
            role: "agent" as const,
            text: "Of course! I'd be happy to help you book a haircut for tomorrow at 2pm. Could I get your name please?",
            timestamp_ms: 7100,
            ttfb_ms: 550,
            audio_duration_ms: 4200,
            stt_confidence: 0.97,
          },
          {
            role: "caller" as const,
            text: "Sure, it's Sarah Mitchell.",
            timestamp_ms: 11800,
            audio_duration_ms: 1600,
            stt_confidence: 0.92,
          },
          {
            role: "agent" as const,
            text: "Great, Sarah! I've booked you in for a haircut tomorrow at 2pm. Your confirmation number is SC-4821. Is there anything else I can help with?",
            timestamp_ms: 13900,
            ttfb_ms: 710,
            audio_duration_ms: 5800,
            stt_confidence: 0.98,
          },
        ],
        eval_results: [
          {
            question: "Did the agent confirm the appointment time?",
            relevant: true,
            passed: true,
            reasoning:
              "The agent confirmed 'tomorrow at 2pm' in the final response.",
          },
          {
            question: "Did the agent collect the customer's name?",
            relevant: true,
            passed: true,
            reasoning:
              "The agent asked for the name and addressed the caller as 'Sarah'.",
          },
          {
            question: "Did the agent provide a confirmation number?",
            relevant: true,
            passed: true,
            reasoning:
              "The agent provided confirmation number SC-4821.",
          },
        ],
        observed_tool_calls: [
          {
            name: "book_appointment",
            arguments: {
              customer_name: "Sarah Mitchell",
              date: "2026-02-27",
              time: "14:00",
              service: "haircut",
            },
            result: { confirmation_id: "SC-4821", status: "confirmed" },
            successful: true,
            timestamp_ms: 13400,
            latency_ms: 230,
          },
        ],
        duration_ms: 18200,
        metrics: {
          turns: 5,
          mean_ttfb_ms: 580,
          total_duration_ms: 18200,
          talk_ratio: 0.45,
          latency: {
            ttfb_per_turn_ms: [480, 550, 710],
            p50_ttfb_ms: 550,
            p90_ttfb_ms: 710,
            p95_ttfb_ms: 710,
            p99_ttfb_ms: 710,
            first_turn_ttfb_ms: 480,
            total_silence_ms: 1200,
            mean_turn_gap_ms: 240,
          },
          transcript: {
            wer: 0.08,
            repetition_score: 0.02,
            reprompt_count: 0,
            filler_word_rate: 1,
            words_per_minute: 145,
            vocabulary_diversity: 0.82,
          },
          behavioral: {
            intent_accuracy: {
              score: 0.95,
              reasoning:
                "Agent correctly identified booking intent and collected all required information.",
            },
            context_retention: {
              score: 0.92,
              reasoning:
                "Agent maintained context across all turns, referencing the time and service correctly.",
            },
            clarity_score: {
              score: 0.88,
              reasoning:
                "Clear and concise responses with appropriate pacing.",
            },
            hallucination_detected: {
              detected: false,
              reasoning: "No factual inaccuracies detected.",
            },
            safety_compliance: {
              compliant: true,
              reasoning: "Agent followed all safety protocols.",
            },
          },
          tool_calls: {
            total: 1,
            successful: 1,
            failed: 0,
            mean_latency_ms: 230,
            names: ["book_appointment"],
          },
        },
      },
      trace_json: [],
      created_at: createdAt,
    },
    // --- Conversation test 2: Refund Request (fail) ---
    {
      id: "demo-conv-02",
      run_id: "demo-run-01",
      name: "Refund Request",
      status: "fail",
      test_type: "conversation",
      metrics_json: {
        name: "Refund Request",
        caller_prompt:
          "I want a refund for my order #12345, the product arrived damaged",
        status: "fail",
        transcript: [
          {
            role: "agent" as const,
            text: "Thank you for calling customer support. How can I assist you today?",
            timestamp_ms: 0,
            ttfb_ms: 620,
            audio_duration_ms: 3100,
            stt_confidence: 0.95,
          },
          {
            role: "caller" as const,
            text: "Hi, I received my order number 12345 and the product is damaged. I'd like a refund.",
            timestamp_ms: 3600,
            audio_duration_ms: 4200,
            stt_confidence: 0.93,
          },
          {
            role: "agent" as const,
            text: "I'm sorry to hear that. Let me look up your order. Yes, I can see order 12345. I can process a full refund for you right away.",
            timestamp_ms: 8400,
            ttfb_ms: 890,
            audio_duration_ms: 5600,
            stt_confidence: 0.96,
          },
          {
            role: "caller" as const,
            text: "Okay, how long will that take?",
            timestamp_ms: 14500,
            audio_duration_ms: 1800,
            stt_confidence: 0.91,
          },
          {
            role: "agent" as const,
            text: "The refund will be processed within 3 to 5 business days and will appear on your original payment method.",
            timestamp_ms: 16800,
            ttfb_ms: 1050,
            audio_duration_ms: 4800,
            stt_confidence: 0.97,
          },
          {
            role: "caller" as const,
            text: "And can I also get a replacement sent out?",
            timestamp_ms: 22100,
            audio_duration_ms: 2200,
            stt_confidence: 0.94,
          },
          {
            role: "agent" as const,
            text: "Sure, I'll send a replacement right away. Is there anything else I can help with?",
            timestamp_ms: 24800,
            ttfb_ms: 1240,
            audio_duration_ms: 3800,
            stt_confidence: 0.95,
          },
        ],
        eval_results: [
          {
            question: "Did the agent acknowledge the issue?",
            relevant: true,
            passed: true,
            reasoning:
              "The agent said 'I'm sorry to hear that' and looked up the order.",
          },
          {
            question: "Did the agent follow the refund policy correctly?",
            relevant: true,
            passed: false,
            reasoning:
              "The agent offered both a full refund AND a replacement without explaining the policy trade-off. Per policy, customers can choose one or the other, not both.",
          },
          {
            question:
              "Did the agent offer to escalate to a supervisor when appropriate?",
            relevant: true,
            passed: true,
            reasoning:
              "Escalation was not needed in this context as the agent handled the request directly.",
          },
        ],
        duration_ms: 28600,
        metrics: {
          turns: 7,
          mean_ttfb_ms: 950,
          total_duration_ms: 28600,
          talk_ratio: 0.52,
          latency: {
            ttfb_per_turn_ms: [620, 890, 1050, 1240],
            p50_ttfb_ms: 970,
            p90_ttfb_ms: 1240,
            p95_ttfb_ms: 1240,
            p99_ttfb_ms: 1240,
            first_turn_ttfb_ms: 620,
            total_silence_ms: 2800,
            mean_turn_gap_ms: 380,
          },
          transcript: {
            wer: 0.12,
            repetition_score: 0.05,
            reprompt_count: 0,
            filler_word_rate: 3,
            words_per_minute: 132,
            vocabulary_diversity: 0.74,
          },
          behavioral: {
            intent_accuracy: {
              score: 0.78,
              reasoning:
                "Agent identified the refund request but failed to properly distinguish between refund and replacement policies.",
            },
            context_retention: {
              score: 0.85,
              reasoning:
                "Agent maintained order context but did not reference the damage issue when offering the replacement.",
            },
            clarity_score: {
              score: 0.72,
              reasoning:
                "Responses were clear but the policy explanation was incomplete.",
            },
            hallucination_detected: {
              detected: false,
              reasoning: "No factual inaccuracies in the information provided.",
            },
            safety_compliance: {
              compliant: true,
              reasoning: "No safety violations detected.",
            },
          },
        },
      },
      trace_json: [],
      created_at: createdAt,
    },
  ],
  artifacts: [],
  events: [],
};
